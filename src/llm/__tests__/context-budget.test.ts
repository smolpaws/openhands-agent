import manifest from '../../../transpile/upstream.json';
import golden from './fixtures/context-token-counts.json';
// PORT: llm.get_token_count, effective_max_input_tokens and runtime metadata contracts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';
import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import { messageSchema, llmProfileSchema } from '../index.js';
import { ToolDefinition } from '../../tool/index.js';
import { LLMContextBudget } from '../context-budget.js';

const profile = (providerId = 'openai', model = 'gpt-4o') => llmProfileSchema.parse({ profileId: 'budget', providerId, model });
const text = (role: 'system' | 'user', content: string) => messageSchema.parse({ role, content });
const tool = new ToolDefinition({ name: 'lookup', description: 'Look up a file by its path', inputSchema: z.object({ path: z.string() }), executor: () => '' });
const result = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) });
afterEach(() => vi.useRealTimers());

describe('local input token estimates', () => {
  it('keeps the Python oracle bound to the canonical SDK pin', () => { expect(golden.upstreamCommit).toBe(manifest.commit); });
  it.each(golden.cases)('matches pinned generic tokenizer: $model $name', async fixture => {
    const client = new OpenAIChatClient(profile('openai', fixture.model), 'key');
    expect(await client.getTokenCount(fixture.messages.map(message => messageSchema.parse(message)), fixture.tools)).toBe(fixture.expectedTokens);
  });
  it.each([
    ['Chat', new OpenAIChatClient(profile(), 'key')],
    ['Responses', new OpenAIResponsesClient(profile(), 'key')],
    ['Anthropic', new AnthropicMessagesClient(profile('anthropic', 'claude-3-5-sonnet-20241022'), 'key')],
    ['Gemini', new GeminiClient(profile('gemini', 'gemini-2.5-pro'), 'key')],
  ])('%s counts text, system and stored tools without a provider call', async (_name, client) => {
    expect(client.tokenCountAccuracy).toBe('estimate');
    const messages = [text('user', 'hello')];
    const base = await client.getTokenCount(messages);
    expect(base).toBeGreaterThan(0);
    expect(await client.getTokenCount([text('system', 'Follow the repository rules.'), ...messages])).toBeGreaterThan(base!);
    expect(await client.getTokenCount(messages, [tool])).toBeGreaterThan(base!);
    expect(await client.getTokenCount(messages, [tool.toResponsesTool()])).toBe(await client.getTokenCount(messages, [tool]));
    expect(messages).toEqual([text('user', 'hello')]);
  });

  it('uses BPE for unicode and safely encodes literal special tokens', async () => {
    const client = new OpenAIChatClient(profile('openai', 'unknown-model'), 'key');
    expect(await client.getTokenCount([text('user', '生日快乐')])).toBeGreaterThan(5);
    await expect(client.getTokenCount([text('user', '<|endoftext|>')])).resolves.toBeGreaterThan(0);
  });

  it('counts tool calls/results and available reasoning', async () => {
    const client = new OpenAIChatClient(profile(), 'key');
    const ordinary = await client.getTokenCount([messageSchema.parse({ role: 'assistant', content: 'hello' })]);
    const calls = messageSchema.parse({ role: 'assistant', content: 'hello', reasoning_content: 'Consider all possibilities', tool_calls: [{ id: 'call', origin: 'completion', name: 'lookup', arguments: '{"path":"README.md"}' }] });
    expect(await client.getTokenCount([calls, messageSchema.parse({ role: 'tool', tool_call_id: 'call', content: 'file contents' })])).toBeGreaterThan(ordinary!);
  });

  it('marks unknown modalities as unknown instead of counting URL or encrypted data as tokens', async () => {
    const client = new OpenAIChatClient(profile(), 'key');
    const image = messageSchema.parse({ role: 'user', content: [{ type: 'image', image_urls: ['https://example.test/a.png'] }] });
    expect(await client.getTokenCount([image])).toBeNull();
    expect(await client.getTokenCount([messageSchema.parse({ role: 'assistant', content: '', responses_reasoning_item: { encrypted_content: 'opaque' } })])).toBeNull();
  });
});

