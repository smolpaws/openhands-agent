import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { ToolDefinition } from '../../tool/index.js';
import { textContent } from '../index.js';
import { GeminiClient, buildGeminiInteractionsBody, createGeminiClientFromProfile, llmProfileSchema } from '../gemini.js';

const weatherTool = new ToolDefinition({
  name: 'get_weather',
  description: 'Get weather for a location',
  inputSchema: z.object({ location: z.string() }).strict(),
  executor: async () => ({ weather: 'sunny' }),
});

describe('profile-resolved Gemini Interactions client', () => {
  it('resolves provider-scoped keys and constructs a client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-3.6-flash' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const client = await createGeminiClientFromProfile(profile, store, { fetch: fakeGeminiFetch(interactionWithText('ok')) });

    expect(client).toBeInstanceOf(GeminiClient);
    expect(client.profile.providerId).toBe('gemini');
  });

  it('posts stateless Interactions requests and parses model output', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'gemini',
      providerId: 'gemini',
      model: 'gemini-3.6-flash',
      maxOutputTokens: 2048,
      headers: { 'X-Goog-Request-Reason': 'test' },
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const calls: FakeFetchCall[] = [];
    const client = await createGeminiClientFromProfile(profile, store, { fetch: fakeGeminiFetch(interactionWithText('pong'), calls) });

    const result = await client.complete([
      { role: 'system', content: [textContent('You are terse.')] },
      { role: 'user', content: [textContent('Ping?')] },
    ]);

    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(calls[0]?.headers['x-goog-api-key']).toBe('gemini-key');
    expect(calls[0]?.headers['x-goog-request-reason']).toBe('test');
    expect(calls[0]?.body).toEqual({
      model: 'gemini-3.6-flash',
      store: false,
      system_instruction: 'You are terse.',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'Ping?' }] }],
      generation_config: { max_output_tokens: 2048 },
    });
    expect(result.message.content).toEqual([textContent('pong')]);
    expect(result.usage).toEqual({
      promptTokens: 13, completionTokens: 8, reasoningTokens: 0, totalTokens: 21,
      providerUsage: { total_input_tokens: 13, total_output_tokens: 8, total_thought_tokens: 0, total_tokens: 21 },
    });
  });

  it('requires a keyring-backed API key', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-3.6-flash' });
    await expect(createGeminiClientFromProfile(profile, new InMemorySecretStore())).rejects.toThrow(
      /Missing API key for Gemini LLM profile 'gemini'/u,
    );
  });
});

