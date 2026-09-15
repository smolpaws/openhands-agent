import { describe, expect, it } from 'vitest';

import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import { llmProfileSchema, textContent } from '../index.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';

const messages = [{ role: 'user' as const, content: [textContent('hello')] }];
const profile = (providerId: string) => llmProfileSchema.parse({ profileId: 'usage', providerId, model: 'requested-model' });
const fetchResponse = (body: unknown) => async () => ({
  ok: true, status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const chatResponse = (usage?: unknown) => ({
  id: 'completion-1', model: 'actual-model',
  choices: [{ message: { role: 'assistant', content: 'hello' } }],
  ...(usage === undefined ? {} : { usage }),
});

describe('provider-reported usage normalization', () => {
  it('preserves DeepSeek hit/miss counters without double-counting their aliases', async () => {
    const usage = {
      prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
      prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 25 },
    };
    const result = await new OpenAIChatClient(profile('deepseek'), 'test-key', fetchResponse(chatResponse(usage))).complete(messages);
    expect(result).toMatchObject({ responseId: 'completion-1', model: 'actual-model' });
    expect(result.usage).toEqual({
      promptTokens: 100, completionTokens: 30, totalTokens: 130,
      cacheReadTokens: 80, cacheMissTokens: 20, reasoningTokens: 25, providerUsage: usage,
    });
    expect(result.usage).not.toHaveProperty('cacheWriteTokens');
  });

  it('preserves the OpenAI cache/read/write/reasoning breakdowns within inclusive totals', async () => {
    const usage = {
      prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20, audio_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 25, rejected_prediction_tokens: 2 },
    };
    const result = await new OpenAIChatClient(profile('openai'), 'test-key', fetchResponse(chatResponse(usage))).complete(messages);
    expect(result.usage).toEqual({
      promptTokens: 100, completionTokens: 30, totalTokens: 130,
      cacheReadTokens: 60, cacheWriteTokens: 20, reasoningTokens: 25, providerUsage: usage,
    });
  });

  it('maps OpenAI Responses details and retains actual response identity', async () => {
    const usage = {
      input_tokens: 100, output_tokens: 30, total_tokens: 130,
      input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 25 },
    };
    const result = await new OpenAIResponsesClient(profile('openai'), 'test-key', fetchResponse({
      id: 'resp-1', model: 'actual-response-model', output: [], usage,
    })).complete(messages);
    expect(result).toMatchObject({ responseId: 'resp-1', model: 'actual-response-model' });
    expect(result.usage).toEqual({
      promptTokens: 100, completionTokens: 30, totalTokens: 130,
      cacheReadTokens: 60, cacheWriteTokens: 20, reasoningTokens: 25, providerUsage: usage,
    });
  });

  it('records only the documented OpenRouter account charge, separately from upstream cost', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 2, cost: 0.002, cost_details: { upstream_inference_cost: 0.003 } };
    const result = await new OpenAIChatClient(profile('openrouter'), 'test-key', fetchResponse(chatResponse(usage))).complete(messages);
    expect(result.usage).toEqual({
      promptTokens: 10, completionTokens: 2,
      reportedCost: { amount: 0.002, currency: 'credits' }, providerUsage: usage,
    });
    const unknownProvider = await new OpenAIChatClient(profile('openai'), 'test-key', fetchResponse(chatResponse(usage))).complete(messages);
    expect(unknownProvider.usage).not.toHaveProperty('reportedCost');
    expect(unknownProvider.usage).toHaveProperty('providerUsage', usage);
  });

  it('keeps zero usage/cost distinct from missing usage and missing counters', async () => {
    const usage = { prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, cost: 0 };
    const result = await new OpenAIChatClient(profile('openrouter'), 'test-key', fetchResponse(chatResponse(usage))).complete(messages);
    expect(result.usage).toEqual({
      promptTokens: 0, cacheReadTokens: 0, reportedCost: { amount: 0, currency: 'credits' }, providerUsage: usage,
    });
    const empty = await new OpenAIChatClient(profile('openai'), 'test-key', fetchResponse(chatResponse({}))).complete(messages);
    expect(empty.usage).toEqual({ providerUsage: {} });
    const missing = await new OpenAIChatClient(profile('openai'), 'test-key', fetchResponse(chatResponse())).complete(messages);
    expect(missing.usage).toBeNull();
  });

  it('adds the disjoint Anthropic input categories and keeps write TTLs as a breakdown', async () => {
    const usage = {
      input_tokens: 20, output_tokens: 30, cache_read_input_tokens: 60, cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 },
    };
    const result = await new AnthropicMessagesClient(profile('anthropic'), 'test-key', fetchResponse({
      id: 'msg-1', model: 'actual-claude', role: 'assistant', content: [], usage,
    })).complete(messages);
    expect(result).toMatchObject({ responseId: 'msg-1', model: 'actual-claude' });
    expect(result.usage).toEqual({
      promptTokens: 120, completionTokens: 30, totalTokens: 150,
      cacheReadTokens: 60, cacheWriteTokens: 40, providerUsage: usage,
    });
  });

  it('does not invent missing Anthropic base counts', async () => {
    const usage = { cache_read_input_tokens: 10 };
    const result = await new AnthropicMessagesClient(profile('anthropic'), 'test-key', fetchResponse({ content: [], usage })).complete(messages);
    expect(result.usage).toEqual({ cacheReadTokens: 10, providerUsage: usage });
  });

  it.each([
    {}, { cache_read_input_tokens: 0 }, { cache_creation_input_tokens: 0 },
  ])('keeps Anthropic inclusive input unknown when a cache category is absent: %j', async (cache) => {
    const usage = { input_tokens: 10, output_tokens: 2, ...cache };
    const result = await new AnthropicMessagesClient(profile('anthropic'), 'test-key', fetchResponse({ content: [], usage })).complete(messages);
    expect(result.usage).toHaveProperty('completionTokens', 2);
    expect(result.usage).not.toHaveProperty('promptTokens');
    expect(result.usage).not.toHaveProperty('totalTokens');
    expect(result.usage).toHaveProperty('providerUsage', usage);
  });

  it('computes Anthropic inclusive input when both cache categories explicitly report zero', async () => {
    const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const result = await new AnthropicMessagesClient(profile('anthropic'), 'test-key', fetchResponse({ content: [], usage })).complete(messages);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, providerUsage: usage });
  });

  it('counts Gemini thought tokens as output exactly once and retains internal tool prompts', async () => {
    const usage = {
      total_input_tokens: 100, total_output_tokens: 23, total_thought_tokens: 49,
      total_cached_tokens: 80, total_tool_use_tokens: 10, total_tokens: 182,
      input_tokens_by_modality: [{ modality: 'text', tokens: 100 }],
    };
    const result = await new GeminiClient(profile('gemini'), 'test-key', fetchResponse({
      id: 'interaction-1', model: 'actual-gemini', steps: [], usage,
    })).complete(messages);
    expect(result).toMatchObject({ responseId: 'interaction-1', model: 'actual-gemini' });
    expect(result.usage).toEqual({
      promptTokens: 100, completionTokens: 72, totalTokens: 182,
      cacheReadTokens: 80, reasoningTokens: 49, toolUsePromptTokens: 10, providerUsage: usage,
    });
  });

  it('does not fabricate missing Gemini counts or replace the provider total', async () => {
    const usage = { total_tokens: 42, total_thought_tokens: 7 };
    const result = await new GeminiClient(profile('gemini'), 'test-key', fetchResponse({ steps: [], usage })).complete(messages);
    expect(result.usage).toEqual({ totalTokens: 42, reasoningTokens: 7, providerUsage: usage });
  });

  it('keeps Gemini all-generated output unknown when the thought count is absent', async () => {
    const usage = { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 19 };
    const result = await new GeminiClient(profile('gemini'), 'test-key', fetchResponse({ steps: [], usage })).complete(messages);
    expect(result.usage).toEqual({ promptTokens: 10, totalTokens: 19, providerUsage: usage });
  });

  it('computes Gemini all-generated output when thoughts explicitly report zero', async () => {
    const usage = { total_input_tokens: 10, total_output_tokens: 2, total_thought_tokens: 0, total_tokens: 12 };
    const result = await new GeminiClient(profile('gemini'), 'test-key', fetchResponse({ steps: [], usage })).complete(messages);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 2, reasoningTokens: 0, totalTokens: 12, providerUsage: usage });
  });
});
