import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { llmProfileSchema } from '@smolpaws/openhands-agent';
import { buildExampleLlmProfile } from '../../examples/_shared/exampleProfile.js';

test('the suite profile overrides example defaults without losing explicit null settings', () => {
  const profile = { profileId: 'configured', providerId: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1', openAiApiMode: 'responses', reasoningEffort: null, maxOutputTokens: 4096 };
  assert.deepEqual(buildExampleLlmProfile({ LLM_TEST_PROFILE: JSON.stringify(profile), OPENAI_MODEL: 'ignored-old-model' }), llmProfileSchema.parse(profile));
});

test('the suite profile rejects malformed JSON, secret fields, and invalid profile controls', () => {
  for (const value of ['not-json', 'null', '[]', JSON.stringify({ apiKey: 'synthetic-secret' }), JSON.stringify({ reasoningEffort: 'typo' })]) {
    assert.throws(() => buildExampleLlmProfile({ LLM_TEST_PROFILE: value }));
  }
});

test('direct example invocations retain their documented provider and model defaults', () => {
  assert.equal(buildExampleLlmProfile({}).model, 'gpt-5-nano');
  const profile = buildExampleLlmProfile({ LLM_PROVIDER_ID: 'anthropic', LLM_MODEL: 'claude-opus-5' });
  assert.equal(profile.providerId, 'anthropic');
  assert.equal(profile.model, 'claude-opus-5');
});

test('actual legacy constructors send the selected API mode, reasoning, and token limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-profile-'));
  try {
    const mock = join(dir, 'capture.mjs');
    await writeFile(mock, `globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      process.send({ path: new URL(url).pathname, model: body.model,
        maxOutputTokens: body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? body.generation_config?.max_output_tokens ?? null,
        reasoningEffort: body.reasoning?.effort ?? body.reasoning_effort ?? body.generation_config?.thinking_level ?? null });
      throw new Error('intentional-offline-stop');
    };`);
    const scenarios = [
      { file: 'examples/hello-world.ts', providerId: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1', openAiApiMode: 'responses', reasoningEffort: 'high', maxOutputTokens: 321, path: '/v1/responses' },
      { file: 'scripts/live/openai-responses-reasoning.ts', providerId: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1', openAiApiMode: 'responses', reasoningEffort: 'low', maxOutputTokens: 654, path: '/v1/responses' },
      { file: 'examples/native-openai-tools.ts', providerId: 'openai', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1', openAiApiMode: 'responses', reasoningEffort: 'high', maxOutputTokens: 543, path: '/v1/responses' },
      { file: 'examples/native-gemini-tools.ts', providerId: 'gemini', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', openAiApiMode: 'chat_completions', reasoningEffort: null, maxOutputTokens: 765, path: '/v1beta/interactions' },
      { file: 'scripts/live/deepseek-flash.ts', providerId: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', openAiApiMode: 'chat_completions', reasoningEffort: null, maxOutputTokens: 987, path: '/chat/completions' },
      { file: 'scripts/live/anthropic-cache-smoke.ts', providerId: 'litellm_proxy', model: 'anthropic/claude-haiku-4-5-20251001', baseUrl: 'https://llm-proxy.eval.all-hands.dev/v1', openAiApiMode: 'chat_completions', reasoningEffort: null, maxOutputTokens: 432, path: '/v1/chat/completions' },
    ];
    for (const { file, path, ...profile } of scenarios) {
      const messages: unknown[] = [];
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--import', mock, file, '--out-dir', dir], {
          env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LLM_PROVIDER_ID: profile.providerId, LLM_MODEL: profile.model, LLM_BASE_URL: profile.baseUrl,
            [`${profile.providerId.toUpperCase()}_API_KEY`]: 'synthetic-offline-key', LLM_TEST_PROFILE: JSON.stringify({ profileId: 'offline-profile', ...profile }) },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.on('message', value => messages.push(value));
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(code, 1, `${file} must stop at the mocked request`);
      assert.deepEqual(messages, [{ path, model: profile.model, maxOutputTokens: profile.maxOutputTokens, reasoningEffort: profile.reasoningEffort }], file);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the actual cache worker preserves an omitted TTL and an explicit one-hour TTL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-cache-ttl-'));
  try {
    const mock = join(dir, 'cache-fetch.mjs');
    await writeFile(mock, `import assert from 'node:assert/strict';
      import { llmProfileSchema } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/index.mjs')).href)};
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        const selected = JSON.parse(process.env.LLM_TEST_PROFILE);
        const explicit = Object.hasOwn(selected, 'anthropicCacheTtl');
        assert.equal(Object.hasOwn(process.env, 'ANTHROPIC_CACHE_TTL'), explicit, 'worker must not invent a TTL environment override');
        assert.equal(Object.hasOwn(llmProfileSchema.parse(selected), 'anthropicCacheTtl'), explicit, 'normalized profile must preserve TTL omission');
        const markers = [];
        const inspect = value => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (key === 'cache_control') markers.push(child); else inspect(child); } };
        inspect(JSON.parse(init.body));
        assert.ok(markers.length > 0);
        for (const marker of markers) assert.deepEqual(marker, explicit ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });
        const index = calls++;
        assert.ok(index < 3);
        const writes = index === 0 ? 4096 : 0;
        return new Response(JSON.stringify({ id: 'cache-response-' + index, model: selected.model,
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'cache-finish-' + index, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ message: ['CACHE-FIRST-OK', 'CACHE-SECOND-OK', 'CACHE-RESTORED-OK'][index] }) } }] } }],
          usage: { prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010, prompt_tokens_details: {
            cached_tokens: index === 0 ? 0 : 4096, cache_creation_tokens: writes,
            cache_creation_token_details: { ephemeral_1h_input_tokens: explicit ? writes : 0 } } } }), { status: 200 });
      };`);
    const preload = join(dir, 'worker-preload.mjs');
    await writeFile(preload, `import fs from 'node:fs/promises';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const read = fs.readFile;
      fs.readFile = async (path, ...args) => {
        const result = await read(path, ...args);
        if (!String(path).endsWith('/scripts/live/models.json')) return result;
        const config = JSON.parse(String(result));
        const target = config.targets.find(target => target.id === 'regression-anthropic-cache');
        if (process.env.WORKER_TEST_TTL === 'omitted') delete target.profile.anthropicCacheTtl;
        else target.profile.anthropicCacheTtl = '1h';
        return JSON.stringify(config);
      };
      const spawn = childProcess.spawn;
      childProcess.spawn = (command, args, options) => spawn(command, ['--import', ${JSON.stringify(mock)}, ...args], options);
      globalThis.fetch = async () => { throw new Error('unexpected parent fetch'); };
      syncBuiltinESMExports();`);
    for (const ttl of ['omitted', '1h']) {
      const messages: unknown[] = [];
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, 'scripts/live/worker.ts', 'regression-anthropic-cache'], {
          env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENHANDS_API_KEY_EVAL: 'synthetic-offline-key', WORKER_TEST_TTL: ttl },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.on('message', value => messages.push(value));
        child.on('error', reject);
        child.on('close', resolve);
      });
      assert.equal(code, 0);
      assert.equal(messages.length, 1);
      assert.equal((messages[0] as { status?: string }).status, 'passed', `${ttl}: ${JSON.stringify(messages)}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
