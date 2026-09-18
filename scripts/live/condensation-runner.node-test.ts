import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { waitForWorker } from './worker-lifecycle.js';

const exec = promisify(execFile);
const identity = { target: 'test', model: 'fixture', route: 'native', scenario: 'condensation-forced' };
const evidence = { profileId: 'test', requestedModel: 'fixture', scenario: 'forced', requests: 9, reactiveRequests: 0,
  summaryCompletions: 2, condensations: 2, eventsForgotten: 5, continuations: 7, executedTools: 3, thinkingActions: 0,
  checks: ['actual-condensation', 'restored-summary-and-accounting'] };
function child(report: unknown) {
  return spawn(process.execPath, ['-e', `process.send(${JSON.stringify(report)}, () => process.exit(0))`], {
    detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

test('condensation reports accept only bounded evidence and preserve unavailable prerequisites', async () => {
  const result = await waitForWorker(child({ ...identity, status: 'passed', evidence }), identity, 5_000);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.evidence, evidence);
  const rejected = await waitForWorker(child({ ...identity, status: 'passed', evidence: { ...evidence, raw: 'must-not-leak' } }), identity, 5_000);
  assert.equal(rejected.reason, 'worker-invalid-report');
  assert.ok(!JSON.stringify(rejected).includes('must-not-leak'));
  const unavailable = await waitForWorker(child({ ...identity, status: 'unavailable', reason: 'condensation-thinking-unavailable' }), identity, 5_000);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.reason, 'condensation-thinking-unavailable');
});

test('explicit CLI scenario reports missing credentials as incomplete without changing ordinary reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'condensation-runner-'));
  try {
    let exit: unknown;
    try {
      await exec(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./run.ts', import.meta.url)),
        '--target', 'native-deepseek-v4-pro', '--condensation', 'forced'], {
        cwd: directory, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, timeout: 10_000,
      });
    } catch (error) { exit = (error as { code?: unknown }).code; }
    assert.equal(exit, 2);
    const summary = JSON.parse(await readFile(join(directory, 'artifacts/llm/condensation-forced/summary.json'), 'utf8'));
    assert.equal(summary.complete, true);
    assert.deepEqual(summary.selected, ['native-deepseek-v4-pro']);
    assert.equal(summary.results[0].scenario, 'condensation-forced');
    assert.equal(summary.results[0].status, 'unavailable');
    assert.equal(summary.results[0].reason, 'missing-credential:DEEPSEEK_API_KEY');
    await assert.rejects(readFile(join(directory, 'artifacts/llm/summary.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [args, message] of [
  [['--target'], '--target requires an ID'],
  [['--target', 'native-deepseek-v4-pro', '--condensation'], '--condensation requires a scenario'],
] as const) {
  test(`CLI missing-value error identifies ${args.at(-1)}`, async () => {
    await assert.rejects(exec(process.execPath, ['--import', import.meta.resolve('tsx'),
      fileURLToPath(new URL('./run.ts', import.meta.url)), ...args], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, timeout: 10_000,
    }), (error: unknown) => {
      assert.ok((error as { stderr: string }).stderr.includes(message));
      return true;
    });
  });
}
