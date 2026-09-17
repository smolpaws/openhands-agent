import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
