import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('legacy examples and node:test scripts report safe provider failures through IPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-transport-'));
  try {
    const mock = join(dir, 'mock.mjs');
    await writeFile(mock, `globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'private-test-value' } }), { status: 400 });`);
    for (const nodeTest of [false, true]) {
      const script = join(dir, 'script.mjs');
      await writeFile(script, nodeTest ? `import test from 'node:test'; test('live', async () => { await fetch('https://unused.invalid'); });` : `await fetch('https://unused.invalid');`);
      const messages: unknown[] = [];
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--import', mock, '--import', './scripts/live/legacy-transport.ts', script], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.on('message', value => messages.push(value));
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(code, 1);
      assert.deepEqual(messages, [{ providerFailure: 'Live conversation provider returned HTTP 400 unavailable:exhausted-quota' }]);
      assert.ok(!JSON.stringify(messages).includes('private-test-value'));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
