#!/usr/bin/env tsx
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultExitCode } from './config.js';
import type { LiveResult } from './run.js';
import { readSubscriptionConfig, subscriptionIdentity } from './subscriptions-config.js';
import { waitForWorker } from './worker-lifecycle.js';

async function main() {
  const args = process.argv.slice(2);
  const list = args.length === 1 && args[0] === '--list';
  const all = args.length === 1 && args[0] === '--all';
  const id = args.length === 2 && args[0] === '--target' ? args[1] : undefined;
  if (!list && !all && !id) {
    console.error('Choose --all, --target ID, or --list.'); process.exitCode = 2; return;
  }
  const config = await readSubscriptionConfig();
  if (list) { console.log(JSON.stringify(config, null, 2)); return; }
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error('Run subscription tests locally with the existing OpenHands login.'); process.exitCode = 2; return;
  }
  const targets = id ? config.targets.filter(t => t.id === id) : config.targets.filter(t => t.enabled);
  if (id && targets.length === 0) {
    console.error('Unknown subscription target; use --list.'); process.exitCode = 2; return;
  }
  const out = resolve('artifacts/llm/subscriptions');
  await mkdir(out, { recursive: true });
  const results: LiveResult[] = [];
  const disabled = config.targets.filter(t => !t.enabled);
  const writeReports = async () => {
    const pending = targets.filter(t => !results.some(r => r.target === t.id)).map(t => t.id);
    await writeFile(resolve(out, 'summary.json'), JSON.stringify({ version: 1, localOnly: true, created: new Date().toISOString(),
      complete: pending.length === 0, selected: targets.map(t => t.id), pending, disabled, results }, null, 2) + '\n');
    await writeFile(resolve(out, 'summary.md'), [
      '# Local ChatGPT subscription regressions', '',
      'Uses the existing OpenHands OAuth login. Not run by GitHub Actions.', '',
      pending.length ? `Pending: ${pending.join(', ')}.` : 'All selected targets reported.', '',
      'Unavailable and disabled targets are not passing coverage.', '',
      '| Target | Result | Detail |', '| --- | --- | --- |',
      ...results.map(r => `| ${r.target} | ${r.status} | ${r.reason ?? 'All conversation assertions passed'} |`),
      ...disabled.filter(t => !results.some(r => r.target === t.id)).map(t => `| ${t.id} | disabled | ${t.reason} |`), '',
    ].join('\n'));
  };
  const controller = new AbortController();
  let interrupted: number | undefined;
  const interrupt = () => { interrupted ??= 130; controller.abort(); };
  const terminate = () => { interrupted ??= 143; controller.abort(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    await writeReports();
    // Sequential workers share the SDK's persistent OAuth store; no credential copies.
    for (const target of targets) {
      if (controller.signal.aborted) break;
      const base = subscriptionIdentity(target);
      let result: LiveResult;
      if (!target.enabled) result = { ...base, status: 'disabled', reason: target.reason, durationMs: 0 };
      else {
        const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'OH_PERSISTENCE_DIR']
          .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
        const worker = fork(fileURLToPath(new URL('./subscriptions-worker.ts', import.meta.url)), [target.id], {
          execArgv: ['--import', import.meta.resolve('tsx')], env, detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        result = await waitForWorker(worker, base, 240_000, controller.signal);
      }
      results.push(result);
      console.log(`${result.target}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
      await writeFile(resolve(out, `${target.id}.json`), JSON.stringify(result, null, 2) + '\n');
      await writeReports();
    }
    process.exitCode = interrupted ?? resultExitCode(results);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
await main().catch(() => {
  console.error('Subscription runner setup failed; check configuration, build and output directory.');
  process.exitCode = 1;
});
