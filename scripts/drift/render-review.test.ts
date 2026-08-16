import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('render-review', () => {
  it('renders sorted review units, dispositions, hints, and changed paths', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'drift-review-'));
    temporaryDirectories.push(directory);
    const review = resolve(directory, 'review.json');
    const output = resolve(directory, 'review.md');

    await writeFile(review, JSON.stringify({
      from: '1'.repeat(40),
      to: '2'.repeat(40),
      items: {
        'bbbb:server': {
          target: 'server',
          commit: { subject: 'Second change' },
          files: [{ path: 'openhands-agent-server/example.py' }],
          policyHints: ['DEV-SERVER-005'],
        },
        'aaaa:sdk': {
          target: 'sdk',
          commit: { subject: 'First change' },
          disposition: 'EXCLUDED',
          policy: 'EXC-SDK-001',
          reason: 'Plugin runtime is excluded.',
          files: [{ path: 'openhands-sdk/openhands/sdk/plugin/example.py' }],
        },
      },
    }));

    await execFileAsync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['tsx', 'scripts/drift/render-review.ts', '--review', review, '--output', output],
      {
        cwd: resolve(import.meta.dirname, '../..'),
        encoding: 'utf8',
      },
    );

    const markdown = await readFile(output, 'utf8');
    expect(markdown).toContain('`EXCLUDED`');
    expect(markdown).toContain('`EXC-SDK-001`');
    expect(markdown).toContain('`DEV-SERVER-005`');
    expect(markdown).toContain('`openhands-sdk/openhands/sdk/plugin/example.py`');
    expect(markdown.indexOf('`aaaa:sdk`')).toBeLessThan(markdown.indexOf('`bbbb:server`'));
  });
});
