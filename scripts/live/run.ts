#!/usr/bin/env tsx
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MacOSKeychainSecretStore } from '@smolpaws/openhands-agent';
import { readConfig, resultExitCode, selectTargets, type LiveTarget, type Status } from './config.js';
import { parseCondensationOption } from './condensation-options.js';
import { waitForWorker } from './worker-lifecycle.js';

export interface LiveResult {
  target: string; model: string; route: string; scenario: string; status: Status;
  reason?: string; durationMs: number; evidence?: unknown;
}

const args = process.argv.slice(2);
const allowed = new Set(['--all', '--target', '--list', '--matrix', '--keychain', '--condensation']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i]!)) throw new Error('Use --all, --target ID, --list, or --matrix; optionally --keychain.');
  if (args[i] === '--target' || args[i] === '--condensation') {
    const option = args[i]!;
    if (!args[++i] || args[i]!.startsWith('--')) {
      throw new Error(`${option} requires ${option === '--target' ? 'an ID' : 'a scenario'}`);
    }
  }
}
const condensation = parseCondensationOption(args);
const config = await readConfig();
const id = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;
const modes = [args.includes('--all'), !!id, args.includes('--list'), args.includes('--matrix')].filter(Boolean);
if (modes.length !== 1) throw new Error('Choose exactly one of --all, --target ID, --list, or --matrix.');
if (args.includes('--list')) {
  console.log(JSON.stringify(config, null, 2));
} else if (args.includes('--matrix')) {
  console.log(JSON.stringify({ include: selectTargets(config).map(t => ({ target: t.id })) }));
} else {
  const targets = selectTargets(config, id);
  const results: LiveResult[] = [];
  const out = resolve('artifacts/llm', ...(condensation ? [`condensation-${condensation}`] : []));
  await mkdir(out, { recursive: true });
  const keychain = args.includes('--keychain') ? new MacOSKeychainSecretStore() : null;
  await writeReports();
  for (const target of targets) {
    const start = Date.now();
    let result: LiveResult;
    const base = { target: target.id, model: target.profile.model, route: target.route, scenario: condensation ? `condensation-${condensation}` : target.scenario };
    if (!target.enabled) {
      result = { ...base, status: 'disabled', reason: target.reason, durationMs: 0 };
    } else {
      // Explicit route credentials only. Never infer the key from the model family,
      // route to another provider, dump keychain attributes, or persist a key.
      let key = process.env[target.credential.env]?.trim();
      let credentialError = false;
      if (!key && keychain) {
        try { key = (await keychain.get({ service: 'openhands', account: target.credential.keychainAccount })) ?? undefined; }
        catch { credentialError = true; }
      }
      if (!key) {
        result = { ...base, status: 'unavailable', reason: credentialError ? 'keychain-access-failed' : `missing-credential:${target.credential.env}`, durationMs: Date.now() - start };
      } else {
        result = await runTarget(target, key);
      }
    }
    results.push(result);
    console.log(`${result.target}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    await writeFile(resolve(out, `${target.id}.json`), JSON.stringify(result, null, 2) + '\n');
    await writeReports();
  }
  process.exitCode = resultExitCode(results);

  async function writeReports() {
    const disabled = config.targets.filter(t => !t.enabled).map(t => ({ target: t.id, model: t.profile.model, route: t.route, reason: t.reason }));
    const pending = targets.filter(t => !results.some(r => r.target === t.id)).map(t => t.id);
    await writeFile(resolve(out, 'summary.json'), JSON.stringify({ version: 1, created: new Date().toISOString(), revision: process.env.LLM_TEST_REVISION ?? null, complete: pending.length === 0, selected: targets.map(t => t.id), pending, results, disabled }, null, 2) + '\n');
    const rows = results.map(r => `| ${r.target} | ${r.status} | ${r.reason ?? 'All scenario assertions passed'} |`);
    await writeFile(resolve(out, 'summary.md'), [
      '# Live LLM regression results', '',
      `Revision: ${process.env.LLM_TEST_REVISION ?? 'local checkout'}`, '',
      pending.length ? `**Run incomplete:** ${pending.length} selected targets have no result yet: ${pending.join(', ')}.` : 'All selected targets have reported a result.', '',
      'Unavailable targets are incomplete coverage, never passing tests. Disabled routes are listed below.', '',
      '| Target | Result | Detail |', '| --- | --- | --- |', ...rows, '',
      '| Disabled target | Reason |', '| --- | --- |', ...disabled.map(t => `| ${t.target} | ${t.reason} |`), '',
    ].join('\n'));
  }
}

function runTarget(target: LiveTarget, key: string): Promise<LiveResult> {
  const base = { target: target.id, model: target.profile.model, route: target.route, scenario: condensation ? `condensation-${condensation}` : target.scenario };
  // Only this target's key enters the child; output from providers and legacy
  // examples is discarded. Reports travel over IPC as safe metadata only.
  const worker = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [target.id, ...(condensation ? ['--condensation', condensation] : [])], {
    execArgv: ['--import', 'tsx'], detached: process.platform !== 'win32',
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, [target.credential.env]: key },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return waitForWorker(worker, base, target.scenario === 'examples' ? 600_000 : 240_000);
}
