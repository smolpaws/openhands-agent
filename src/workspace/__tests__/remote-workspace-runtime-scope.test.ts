import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteWorkspace } from '../index.js';

const SCOPED_ID = '00000000-0000-0000-0000-000000000001';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

describe('RemoteWorkspace runtime scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scopes file, command, and git operations under the conversation runtime', async () => {
    const calls = installFetch((url) => {
      const path = url.pathname;
      if (path.endsWith('start_bash_command')) return json(200, { id: 'command-one' });
      if (path.endsWith('bash_events/search')) return json(200, { items: [] });
      if (path.endsWith('file/upload')) return json(200, { success: true, file_size: 12 });
      if (path.endsWith('git/changes')) return json(200, []);
      if (path.endsWith('git/diff')) return json(200, { original: 'before', modified: 'after' });
      if (path.endsWith('runtime/credentials')) return json(200, { session_api_key: 'worker-key' });
      if (path.endsWith('/runtime')) return json(404, { detail: 'gone' });
      throw new Error(`unexpected path: ${path}`);
    });

    const ws = new RemoteWorkspace({
      host: 'http://test',
      apiKey: 'test-scope-key',
      workingDir: '/workspace',
      runtimeConversationId: SCOPED_ID,
    });

    const id = await ws.startCommand('echo done');
    expect(id).toBe('command-one');
    expect(await ws.getCommandOutput(id)).toBeNull();
    expect(await ws.getRuntimeSessionKey()).toBe('worker-key');
    await ws.releaseRuntime();
    await ws.fileUpload(new Uint8Array([1, 2, 3]), '/workspace/bundle.tgz');
    await ws.gitChanges('repo');
    await ws.gitDiff('repo/file.txt');

    const prefix = `/api/conversations/${SCOPED_ID}`;
    for (const call of calls) {
      expect(call.headers['x-session-api-key']).toBe('test-scope-key');
      expect(new URL(call.url).pathname.startsWith(prefix)).toBe(true);
    }
  });

  it('uses the host /api prefix when there is no conversation scope', async () => {
    const calls = installFetch((url) => {
      const path = url.pathname;
      if (path.endsWith('start_bash_command')) return json(200, { id: 'command-one' });
      if (path.endsWith('bash_events/search')) return json(200, { items: [{ kind: 'BashOutput', order: 1, exit_code: 0, stdout: 'done', stderr: '' }] });
      throw new Error(`unexpected path: ${path}`);
    });

    const ws = new RemoteWorkspace({ host: 'http://test', workingDir: '/workspace' });

    const result = await ws.executeCommand('echo done', { timeoutSeconds: 1 });
    expect(result.exitCode).toBe(0);

    for (const call of calls) {
      expect(new URL(call.url).pathname.startsWith('/api/')).toBe(true);
    }
  });

  it('rejects runtime lifecycle operations without a conversation scope', async () => {
    installFetch(() => {
      throw new Error('no request expected');
    });
    const ws = new RemoteWorkspace({ host: 'http://test', workingDir: '/workspace' });

    await expect(ws.getRuntimeSessionKey()).rejects.toThrow(/conversation scope/u);
    await expect(ws.releaseRuntime()).rejects.toThrow(/conversation scope/u);
  });

  it('rejects a missing or empty runtime credential', async () => {
    installFetch(() => json(200, {}));
    const ws = new RemoteWorkspace({ host: 'http://test', workingDir: '/workspace', runtimeConversationId: SCOPED_ID });

    await expect(ws.getRuntimeSessionKey()).rejects.toThrow(/empty session credential/u);
  });

  it('returns the latest command output item', async () => {
    const item = { kind: 'BashOutput', id: 'output-one', order: 1, exit_code: 0, stdout: 'done', stderr: '' };
    installFetch((url) => {
      if (url.pathname.endsWith('bash_events/search')) return json(200, { items: [item] });
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const ws = new RemoteWorkspace({ host: 'http://test', workingDir: '/workspace', runtimeConversationId: SCOPED_ID });

    expect(await ws.getCommandOutput('command-one')).toEqual(item);
  });

  it('uploads in-memory bytes with an upload filename', async () => {
    const calls = installFetch((url) => {
      if (url.pathname.endsWith('file/upload')) return json(200, { success: true, file_size: 12 });
      throw new Error(`unexpected path: ${url.pathname}`);
    });
    const ws = new RemoteWorkspace({ host: 'http://test', workingDir: '/workspace' });

    const result = await ws.fileUpload(new Uint8Array([98, 117, 110, 100, 108, 101]), '/workspace/bundle.tgz');

    expect(result).toMatchObject({ success: true, fileSize: 12 });
    const upload = calls.find((call) => call.url.includes('file/upload'));
    expect(upload).toBeDefined();
  });
});

function installFetch(handler: (url: URL, method: string, init?: RequestInit) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init?.headers)) {
        for (const [key, value] of init.headers) headers[key] = value;
      } else if (init?.headers !== undefined) {
        Object.assign(headers, init.headers);
      }
      calls.push({ url: url.toString(), method, headers, body: typeof init?.body === 'string' ? init.body : null });
      return handler(url, method, init);
    },
  );
  return calls;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
