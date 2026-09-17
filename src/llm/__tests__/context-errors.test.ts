// PORT: pinned tests/sdk/llm/test_exception_classifier.py and test_exception_mapping.py.
// Provider envelopes additionally exercise our native replacement for LiteLLM mapping.
import { describe, expect, it } from 'vitest';
import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';
import { llmProfileSchema } from '../index.js';
import { isContextWindowExceeded, looksLikeMalformedConversationHistoryError, LLMContextWindowExceedError, LLMMalformedConversationHistoryError, mapProviderException } from '../exceptions.js';
import type { OpenAISubscriptionAuth } from '../auth/index.js';

const profile = (providerId = 'openai') => llmProfileSchema.parse({ profileId: 'test', providerId, model: 'test-model' });
const response = (body: unknown, status = 400) => async () => ({ ok: status < 300, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
const auth = { refreshIfNeeded: async () => ({ access_token: 'test-token' }), extractChatGPTAccountId: async () => null } as unknown as OpenAISubscriptionAuth;
const subscription = (body: unknown, status = 400) => new OpenAIResponsesClient(llmProfileSchema.parse({ ...profile(), authType: 'subscription', openAiApiMode: 'responses' }), '', response(body, status), auth);
const errorOf = async (client: { complete(messages: []): Promise<unknown> }) => client.complete([]).catch((error: unknown) => error);

describe('native provider context overflow mapping', () => {
  it.each([
    ['chat code', new OpenAIChatClient(profile(), 'key', response({ error: { code: 'context_length_exceeded', message: 'Input is too large' } }))],
    ['Responses', new OpenAIResponsesClient(profile(), 'key', response({ error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } }))],
    ['Anthropic', new AnthropicMessagesClient(profile('anthropic'), 'key', response({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 200001 tokens > 200000 maximum' } }))],
    ['Gemini', new GeminiClient(profile('gemini'), 'key', response({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The input token count (1000001) exceeds the maximum number of tokens allowed (1000000).' } }))],
    ['llama.cpp', new OpenAIChatClient(profile(), 'key', response({ error: { message: 'OpenAIException - request (138229 tokens) exceeds the available context size (133376 tokens), try increasing it' } }))],
    ['wrapped Minimax', new OpenAIChatClient(profile(), 'key', response({ error: { message: 'MinimaxException - {"type":"error","error":{"type":"bad_request_error","message":"invalid params, context window exceeds limit (2013)"}}' } }, 500))],
    ['explicit 413 overflow', new OpenAIChatClient(profile(), 'key', response({ error: { code: 'context_length_exceeded' } }, 413))],
    ['subscription HTTP', subscription({ error: { code: 'context_length_exceeded', message: 'private-prompt-fragment' } })],
  ])('%s reaches the shared typed recovery boundary', async (_name, client) => {
    const error = await errorOf(client);
    expect(error).toBeInstanceOf(LLMContextWindowExceedError);
    expect(isContextWindowExceeded(error)).toBe(true);
    expect(looksLikeMalformedConversationHistoryError(error)).toBe(false);
    if (_name === 'subscription HTTP') expect(String(error)).not.toContain('private-prompt-fragment');
  });

  it.each([
    ['unrelated 400', 400, { error: { message: 'Unknown parameter: temperature' } }],
    ['generic 413', 413, { error: { message: 'Request body too large' } }],
    ['output budget', 400, { error: { message: 'max_tokens must be less than 8192' } }],
    ['output limit mentions context', 400, { error: { message: 'max_output_tokens is too large for the maximum context length of this model' } }],
    ['output incomplete', 200, { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }],
    ['authentication', 401, { error: { code: 'context_length_exceeded', message: 'Invalid API key' } }],
    ['permission', 403, { error: { message: 'prompt is too long' } }],
    ['rate limit', 429, { error: { message: 'please reduce the length of the retry interval' } }],
    ['content policy', 400, { error: { code: 'content_policy_violation', message: 'Output blocked by content filtering policy' } }],
    ['cache minimum', 400, { error: { message: 'The minimum token count to start caching is 4096.' } }],
  ])('%s does not trigger context recovery', async (_name, status, body) => {
    const error = await errorOf(new OpenAIResponsesClient(profile(), 'key', response(body, status)));
    expect(isContextWindowExceeded(error)).toBe(false);
    expect(looksLikeMalformedConversationHistoryError(error)).toBe(false);
  });

  it.each([
    'messages.134: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_1.',
    'Each tool_use must have a single result',
    "an assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'",
    'OpenAIException - Failed to parse tool call arguments as JSON: missing closing quote',
  ])('distinguishes malformed history: %s', async message => {
    const error = await errorOf(new OpenAIChatClient(profile(), 'key', response({ error: { message } }, 500)));
    expect(error).toBeInstanceOf(LLMMalformedConversationHistoryError);
    expect(looksLikeMalformedConversationHistoryError(error)).toBe(true);
    expect(isContextWindowExceeded(error)).toBe(false);
  });

  it('maps a provider connection wrapper but does not interpret arbitrary application errors', () => {
    const wrapped = Object.assign(new Error('MinimaxException: context window exceeds limit (2013)'), { name: 'APIConnectionError' });
    expect(isContextWindowExceeded(mapProviderException(wrapped))).toBe(true);
    const unrelated = new Error('context window exceeds limit in my application');
    expect(mapProviderException(unrelated)).toBe(unrelated);
    expect(isContextWindowExceeded(unrelated)).toBe(false);
  });

  it.each(['response.failed', 'response.incomplete', 'error'])('maps subscription SSE %s without leaking payloads', async type => {
    const detail = { code: 'context_length_exceeded', message: 'private-prompt-fragment' };
    const payload = type === 'error' ? { type, ...detail } : { type, response: { id: 'failed-r', model: 'served-model', error: detail, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } };
    const error = await errorOf(subscription(`data: ${JSON.stringify(payload)}\n\n`, 200));
    expect(isContextWindowExceeded(error)).toBe(true);
    expect(String(error)).not.toContain('private-prompt-fragment');
    if (type !== 'error') expect(error).toMatchObject({ name: 'LLMResponseError', metadata: { responseId: 'failed-r', usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } } });
  });

  it('does not condense an output-limited subscription response and retains its usage', async () => {
    const payload = { type: 'response.incomplete', response: { id: 'output-limited', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } };
    const error = await errorOf(subscription(`data: ${JSON.stringify(payload)}\n\n`, 200));
    expect(error).toMatchObject({ name: 'LLMResponseError', metadata: { responseId: 'output-limited', usage: { promptTokens: 12, completionTokens: 3 } } });
    expect(isContextWindowExceeded(error)).toBe(false);
    expect(looksLikeMalformedConversationHistoryError(error)).toBe(false);
  });

  it('retains HTTP failure usage and classification together', async () => {
    const error = await errorOf(new OpenAIChatClient(profile(), 'key', response({ id: 'paid-r', error: { code: 'context_length_exceeded' }, usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } }, 400)));
    expect(isContextWindowExceeded(error)).toBe(true);
    expect(error).toMatchObject({ name: 'LLMResponseError', metadata: { usage: { promptTokens: 8, completionTokens: 1 } } });
  });

  it.each(['responses', 'subscription'])('retains %s overflow classification even when usage counters are malformed', async transport => {
    const usage = { input_tokens: 8, output_tokens: -1, total_tokens: 7 };
    const body = { id: 'failed-r', status: 'failed', error: { code: 'context_length_exceeded' }, usage, output: [] };
    const client = transport === 'responses'
      ? new OpenAIResponsesClient(profile(), 'key', response(body, 200))
      : subscription('data: ' + JSON.stringify({ type: 'response.failed', response: body }) + String.fromCharCode(10, 10), 200);
    const error = await errorOf(client);
    expect(isContextWindowExceeded(error)).toBe(true);
    expect(error).toMatchObject({ name: 'LLMResponseError', metadata: { responseId: 'failed-r', usage: { providerUsage: usage } } });
    expect(error.metadata.usage).not.toHaveProperty('completionTokens');
  });

  it('retains failed Responses usage and classification together', async () => {
    const error = await errorOf(new OpenAIResponsesClient(profile(), 'key', response({ id: 'failed-r', status: 'failed', error: { code: 'context_length_exceeded' }, usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 }, output: [] }, 200)));
    expect(isContextWindowExceeded(error)).toBe(true);
    expect(error).toMatchObject({ name: 'LLMResponseError', metadata: { usage: { promptTokens: 8, completionTokens: 1 } } });
  });
});
