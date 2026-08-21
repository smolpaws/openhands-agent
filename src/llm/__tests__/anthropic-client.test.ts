import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { ToolDefinition } from '../../tool/index.js';
import { textContent } from '../index.js';
import { AnthropicMessagesClient, buildAnthropicMessagesBody, createAnthropicClientFromProfile, llmProfileSchema } from '../anthropic.js';

describe('profile-resolved Anthropic Messages client', () => {
  it('resolves provider-scoped Anthropic keys and constructs a client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);

    const client = await createAnthropicClientFromProfile(profile, store, { fetch: fakeAnthropicFetch({ text: 'ok' }) });

    expect(client).toBeInstanceOf(AnthropicMessagesClient);
    expect(client.profile.providerId).toBe('anthropic');
  });

  it('posts Anthropic messages requests and parses responses', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'sonnet',
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      temperature: 0.1,
      maxOutputTokens: 1024,
      headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const calls: FakeFetchCall[] = [];
    const client = await createAnthropicClientFromProfile(profile, store, { fetch: fakeAnthropicFetch({ text: 'pong' }, calls) });

    const result = await client.complete([
      { role: 'system', content: [textContent('You are terse.')] },
      { role: 'user', content: [textContent('Ping?')] },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('anthropic-key');
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(calls[0]?.body).toMatchObject({
      model: 'claude-sonnet-4-5',
      system: 'You are terse.',
      temperature: 0.1,
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Ping?' }] }],
    });
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toEqual([textContent('pong')]);
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 5, totalTokens: 16 });
  });

  it('requires a keyring-backed API key', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });

    await expect(createAnthropicClientFromProfile(profile, new InMemorySecretStore())).rejects.toThrow(
      /Missing API key for Anthropic LLM profile 'sonnet'/u,
    );
  });

  it('maps content-policy blocks to LLMContentPolicyViolationError', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const client = await createAnthropicClientFromProfile(profile, store, {
      fetch: async () => ({
        ok: false,
        status: 400,
        async json() { return {}; },
        async text() { return 'Output blocked by content filtering policy'; },
      }),
    });

    await expect(client.complete([{ role: 'user', content: [textContent('hi')] }])).rejects.toThrow(
      /Output blocked by content filtering policy/u,
    );
  });

  it('normalizes extended thinking requests and preserves signed thinking blocks', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'sonnet',
      providerId: 'anthropic',
      model: 'claude-sonnet-4-5',
      temperature: 0.2,
      maxOutputTokens: 4096,
      reasoningEffort: 'high',
    });

    const body = buildAnthropicMessagesBody(profile, [
      {
        role: 'assistant',
        content: [textContent('answer')],
        reasoning_content: 'private thoughts',
        thinking_blocks: [{ type: 'thinking', thinking: 'private thoughts', signature: 'sig_123' }],
        tool_calls: [{ id: 'tool_1', name: 'lookup', arguments: '{"query":"x"}', origin: 'completion' }],
      },
    ]);

    expect(body.temperature).toBe(1);
    expect(body.thinking).toMatchObject({ type: 'enabled' });
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThanOrEqual(1024);
    expect((body.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(4096);
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private thoughts', signature: 'sig_123' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { query: 'x' } },
        ],
      },
    ]);
  });

  it('gates Anthropic prompt cache-control on supported models', () => {
    const supported = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const unsupported = llmProfileSchema.parse({ profileId: 'legacy', providerId: 'anthropic', model: 'claude-2.1' });
    const messages = [{ role: 'user' as const, content: [textContent('cache me', true)] }];

    expect(buildAnthropicMessagesBody(supported, messages).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'cache me', cache_control: { type: 'ephemeral' } }] },
    ]);
    expect(buildAnthropicMessagesBody(unsupported, messages).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'cache me' }] },
    ]);
  });
});

