import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RemoteWorkspace, workspace } from '../index.js';

const AGENT_SERVER_BIN = process.env.OPENHANDS_AGENT_SERVER_BIN ?? resolve(process.cwd(), '../agent-sdk/.venv/bin/agent-server');
const AGENT_SERVER_PYTHON = join(dirname(AGENT_SERVER_BIN), 'python');
const hasAgentServer = existsSync(AGENT_SERVER_PYTHON) && existsSync(resolve(process.cwd(), '../agent-sdk'));
const describeWithAgentServer = hasAgentServer ? describe : describe.skip;

describeWithAgentServer('RemoteWorkspace integration', () => {
  let server: StartedAgentServer;

  beforeAll(async () => {
    server = await startAgentServer();
  }, 45_000);

  afterAll(async () => {
    await server?.stop();
  });

  it('executes commands, transfers files, and reads git state through a real agent-server', async () => {
    const ws = new RemoteWorkspace({ host: server.host, apiKey: server.apiKey, workingDir: server.workspaceDir });
    expect(workspace({ host: server.host, apiKey: server.apiKey, workingDir: server.workspaceDir })).toBeInstanceOf(RemoteWorkspace);
    expect(await ws.alive()).toBe(true);

    const command = await ws.executeCommand('printf "hello remote\\n" > hello.txt && cat hello.txt', { timeoutSeconds: 10 });
    expect(command).toMatchObject({ exitCode: 0, stdout: 'hello remote\n', timeoutOccurred: false });

    const localSource = join(server.rootDir, 'local-source.txt');
    const localDownload = join(server.rootDir, 'downloads', 'downloaded.txt');
    await writeFile(localSource, 'uploaded payload');

    expect(await ws.fileUpload(localSource, 'uploaded.txt')).toMatchObject({ success: true });
    expect(await ws.fileDownload('uploaded.txt', localDownload)).toMatchObject({ success: true, fileSize: 16 });
    expect(await readFile(localDownload, 'utf8')).toBe('uploaded payload');

    const gitSetup = await ws.executeCommand([
      'git init',
      'git config user.name Tester',
      'git config user.email tester@example.com',
      'printf old > tracked.txt',
      'git add hello.txt uploaded.txt tracked.txt',
      'git commit -m initial',
      'printf new > tracked.txt',
      'printf untracked > new.txt',
    ].join(' && '), { timeoutSeconds: 20 });
    expect(gitSetup.exitCode).toBe(0);

    expect(await ws.gitChanges('.')).toEqual([
      { status: 'ADDED', path: 'new.txt' },
      { status: 'UPDATED', path: 'tracked.txt' },
    ]);
    expect(await ws.gitDiff('tracked.txt')).toEqual({ original: 'old', modified: 'new' });
  }, 45_000);
});

interface StartedAgentServer {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly host: string;
  readonly apiKey: string;
  stop(): Promise<void>;
}

async function startAgentServer(): Promise<StartedAgentServer> {
  const port = await getOpenPort();
  const rootDir = await mkdtemp(join(tmpdir(), 'openhands-agent-server-'));
  const workspaceDir = join(rootDir, 'project');
  const apiKey = 'remote-workspace-test-key';
  await mkdir(workspaceDir, { recursive: true });
  const logPath = join(rootDir, 'server.log');
  const output = await writeCapture(logPath);
  const env = withoutTmuxEnv(process.env);
  Object.assign(env, {
    OPENHANDS_SUPPRESS_BANNER: '1',
    TMUX_TMPDIR: join(rootDir, 'tmux'),
    OH_WORKSPACE_PATH: workspaceDir,
    OH_CONVERSATIONS_PATH: join(rootDir, 'conversations'),
    OH_SESSION_API_KEYS_0: apiKey,
    OH_BASH_EVENTS_DIR: join(rootDir, 'bash_events'),
    OH_ENABLE_VSCODE: '0',
    OH_ENABLE_VNC: '0',
    OH_PRELOAD_TOOLS: '0',
  });

  const child = spawn(AGENT_SERVER_PYTHON, ['-c', agentServerScript(), '127.0.0.1', String(port)], {
    cwd: resolve(process.cwd(), '../agent-sdk'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });

  const host = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(host, child, logPath);
  } catch (error) {
    await stopProcess(child);
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }

  return {
    rootDir,
    workspaceDir,
    host,
    apiKey,
    async stop() {
      await stopProcess(child);
      output.end();
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function writeCapture(path: string) {
  const { createWriteStream } = await import('node:fs');
  return createWriteStream(path);
}

async function waitForHealth(host: string, child: ChildProcessWithoutNullStreams, logPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  while (Date.now() < deadline) {
    if (exit !== null) {
      const log = await readFile(logPath, 'utf8').catch(() => '');
      throw new Error(`agent-server exited early: ${JSON.stringify(exit)}\n${log}`);
    }
    try {
      const response = await fetch(`${host}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 250));
  }
  const log = await readFile(logPath, 'utf8').catch(() => '');
  throw new Error(`agent-server did not become healthy\n${log}`);
}

function agentServerScript(): string {
  return `
import sys
from uvicorn import Config
import openhands.agent_server.api as api_module
from openhands.agent_server.__main__ import LoggingServer
from openhands.agent_server.logging_config import LOGGING_CONFIG

api_module._cleanup_stale_tmux_sessions = lambda: None
host = sys.argv[1]
port = int(sys.argv[2])
config = Config(api_module.api, host=host, port=port, log_config=LOGGING_CONFIG, ws="wsproto")
LoggingServer(config).run()
`;
}


async function getOpenPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) {
          resolvePort(address.port);
        } else {
          reject(new Error('failed to allocate test port'));
        }
      });
    });
    server.on('error', reject);
  });
}

function withoutTmuxEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('TMUX')) {
      env[key] = value;
    }
  }
  return env;
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    new Promise<boolean>((resolveStop) => child.once('exit', () => resolveStop(true))),
    new Promise<boolean>((resolveStop) => setTimeout(() => resolveStop(false), 3_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}