describe('Gemini Interactions native tool calling', () => {
  const profile = llmProfileSchema.parse({
    profileId: 'gemini-tools',
    providerId: 'gemini',
    model: 'gemini-3.6-flash',
    reasoningEffort: 'high',
  });

  it('serializes flat function tools and strips unsupported schema fields', () => {
    const body = buildGeminiInteractionsBody(
      profile,
      [{ role: 'user', content: [textContent('What is the weather?')] }],
      [weatherTool],
    );

    expect(body.tools).toEqual([{
      type: 'function',
      name: 'get_weather',
      description: 'Get weather for a location',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    }]);
    expect(body.generation_config).toEqual({
      thinking_level: 'high',
      thinking_summaries: 'auto',
      tool_choice: 'auto',
    });
  });

  it('omits tools and tool choice when no tools are supplied', () => {
    const body = buildGeminiInteractionsBody(profile, [{ role: 'user', content: [textContent('Hello')] }], []);

    expect(body).not.toHaveProperty('tools');
    expect(body.generation_config).not.toHaveProperty('tool_choice');
  });

  it('parses signed thought and parallel function-call steps', async () => {
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const client = await createGeminiClientFromProfile(profile, store, {
      fetch: fakeGeminiFetch({
        id: 'interaction_1',
        status: 'requires_action',
        steps: [
          { type: 'thought', signature: 'thought_sig_123', summary: [{ type: 'text', text: 'Check both cities.' }] },
          { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { location: 'Boston' } },
          { type: 'function_call', id: 'call_2', name: 'get_weather', arguments: { location: 'Paris' } },
        ],
        usage: { total_input_tokens: 20, total_output_tokens: 9, total_tokens: 35 },
      }),
    });

    const result = await client.complete([{ role: 'user', content: [textContent('Weather in Boston and Paris?')] }], [weatherTool]);

    expect(result.message.reasoning_content).toBe('Check both cities.');
    expect(result.message.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'Check both cities.', signature: 'thought_sig_123' },
    ]);
    expect(result.message.tool_calls).toEqual([
      { id: 'call_1', responses_item_id: null, name: 'get_weather', arguments: '{"location":"Boston"}', origin: 'completion' },
      { id: 'call_2', responses_item_id: null, name: 'get_weather', arguments: '{"location":"Paris"}', origin: 'completion' },
    ]);
    expect(result.usage).toEqual({
      promptTokens: 20, totalTokens: 35,
      providerUsage: { total_input_tokens: 20, total_output_tokens: 9, total_tokens: 35 },
    });
  });

  it('replays thought signatures, function calls, and tool results as stateless steps', () => {
    const body = buildGeminiInteractionsBody(profile, [
      { role: 'user', content: [textContent('Weather in Boston?')] },
      {
        role: 'assistant',
        content: [textContent('I will check.')],
        reasoning_content: 'Use the weather tool.Check both calls.',
        thinking_blocks: [
          { type: 'thinking', thinking: 'Use the weather tool.', signature: 'thought_sig_123' },
          { type: 'thinking', thinking: 'Check both calls.', signature: 'thought_sig_456' },
        ],
        tool_calls: [
          { id: 'call_1', responses_item_id: null, name: 'get_weather', arguments: '{"location":"Boston"}', origin: 'completion' },
          { id: 'call_2', responses_item_id: null, name: 'get_weather', arguments: '{"location":"Paris"}', origin: 'completion' },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: [textContent('{"weather":"rain"}')] },
      { role: 'tool', tool_call_id: 'call_2', name: 'get_weather', content: [textContent('{"weather":"sun"}')] },
    ], [weatherTool]);

    expect(body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Weather in Boston?' }] },
      { type: 'thought', signature: 'thought_sig_123', summary: [{ type: 'text', text: 'Use the weather tool.' }] },
      { type: 'thought', signature: 'thought_sig_456', summary: [{ type: 'text', text: 'Check both calls.' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'I will check.' }] },
      { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { location: 'Boston' } },
      { type: 'function_call', id: 'call_2', name: 'get_weather', arguments: { location: 'Paris' } },
      {
        type: 'function_result',
        call_id: 'call_1',
        name: 'get_weather',
        result: [{ type: 'text', text: '{"weather":"rain"}' }],
      },
      {
        type: 'function_result',
        call_id: 'call_2',
        name: 'get_weather',
        result: [{ type: 'text', text: '{"weather":"sun"}' }],
      },
    ]);
  });

  it('rejects malformed replay arguments', () => {
    expect(() => buildGeminiInteractionsBody(profile, [{
      role: 'assistant',
      content: [],
      tool_calls: [
        { id: 'call_bad', responses_item_id: null, name: 'get_weather', arguments: 'not-json', origin: 'completion' },
      ],
    }], [weatherTool])).toThrow(/Gemini function call 'call_bad'.*valid JSON object/u);
  });

  it('rejects function results without a call id', () => {
    expect(() => buildGeminiInteractionsBody(profile, [{
      role: 'tool',
      content: [textContent('result')],
    }], [weatherTool])).toThrow(/function result requires a tool_call_id/u);
  });

  it.each([
    { type: 'function_call', id: 'call_bad', name: 'get_weather', arguments: 'not-an-object' },
    { type: 'model_output', content: [{ type: 'text' }] },
    { type: 'thought', signature: 'sig_bad', summary: [{ type: 'text', text: 42 }] },
  ])('rejects malformed known response steps', async (step) => {
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const client = await createGeminiClientFromProfile(profile, store, {
      fetch: fakeGeminiFetch({ id: 'interaction_bad', status: 'requires_action', steps: [step] }),
    });

    await expect(client.complete([{ role: 'user', content: [textContent('Weather?')] }], [weatherTool])).rejects.toThrow();
  });

  it('ignores unknown future response steps without hiding known output', async () => {
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const client = await createGeminiClientFromProfile(profile, store, {
      fetch: fakeGeminiFetch({
        id: 'interaction_future',
        status: 'completed',
        steps: [
          { type: 'future_trace', payload: { value: 1 } },
          { type: 'model_output', content: [{ type: 'text', text: 'done' }] },
        ],
      }),
    });

    const result = await client.complete([{ role: 'user', content: [textContent('Hello')] }], [weatherTool]);

    expect(result.message.content).toEqual([textContent('done')]);
  });
});

interface FakeFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function interactionWithText(text: string): Record<string, unknown> {
  return {
    id: 'interaction_text',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 13, total_output_tokens: 8, total_thought_tokens: 0, total_tokens: 21 },
  };
}

function fakeGeminiFetch(response: Record<string, unknown>, calls: FakeFetchCall[] = []) {
  return async (url: string, init: { headers: Readonly<Record<string, string>>; body: string }) => {
    calls.push({ url, headers: normalizeHeaders(init.headers), body: JSON.parse(init.body) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        return response;
      },
      async text() {
        return JSON.stringify(response);
      },
    };
  };
}

function normalizeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}
