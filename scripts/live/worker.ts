import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore, llmProfileSchema, llmProviderSecretRef } from '@smolpaws/openhands-agent';
import { readConfig, selectTargets, type LiveTarget } from './config.js';

const target = selectTargets(await readConfig(), process.argv[2])[0]!;
const base = { target: target.id, model: target.profile.model, route: target.route, scenario: target.scenario };
try {
  const key = process.env[target.credential.env];
  if (!key) throw new Error('missing-credential');
  let evidence: unknown;
  if (target.scenario === 'conversation') {
    const { runConversationRegression } = await import('./conversation-regression.js');
    evidence = await runConversationRegression({
      profile: llmProfileSchema.parse({ profileId: target.id, maxOutputTokens: 4096, ...target.profile }),
      store: new InMemorySecretStore([[llmProviderSecretRef(target.profile.providerId), key]]),
      repoRoot: process.cwd(), signal: AbortSignal.timeout(220_000), maxRequests: 18,
    });
  } else {
    evidence = await runExisting(target, key);
  }
  report({ ...base, status: 'passed', evidence });
} catch (error) {
  // Deliberately don't serialize Error objects, API response bodies, assertions'
  // actual/expected values, stacks, request content, or legacy-script output.
  const message = error instanceof Error ? error.message : '';
  const http = /HTTP\s+(\d{3})/u.exec(message)?.[1];
  const providerCategory = /unavailable:(insufficient-credit|exhausted-quota|model-unavailable)/u.exec(message)?.[1];
  const unavailable = providerCategory || (http && ['401', '403', '404', '429', '500', '502', '503', '504'].includes(http));
  const name = error instanceof Error ? error.name : '';
  const phase = error instanceof Error && 'regressionPhase' in error && typeof error.regressionPhase === 'string'
    && ['setup', 'read', 'edit', 'parallel', 'restore', 'plain'].includes(error.regressionPhase) ? error.regressionPhase : undefined;
  const reason = providerCategory ? `provider-${providerCategory}` : http ? `provider-http-${http}`
    : phase ? `conversation-${phase}`
    : name === 'AssertionError' ? `assertion:${message.split('\n')[0]!.replace(/[^a-zA-Z0-9 .,;:()_/-]/gu, '').slice(0, 180)}`
    : ['AbortError', 'TimeoutError'].includes(name) ? 'request-deadline-exceeded'
    : /^legacy-script-failed:[a-z0-9.-]+$/u.test(message) ? message
    : message === 'fetch failed' ? 'provider-network-unavailable'
    : 'scenario-error';
  report({ ...base, status: unavailable || message === 'fetch failed' ? 'unavailable' : 'failed', reason });
}

function report(result: unknown): void {
  if (process.send) process.send(result, () => process.exit(0));
  else { console.log(JSON.stringify(result)); process.exit(0); }
}

async function runExisting(target: LiveTarget, key: string): Promise<unknown> {
  const scratch = await mkdtemp(join(tmpdir(), 'llm-legacy-'));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    [`${target.profile.providerId.replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()}_API_KEY`]: key,
    LLM_PROVIDER_ID: target.profile.providerId, LLM_MODEL: target.profile.model,
    LLM_BASE_URL: target.profile.baseUrl ?? '',
    LLM_TEST_PROFILE: JSON.stringify({ profileId: target.id, ...target.profile }),
    DEEPSEEK_MODEL: target.profile.model, OPENAI_RESPONSES_MODEL: target.profile.model,
    OPENAI_RESPONSES_MAX_OUTPUT_TOKENS: String(target.profile.maxOutputTokens ?? 4096),
    OPENAI_TOOL_MODEL: target.profile.model, GEMINI_TOOL_MODEL: target.profile.model,
    ...(target.profile.anthropicCacheTtl === undefined ? {} : { ANTHROPIC_CACHE_TTL: target.profile.anthropicCacheTtl }),
  };
  const completed: string[] = [];
  const run = async (file: string, args: string[] = []) => {
    await new Promise<void>((resolveRun, reject) => {
      let providerError: string | undefined;
      // Run each node:test file directly: it still sets a failing exit status,
      // while keeping the transport's IPC report in this child process.
      const child = spawn(process.execPath, ['--import', 'tsx', '--import', './scripts/live/legacy-transport.ts', file, ...args], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', value => {
        if (value && typeof value === 'object' && 'providerFailure' in value && typeof value.providerFailure === 'string'
          && /^(Live conversation provider returned HTTP \d{3}( unavailable:(insufficient-credit|exhausted-quota|model-unavailable))?|fetch failed|request-deadline-exceeded|transport-failed)$/u.test(value.providerFailure)) {
          providerError = value.providerFailure;
        }
      });
      child.on('error', () => reject(new Error(`legacy-script-failed:${file.split('/').at(-1)}`)));
      child.on('close', code => {
        if (code === 0 && providerError === undefined) { resolveRun(); return; }
        const error = new Error(providerError ?? `legacy-script-failed:${file.split('/').at(-1)}`);
        if (providerError === 'request-deadline-exceeded') error.name = 'TimeoutError';
        reject(error);
      });
    });
    completed.push(file);
  };
  try {
    if (target.scenario === 'deepseek-accounting') await run('scripts/live/deepseek-flash.ts');
    else if (target.scenario === 'anthropic-cache') await run('scripts/live/anthropic-cache-smoke.ts');
    else if (target.scenario === 'responses-reasoning') await run('scripts/live/openai-responses-reasoning.ts', ['both', '--strict', '--out-dir', scratch]);
    else if (target.scenario === 'native-openai-tools') await run('examples/native-openai-tools.ts');
    else if (target.scenario === 'native-gemini-tools') await run('examples/native-gemini-tools.ts');
    else if (target.scenario === 'examples') {
      const excluded = ['native-openai-tools.ts', 'native-gemini-tools.ts', 'remote-workspace.ts'];
      for (const file of (await readdir('examples')).sort()) {
        if (file.endsWith('.ts') && !excluded.includes(file)) await run(`examples/${file}`);
      }
    }
    return { completed, ...(target.scenario === 'examples' ? { excluded: { 'remote-workspace.ts': 'Requires a separately provisioned agent-server; not an LLM conversation test', 'native-openai-tools.ts': 'Separate native-openai-tools target', 'native-gemini-tools.ts': 'Separate native-gemini-tools target' } } : {}) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