describe('resolved input budgets', () => {
  it('uses the locked native catalog but does not apply a public limit to a custom route', () => {
    expect(new OpenAIChatClient(profile(), 'key').effectiveMaxInputTokens).toBe(128000);
    expect(new GeminiClient(profile('gemini', 'gemini-2.5-pro'), 'key').effectiveMaxInputTokens).toBe(1048576);
    expect(new OpenAIChatClient(llmProfileSchema.parse({ ...profile(), baseUrl: 'https://custom.test/v1' }), 'key').effectiveMaxInputTokens).toBeNull();
    expect(new OpenAIChatClient(llmProfileSchema.parse({ ...profile(), baseUrl: 'https://api.openai.com/custom' }), 'key').effectiveMaxInputTokens).toBeNull();
    expect(new OpenAIChatClient(llmProfileSchema.parse({ ...profile(), baseUrl: 'https://api.openai.com:8443/v1' }), 'key').effectiveMaxInputTokens).toBeNull();
  });

  it('bounds a stalled metadata response body and allows later retries', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ({ ...result({}), json: () => new Promise<unknown>(() => {}) }));
    const budget = new LLMContextBudget(profile('openrouter', 'unknown/model'), { fetch });
    const pending = budget.resolveRuntimeMetadata();
    await vi.advanceTimersByTimeAsync(10001);
    await pending;
    expect(budget.effectiveMaxInputTokens).toBeNull();
    expect(fetch.mock.calls[0]![1].signal?.aborted).toBe(true);
  });

  it.each([false, true])('does not retain stale metadata after a failed or malformed refresh (HTTP success=%s)', async ok => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => result({ data: { endpoints: [{ context_length: 16384 }] } }));
    const budget = new LLMContextBudget(profile('openrouter', 'unknown/model'), { fetch });
    await budget.resolveRuntimeMetadata();
    expect(budget.effectiveMaxInputTokens).toBe(16384);
    await vi.advanceTimersByTimeAsync(3600001);
    expect(budget.effectiveMaxInputTokens).toBeNull();
    fetch.mockImplementation(async () => result({}, ok));
    await budget.resolveRuntimeMetadata();
    expect(budget.effectiveMaxInputTokens).toBeNull();
  });

  it('uses explicit limits even for unknown models and custom endpoints', async () => {
    const fetch = vi.fn();
    const budget = new LLMContextBudget(llmProfileSchema.parse({ ...profile(), maxInputTokens: 8192, baseUrl: 'https://custom.test/v1' }), { fetch });
    await budget.resolveRuntimeMetadata();
    expect(budget.effectiveMaxInputTokens).toBe(8192);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not guess an input limit for unknown models', async () => {
    const budget = new LLMContextBudget(profile('openai', 'unknown-model'));
    await budget.resolveRuntimeMetadata();
    expect(budget.effectiveMaxInputTokens).toBeNull();
  });

  it('resolves OpenRouter endpoint limits before use, deduplicates and caches probes', async () => {
    const fetch = vi.fn(async () => result({ data: { endpoints: [{ context_length: 131072 }, { context_length: 262144 }] } }));
    const budget = new LLMContextBudget(profile('openrouter', 'deepseek/deepseek-v4-flash'), { fetch });
    expect(fetch).not.toHaveBeenCalled();
    await Promise.all([budget.resolveRuntimeMetadata(), budget.resolveRuntimeMetadata()]);
    expect(budget.effectiveMaxInputTokens).toBe(131072);
    await budget.resolveRuntimeMetadata();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints');
  });

  it('matches proxy public aliases and underlying model IDs without inventing an alias limit', async () => {
    const fetch = vi.fn(async () => result({ data: [{ model_name: 'alias', litellm_params: { model: 'anthropic/custom-model' }, model_info: { max_input_tokens: 16000 } }] }));
    const budget = new LLMContextBudget(llmProfileSchema.parse({ ...profile('litellm_proxy', 'anthropic/custom-model'), baseUrl: 'https://proxy.test/v1' }), { fetch, headers: { Authorization: 'Bearer test-key' } });
    await budget.resolveRuntimeMetadata();
    expect(budget.effectiveMaxInputTokens).toBe(16000);
    expect(fetch.mock.calls[0]![0]).toBe('https://proxy.test/v1/model/info');
    expect(fetch.mock.calls[0]![1].redirect).toBe('error');
    const absent = new LLMContextBudget(llmProfileSchema.parse({ ...profile('litellm_proxy', 'unknown-alias'), baseUrl: 'https://proxy.test/v1' }), { fetch });
    await absent.resolveRuntimeMetadata();
    expect(absent.effectiveMaxInputTokens).toBeNull();
  });

  it('negative-caches unavailable metadata and never aborts a completion preflight', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => { throw new Error('offline'); });
    const budget = new LLMContextBudget(profile('openrouter', 'unknown/model'), { fetch });
    await budget.resolveRuntimeMetadata();
    await budget.resolveRuntimeMetadata();
    expect(budget.effectiveMaxInputTokens).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300001);
    await budget.resolveRuntimeMetadata();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
