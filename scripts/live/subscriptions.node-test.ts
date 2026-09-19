import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./subscriptions-run.ts', import.meta.url));
const nodeArgs = ['--import', import.meta.resolve('tsx'), runner];

test('local subscription CLI lists models and reports missing login without API-key fallback or ordinary report changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subscription-cli-'));
  try {
    const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OH_PERSISTENCE_DIR: join(root, 'auth-state'), OPENAI_API_KEY: 'must-not-use-or-print' };
    const listed = await exec(process.execPath, [...nodeArgs, '--list'], { cwd: root, env });
    const config = JSON.parse(listed.stdout);
    assert.deepEqual(config.targets.map((t: { model: string }) => t.model), ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra']);
    await assert.rejects(readFile(join(root, 'auth-state/auth/openai_oauth.json')), { code: 'ENOENT' });
    let exit: unknown;
    try { await exec(process.execPath, [...nodeArgs, '--target', 'subscription-gpt-5-6-luna'], { cwd: root, env, timeout: 15_000 }); }
    catch (error) { exit = (error as { code: unknown }).code; }
    assert.equal(exit, 2);
    const raw = await readFile(join(root, 'artifacts/llm/subscriptions/summary.json'), 'utf8');
    assert.ok(!raw.includes('must-not-use-or-print'));
    const summary = JSON.parse(raw);
    assert.equal(summary.complete, true);
    assert.deepEqual(summary.selected, ['subscription-gpt-5-6-luna']);
    assert.equal(summary.results[0].status, 'unavailable');
    assert.equal(summary.results[0].reason, 'subscription-login-required');
    await assert.rejects(readFile(join(root, 'artifacts/llm/summary.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid selection and GitHub Actions refuse execution before touching credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'subscription-cli-guard-'));
  try {
    const marker = join(root, 'untouched');
    await writeFile(marker, 'sentinel');
    for (const [args, extraEnv, message] of [
      [[], {}, 'Choose --all, --target ID, or --list'],
      [['--target', 'unknown'], {}, 'Unknown subscription target'],
      [['--all', '--target', 'subscription-gpt-5-6-luna'], {}, 'Choose --all, --target ID, or --list'],
      [['--all'], { GITHUB_ACTIONS: 'true' }, 'Run subscription tests locally'],
    ] as const) {
      await assert.rejects(exec(process.execPath, [...nodeArgs, ...args], {
        cwd: root, env: { PATH: process.env.PATH, OH_PERSISTENCE_DIR: marker, ...extraEnv }, timeout: 10_000,
      }), (error: unknown) => {
        assert.ok((error as { stderr: string }).stderr.includes(message)); return true;
      });
    }
    assert.equal(await readFile(marker, 'utf8'), 'sentinel');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('subscription inventory rejects unsupported models, duplicates, credentials and unexplained disables', async () => {
  const { parseSubscriptionConfig } = await import('./subscriptions-config.js');
  const target = { id: 'subscription-test', model: 'gpt-5.6-luna', enabled: true };
  const parse = (targets: unknown[]) => parseSubscriptionConfig({ version: 1, targets });
  assert.throws(() => parse([{ ...target, model: 'not-a-subscription-model' }]));
  assert.throws(() => parse([target, target]));
  assert.throws(() => parse([{ ...target, enabled: false }]));
  assert.throws(() => parse([{ ...target, access_token: 'must-not-store' }]));
  assert.equal(parse([{ ...target, enabled: false, reason: 'Temporarily unavailable' }]).targets[0]?.enabled, false);
});

test('cancellation stops an uncooperative detached worker before its deadline', async () => {
  const { spawn } = await import('node:child_process');
  const { waitForWorker } = await import('./worker-lifecycle.js');
  const controller = new AbortController();
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const started = Date.now();
  const waiting = waitForWorker(worker, { target: 'cancel-test', model: 'fixture', route: 'chatgpt-subscription', scenario: 'conversation' }, 5_000, controller.signal);
  controller.abort();
  const result = await waiting;
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'target-cancelled');
  assert.ok(Date.now() - started < 4_000, 'cancellation must not wait for the target deadline');
});

test('SIGTERM cancels the current CLI target and leaves later targets pending', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const { mkdir, chmod, stat } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'subscription-cli-cancel-'));
  let runnerProcess: ReturnType<typeof spawn> | undefined;
  try {
    const auth = join(root, 'state/auth');
    await mkdir(auth, { recursive: true });
    await chmod(auth, 0o755);
    // A FIFO blocks credential setup without a credential or any network call.
    // SDK chmod to 0700 tells us the worker has entered its normal store read.
    await exec('mkfifo', [join(auth, 'openai_oauth.json')]);
    runnerProcess = spawn(process.execPath, [...nodeArgs, '--all'], {
      cwd: root, env: { PATH: process.env.PATH, OH_PERSISTENCE_DIR: join(root, 'state') }, stdio: 'ignore',
    });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      runnerProcess!.once('close', (code, signal) => resolve([code, signal]));
      runnerProcess!.once('error', reject);
    });
    const deadline = Date.now() + 5_000;
    while (((await stat(auth)).mode & 0o777) !== 0o700 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await stat(auth)).mode & 0o777, 0o700, 'worker entered credential setup');
    runnerProcess.kill('SIGTERM');
    const [code, signal] = await closed;
    assert.equal(code, 143);
    assert.equal(signal, null);
    const summary = JSON.parse(await readFile(join(root, 'artifacts/llm/subscriptions/summary.json'), 'utf8'));
    assert.equal(summary.complete, false);
    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0].reason, 'target-cancelled');
    assert.deepEqual(summary.pending, ['subscription-gpt-5-6-luna', 'subscription-gpt-6-astra']);
  } finally {
    runnerProcess?.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});
