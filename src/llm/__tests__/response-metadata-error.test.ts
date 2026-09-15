import { describe, expect, it } from 'vitest';
import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';
import { llmProfileSchema } from '../index.js';
import type { OpenAISubscriptionAuth } from '../auth/index.js';

const profile = (providerId: string) => llmProfileSchema.parse({ profileId: 'failed-response', providerId, model: 'requested-model' });
const fetchResponse = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

describe('usage survives response validation errors', () => {
  it.each([
    { name: 'OpenAI chat tool', make: (body: unknown) => new OpenAIChatClient(profile('openai'), 'key', fetchResponse(body)),
      body: { choices: [{ message: { role: 'assistant', content: 'private-content', tool_calls: [{ id: 'call', function: { name: 'tool', arguments: {} } }] } }] },
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    { name: 'OpenAI Responses output', make: (body: unknown) => new OpenAIResponsesClient(profile('openai'), 'key', fetchResponse(body)),
      body: { output: 'private-invalid-output' }, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
    { name: 'Anthropic tool', make: (body: unknown) => new AnthropicMessagesClient(profile('anthropic'), 'key', fetchResponse(body)),
      body: { content: [{ type: 'tool_use', name: 'tool', input: {} }] }, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    { name: 'Gemini function', make: (body: unknown) => new GeminiClient(profile('gemini'), 'key', fetchResponse(body)),
      body: { steps: [{ type: 'function_call', name: 'tool', arguments: {} }] }, usage: { total_input_tokens: 10, total_output_tokens: 2, total_thought_tokens: 0, total_tokens: 12 } },
  ])('retains $name accounting without manufacturing an assistant message', async ({ make, body, usage }) => {
    const error = await make({ ...body, id: 'paid-response', model: 'served-model', usage }).complete([]).catch(error => error as unknown);
    expect(error).toMatchObject({ name: 'LLMResponseError', metadata: {
      responseId: 'paid-response', model: 'served-model', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, providerUsage: usage },
    } });
    expect(error).toHaveProperty('cause');
    expect((error as { metadata: unknown }).metadata).not.toHaveProperty('message');
    expect((error as { metadata: unknown }).metadata).not.toHaveProperty('raw');
    expect(String(error)).not.toContain('private-');
  });

  it('retains native usage even when an invalid counter cannot enter normalized totals', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: -2, total_tokens: 8 };
    const body = { id: 'paid-response', choices: [{ message: { role: 'assistant', content: 'hello' } }], usage };
    const error = await new OpenAIChatClient(profile('openai'), 'key', fetchResponse(body)).complete([]).catch(error => error as unknown);
    expect(error).toMatchObject({ name: 'LLMResponseError', metadata: { responseId: 'paid-response', usage: { providerUsage: usage } } });
    expect((error as { metadata: { usage: unknown } }).metadata.usage).not.toHaveProperty('completionTokens');
  });

  it('retains terminal subscription usage even when the response is incomplete', async () => {
    const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } };
    const auth = { refreshIfNeeded: async () => ({ access_token: 'test-token' }), extractChatGPTAccountId: async () => null } as unknown as OpenAISubscriptionAuth;
    const fetch = async () => ({ ok: true, status: 200, json: async () => null,
      text: async () => `data: ${JSON.stringify({ type: 'response.incomplete', response: { id: 'partial-response', model: 'served-model', usage, output: 'private-output' } })}\n\n`,
    });
    const subscriptionProfile = llmProfileSchema.parse({ ...profile('openai'), authType: 'subscription', model: 'gpt-5.1-codex', openAiApiMode: 'responses' });
    const error = await new OpenAIResponsesClient(subscriptionProfile, '', fetch, auth).complete([]).catch(error => error as unknown);
    expect(error).toMatchObject({ name: 'LLMResponseError', metadata: { responseId: 'partial-response', model: 'served-model',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheReadTokens: 0, providerUsage: usage },
    } });
    expect((error as { metadata: unknown }).metadata).not.toHaveProperty('raw');
    expect(String(error)).not.toContain('private-output');
  });
});