describe('Anthropic native tool calling', () => {
  const testTool = new ToolDefinition({
    name: 'get_weather',
    description: 'Get the current weather for a location',
    inputSchema: z.object({ location: z.string() }),
    executor: async () => ({ content: 'sunny' }),
  });

  it('serializes tools to Anthropic native format', () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const messages = [{ role: 'user' as const, content: [textContent('What is the weather?')] }];

    const body = buildAnthropicMessagesBody(profile, messages, [testTool]);

    expect(body.tools).toMatchObject([
      {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('omits tools field when no tools are provided', () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const messages = [{ role: 'user' as const, content: [textContent('Hello')] }];

    const body = buildAnthropicMessagesBody(profile, messages, []);

    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('parses tool_use blocks into MessageToolCall records', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const client = await createAnthropicClientFromProfile(
      profile,
      store,
      {
        fetch: fakeAnthropicFetch({
          content: [
            { type: 'text', text: 'Let me check the weather.' },
            { type: 'tool_use', id: 'toolu_01A', name: 'get_weather', input: { location: 'San Francisco' } },
          ],
        }),
      },
    );

    const result = await client.complete([{ role: 'user', content: [textContent('What is the weather in SF?')] }], [testTool]);

    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toEqual([textContent('Let me check the weather.')]);
    expect(result.message.tool_calls).toEqual([
      {
        id: 'toolu_01A',
        responses_item_id: null,
        name: 'get_weather',
        arguments: '{"location":"San Francisco"}',
        origin: 'completion',
      },
    ]);
  });

  it('preserves redacted thinking blocks from responses', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const client = await createAnthropicClientFromProfile(profile, store, {
      fetch: fakeAnthropicFetch({
        content: [
          { type: 'thinking', thinking: 'first', signature: 'sig_1' },
          { type: 'redacted_thinking', data: 'encrypted_1' },
          { type: 'text', text: 'done' },
        ],
      }),
    });

    const result = await client.complete([{ role: 'user', content: [textContent('Think')] }]);

    expect(result.message.thinking_blocks).toEqual([
      { type: 'thinking', thinking: 'first', signature: 'sig_1' },
      { type: 'redacted_thinking', data: 'encrypted_1' },
    ]);
  });

  it('handles multiple parallel tool calls', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const secondTool = new ToolDefinition({
      name: 'get_time',
      description: 'Get the current time',
      inputSchema: z.object({}),
      executor: async () => ({ content: '12:00' }),
    });
    const client = await createAnthropicClientFromProfile(
      profile,
      store,
      {
        fetch: fakeAnthropicFetch({
          content: [
            { type: 'tool_use', id: 'toolu_01A', name: 'get_weather', input: { location: 'NYC' } },
            { type: 'tool_use', id: 'toolu_01B', name: 'get_time', input: {} },
          ],
        }),
      },
    );

    const result = await client.complete([{ role: 'user', content: [textContent('Weather and time?')] }], [testTool, secondTool]);

    expect(result.message.tool_calls).toHaveLength(2);
    expect(result.message.tool_calls?.[0]?.name).toBe('get_weather');
    expect(result.message.tool_calls?.[1]?.name).toBe('get_time');
  });

  it('serializes tool result continuation correctly', () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const messages = [
      { role: 'user' as const, content: [textContent('What is the weather?')] },
      {
        role: 'assistant' as const,
        content: [textContent('Let me check.')],
        tool_calls: [{ id: 'toolu_01A', responses_item_id: null, name: 'get_weather', arguments: '{"location":"SF"}', origin: 'completion' as const }],
      },
      { role: 'tool' as const, tool_call_id: 'toolu_01A', name: 'get_weather', content: [textContent('72°F and sunny')] },
    ];

    const body = buildAnthropicMessagesBody(profile, messages, [testTool]);

    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_01A', name: 'get_weather', input: { location: 'SF' } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: '72°F and sunny' }],
    });
  });

  it('groups parallel tool results into one Anthropic user turn', () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const messages = [
      {
        role: 'assistant' as const,
        content: [],
        tool_calls: [
          { id: 'toolu_01A', responses_item_id: null, name: 'get_weather', arguments: '{"location":"NYC"}', origin: 'completion' as const },
          { id: 'toolu_01B', responses_item_id: null, name: 'get_weather', arguments: '{"location":"Paris"}', origin: 'completion' as const },
        ],
      },
      { role: 'tool' as const, tool_call_id: 'toolu_01A', name: 'get_weather', content: [textContent('rain')] },
      { role: 'tool' as const, tool_call_id: 'toolu_01B', name: 'get_weather', content: [textContent('sun')] },
    ];

    const body = buildAnthropicMessagesBody(profile, messages, [testTool]);

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_01A', name: 'get_weather', input: { location: 'NYC' } },
          { type: 'tool_use', id: 'toolu_01B', name: 'get_weather', input: { location: 'Paris' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01A', content: 'rain' },
          { type: 'tool_result', tool_use_id: 'toolu_01B', content: 'sun' },
        ],
      },
    ]);
  });

  it('replays every signed and redacted thinking block before tool calls', () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const body = buildAnthropicMessagesBody(profile, [{
      role: 'assistant',
      content: [],
      thinking_blocks: [
        { type: 'thinking', thinking: 'first', signature: 'sig_1' },
        { type: 'redacted_thinking', data: 'encrypted_1' },
        { type: 'thinking', thinking: 'second', signature: 'sig_2' },
      ],
      tool_calls: [{ id: 'toolu_01A', responses_item_id: null, name: 'get_weather', arguments: '{"location":"SF"}', origin: 'completion' }],
    }], [testTool]);

    expect(body.messages).toEqual([{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'first', signature: 'sig_1' },
        { type: 'redacted_thinking', data: 'encrypted_1' },
        { type: 'thinking', thinking: 'second', signature: 'sig_2' },
        { type: 'tool_use', id: 'toolu_01A', name: 'get_weather', input: { location: 'SF' } },
      ],
    }]);
  });

  it('rejects invalid replay arguments and missing result ids', () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });

    expect(() => buildAnthropicMessagesBody(profile, [{
      role: 'assistant',
      content: [],
      tool_calls: [{ id: 'toolu_01A', responses_item_id: null, name: 'get_weather', arguments: 'not valid json', origin: 'completion' }],
    }], [testTool])).toThrow(/Anthropic tool call 'toolu_01A'.*valid JSON object/u);

    expect(() => buildAnthropicMessagesBody(profile, [{
      role: 'tool',
      content: [textContent('result')],
    }], [testTool])).toThrow(/tool result requires a tool_call_id/u);
  });

  it('rejects malformed known response blocks', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'sonnet', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const client = await createAnthropicClientFromProfile(profile, store, {
      fetch: fakeAnthropicFetch({ content: [{ type: 'tool_use', name: 'get_weather', input: { location: 'SF' } }] }),
    });

    await expect(client.complete([{ role: 'user', content: [textContent('Weather?')] }], [testTool])).rejects.toThrow();
  });
});

interface FakeFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeAnthropicFetch(response: { text: string } | { content: readonly unknown[] }, calls: FakeFetchCall[] = []) {
  return async (url: string, init: { headers: Readonly<Record<string, string>>; body: string }) => {
    calls.push({
      url,
      headers: normalizeHeaders(init.headers),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const content = 'text' in response ? [{ type: 'text' as const, text: response.text }] : response.content;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          role: 'assistant',
          content,
          usage: { input_tokens: 11, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        };
      },
      async text() {
        return JSON.stringify(await this.json());
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
