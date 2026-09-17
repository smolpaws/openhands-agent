import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { waitForWorker } from './worker-lifecycle.js';

const identity = { target: 'test', model: 'test-model', route: 'native', scenario: 'examples' };
const success = { ...identity, status: 'passed', evidence: { completed: ['examples/hello-world.ts'] } };
function child(source: string) {
  return spawn(process.execPath, ['-e', source], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

test('a matching successful report requires a clean child exit', async () => {
  const passed = await waitForWorker(child(`process.send(${JSON.stringify(success)}, () => process.exit(0))`), identity, 5_000);
  assert.equal(passed.status, 'passed');
  const crashed = await waitForWorker(child(`process.send(${JSON.stringify(success)}, () => process.exit(7))`), identity, 5_000);
  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.reason, 'worker-exit-failed');
});

test('a worker cannot pass by reporting another target, an empty success, or unexpected fields', async () => {
  for (const report of [{ ...success, target: 'other' }, { ...identity, status: 'passed' }, { ...success, headers: { authorization: 'secret-never-reported' } }]) {
    const result = await waitForWorker(child(`process.send(${JSON.stringify(report)}); setInterval(() => {}, 1000)`), identity, 5_000);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'worker-invalid-report');
    assert.ok(!JSON.stringify(result).includes('secret-never-reported'));
  }
});

test('deadline failure overrides a provisional pass and terminates the child', async () => {
  const worker = child(`process.send(${JSON.stringify(success)}); setInterval(() => {}, 1000)`);
  const result = await waitForWorker(worker, identity, 100);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'target-deadline-exceeded');
  assert.notEqual(worker.signalCode, null);
});

test('clean exit without a report is incomplete, and arbitrary failure text is discarded', async () => {
  const missing = await waitForWorker(child('process.exit(0)'), identity, 5_000);
  assert.equal(missing.reason, 'worker-missing-report');
  const report = { ...identity, status: 'failed', reason: 'assertion: secret-never-reported' };
  const failed = await waitForWorker(child(`process.send(${JSON.stringify(report)}, () => process.exit(0))`), identity, 5_000);
  assert.equal(failed.reason, 'scenario-assertion-failed');
  assert.ok(!JSON.stringify(failed).includes('secret-never-reported'));
});
