import { describe, expect, it } from 'vitest';

import { InMemorySecretStore, llmProviderSecretRef, llmProfileSecretRef } from '../../secrets/index.js';
import { textContent } from '../index.js';
import {
  OpenAIChatClient,
  OpenAIResponsesClient,
  buildChatCompletionsBody,
  buildOpenAIResponsesBody,
  createOpenAIChatClientFromProfile,
  createOpenAIResponsesClientFromProfile,
  llmCompletionResponseSchema,
  llmProfileSchema,
} from '../openai.js';

describe('profile-resolved OpenAI-compatible chat client', () => {
  it('resolves provider-scoped keys by providerId, not model family', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'eval-proxy',
      providerId: 'litellm_proxy',
      model: 'openai/gpt-5.1',
      baseUrl: 'https://llm-proxy.example.test',
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('litellm_proxy'), 'proxy-key']]);

    const client = await createOpenAIChatClientFromProfile(profile, store, { fetch: fakeFetch({ content: 'ok' }) });

    expect(client).toBeInstanceOf(OpenAIChatClient);
    expect(client.profile.providerId).toBe('litellm_proxy');
  });

  it('uses an enabled profile override key when present', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'eval-proxy',
      providerId: 'litellm_proxy',
      model: 'openai/gpt-5.1',
      baseUrl: 'https://llm-proxy.example.test',
      useProfileKeyOverride: true,
    });
    const store = new InMemorySecretStore([
      [llmProviderSecretRef('litellm_proxy'), 'provider-key'],
      [llmProfileSecretRef('eval-proxy'), 'profile-key'],
    ]);
    const calls: FakeFetchCall[] = [];
    const client = await createOpenAIChatClientFromProfile(profile, store, { fetch: fakeFetch({ content: 'ok' }, calls) });

    await client.complete([{ role: 'user', content: [textContent('hello')] }]);

    expect(calls[0]?.headers.authorization).toBe('Bearer profile-key');
  });

  it('posts OpenAI-compatible chat completions requests and parses responses', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'default',
      providerId: 'openai',
      model: 'gpt-4.1',
      temperature: 0.2,
      maxOutputTokens: 123,
      headers: { 'X-Trace': 'abc' },
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'openai-key']]);
    const calls: FakeFetchCall[] = [];
    const client = await createOpenAIChatClientFromProfile(profile, store, { fetch: fakeFetch({ content: 'pong' }, calls) });

    const result = await client.complete([
      { role: 'system', content: [textContent('You are terse.')] },
      { role: 'user', content: [textContent('Ping?')] },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.headers.authorization).toBe('Bearer openai-key');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(calls[0]?.headers['x-trace']).toBe('abc');
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-4.1',
      temperature: 0.2,
      max_completion_tokens: 123,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Ping?' },
      ],
    });
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toEqual([textContent('pong')]);
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  });

  it('posts OpenAI Responses requests and parses response output text', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'responses',
      providerId: 'openai',
      model: 'gpt-5.1',
      openAiApiMode: 'responses',
      reasoningEffort: 'medium',
      maxOutputTokens: 256,
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'openai-key']]);
    const calls: FakeFetchCall[] = [];
    const client = await createOpenAIResponsesClientFromProfile(profile, store, {
      fetch: fakeResponsesFetch({ content: 'response pong' }, calls),
    });

    const result = await client.complete([
      { role: 'system', content: [textContent('Follow instructions.')] },
      { role: 'user', content: [textContent('Ping responses?')] },
    ]);

    expect(client).toBeInstanceOf(OpenAIResponsesClient);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.headers.authorization).toBe('Bearer openai-key');
    expect(calls[0]?.body).toMatchObject({
      model: 'gpt-5.1',
      instructions: 'Follow instructions.',
      max_output_tokens: 256,
      reasoning: { effort: 'medium' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Ping responses?' }] }],
    });
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toEqual([textContent('response pong')]);
    expect(result.usage).toEqual({ promptTokens: 17, completionTokens: 9, totalTokens: 26 });
    expect(result.message.responses_reasoning_item).toEqual({
      id: 'rs_123',
      summary: ['short summary'],
      content: null,
      encrypted_content: 'encrypted_reasoning_payload',
      status: 'completed',
    });

  });

  it('requires a keyring-backed API key', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'default', providerId: 'openai', model: 'gpt-5.1' });

    await expect(createOpenAIChatClientFromProfile(profile, new InMemorySecretStore())).rejects.toThrow(
      /Missing API key for LLM profile 'default'/u,
    );
  });

  it('validates normalized completion responses', () => {
    expect(() => llmCompletionResponseSchema.parse({ message: { role: 'assistant', content: 'ok' } })).not.toThrow();
  });
});

describe('OpenAI chat message serialization parity', () => {
  it('drops empty assistant content when tool calls are present', () => {
    const profile = llmProfileSchema.parse({ profileId: 'default', providerId: 'openai', model: 'gpt-5.1' });

    const body = buildChatCompletionsBody(profile, [
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 'call_empty', name: 'test_function', arguments: '{}', origin: 'completion' }],
      },
    ]);

    expect(body.messages).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_empty',
            type: 'function',
            function: { name: 'test_function', arguments: '{}' },
          },
        ],
      },
    ]);
  });

  it('drops blank text-list assistant content when tool calls are present', () => {
    const profile = llmProfileSchema.parse({ profileId: 'default', providerId: 'openai', model: 'gpt-5.1' });

    const body = buildChatCompletionsBody(profile, [
      {
        role: 'assistant',
        content: [textContent('')],
        tool_calls: [{ id: 'call_blank', name: 'test_function', arguments: '{}', origin: 'completion' }],
      },
    ]);

    expect((body.messages as Array<Record<string, unknown>>)[0]).not.toHaveProperty('content');
  });

  it('omits temperature for GPT-5 chat-completions models', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'default',
      providerId: 'openai',
      model: 'gpt-5-nano',
      temperature: 0.7,
    });

    const body = buildChatCompletionsBody(profile, [{ role: 'user', content: [textContent('ping')] }]);

    expect(body).not.toHaveProperty('temperature');
  });

  it('omits temperature for GPT-5 Responses models while preserving reasoning', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'responses',
      providerId: 'openai',
      model: 'openai/gpt-5-nano',
      openAiApiMode: 'responses',
      temperature: 0.7,
      reasoningEffort: 'low',
    });

    const body = buildOpenAIResponsesBody(profile, [{ role: 'user', content: [textContent('ping')] }]);

    expect(body).not.toHaveProperty('temperature');
    expect(body).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('persists prompt-cache profile options through the LLM profile schema', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'cache-profile',
      providerId: 'openai',
      model: 'gpt-5.6',
      promptCacheRetention: '24h',
      promptCacheKey: 'stable-prefix-v1',
    });

    expect(profile.promptCacheRetention).toBe('24h');
    expect(profile.promptCacheKey).toBe('stable-prefix-v1');
    expect(() => llmProfileSchema.parse({ profileId: 'bad', providerId: 'openai', model: 'gpt-5.6', promptCacheRetention: '30m' })).toThrow();
  });

  it('adds default 24h prompt-cache retention for direct OpenAI GPT-5.6 Responses requests', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'responses-cache',
      providerId: 'openai',
      model: 'gpt-5.6',
      openAiApiMode: 'responses',
      promptCacheKey: 'conversation-cache-key',
    });

    const body = buildOpenAIResponsesBody(profile, [{ role: 'user', content: [textContent('cache me')] }]);

    expect(body).toMatchObject({
      prompt_cache_retention: '24h',
      prompt_cache_key: 'conversation-cache-key',
    });
  });

  it('adds default 24h prompt-cache retention for direct OpenAI GPT-5.6 Chat requests', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'chat-cache',
      providerId: 'openai',
      model: 'gpt-5.6',
      promptCacheKey: 'conversation-cache-key',
    });

    const body = buildChatCompletionsBody(profile, [{ role: 'user', content: [textContent('cache me')] }]);

    expect(body).toMatchObject({
      prompt_cache_retention: '24h',
      prompt_cache_key: 'conversation-cache-key',
    });
  });

  it('omits prompt-cache retention for unsupported routes and explicit disablement', () => {
    const gpt51 = buildOpenAIResponsesBody(
      llmProfileSchema.parse({ profileId: 'gpt51', providerId: 'openai', model: 'gpt-5.1', openAiApiMode: 'responses', promptCacheRetention: '24h', promptCacheKey: 'ignored-key' }),
      [{ role: 'user', content: [textContent('cache me')] }],
    );
    const litellmAlias = buildChatCompletionsBody(
      llmProfileSchema.parse({ profileId: 'proxy', providerId: 'litellm_proxy', model: 'openai/gpt-5.6', baseUrl: 'https://llm-proxy.example.test', promptCacheRetention: '24h', promptCacheKey: 'ignored-key' }),
      [{ role: 'user', content: [textContent('cache me')] }],
    );
    const subscriptionEndpoint = buildOpenAIResponsesBody(
      llmProfileSchema.parse({ profileId: 'subscription', providerId: 'openai', model: 'gpt-5.6-codex', baseUrl: 'https://chatgpt.com/backend-api/codex', openAiApiMode: 'responses', promptCacheRetention: '24h', promptCacheKey: 'ignored-key' }),
      [{ role: 'user', content: [textContent('cache me')] }],
    );
    const openAINamedProxy = buildChatCompletionsBody(
      llmProfileSchema.parse({ profileId: 'openai-proxy', providerId: 'openai', model: 'gpt-5.6', baseUrl: 'https://openai-proxy.example.test/v1', promptCacheRetention: '24h', promptCacheKey: 'ignored-key' }),
      [{ role: 'user', content: [textContent('cache me')] }],
    );
    const futureSimilarModel = buildChatCompletionsBody(
      llmProfileSchema.parse({ profileId: 'future', providerId: 'openai', model: 'gpt-5.60', promptCacheRetention: '24h', promptCacheKey: 'ignored-key' }),
      [{ role: 'user', content: [textContent('cache me')] }],
    );
    const disabled = buildOpenAIResponsesBody(
      llmProfileSchema.parse({ profileId: 'disabled', providerId: 'openai', model: 'gpt-5.6', openAiApiMode: 'responses', promptCacheRetention: 'disabled' }),
      [{ role: 'user', content: [textContent('cache me')] }],
    );

    for (const body of [gpt51, litellmAlias, subscriptionEndpoint, openAINamedProxy, futureSimilarModel, disabled]) {
      expect(body).not.toHaveProperty('prompt_cache_retention');
      expect(body).not.toHaveProperty('prompt_cache_key');
    }
  });

  it('replays Responses reasoning items with encrypted content in stateless mode', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'responses',
      providerId: 'openai',
      model: 'gpt-5-mini',
      openAiApiMode: 'responses',
      reasoningEffort: 'medium',
      reasoningSummary: 'detailed',
    });

    const body = buildOpenAIResponsesBody(profile, [
      {
        role: 'assistant',
        content: [textContent('previous answer')],
        responses_reasoning_item: {
          id: 'rs_123',
          summary: ['short summary'],
          content: ['hidden chain'],
          encrypted_content: 'encrypted_reasoning_payload',
          status: 'completed',
        },
      },
    ]);

    expect(body).toMatchObject({
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium', summary: 'detailed' },
      input: [
        {
          type: 'reasoning',
          id: 'rs_123',
          summary: [{ type: 'summary_text', text: 'short summary' }],
          encrypted_content: 'encrypted_reasoning_payload',
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'previous answer' }] },
      ],
    });
  });
});

interface FakeFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeFetch(response: { content: string }, calls: FakeFetchCall[] = []) {
  return async (url: string, init: { headers?: HeadersInit; body?: BodyInit | null }) => {
    calls.push({
      url,
      headers: normalizeHeaders(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: response.content, refusal: null, annotations: [] },
            },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
            completion_tokens_details: {
              reasoning_tokens: 0,
              audio_tokens: 0,
              accepted_prediction_tokens: 0,
              rejected_prediction_tokens: 0,
            },
          },
        };
      },
      async text() {
        return JSON.stringify(await this.json());
      },
    };
  };
}

function fakeResponsesFetch(response: { content: string }, calls: FakeFetchCall[] = []) {
  return async (url: string, init: { headers?: HeadersInit; body?: BodyInit | null }) => {
    calls.push({
      url,
      headers: normalizeHeaders(init.headers),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          output: [
            {
              type: 'reasoning',
              id: 'rs_123',
              summary: [{ type: 'summary_text', text: 'short summary' }],
              encrypted_content: 'encrypted_reasoning_payload',
              status: 'completed',
            },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: response.content }] },
          ],
          usage: {
            input_tokens: 17,
            output_tokens: 9,
            total_tokens: 26,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        };
      },
      async text() {
        return JSON.stringify(await this.json());
      },
    };
  };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key.toLowerCase()] = value;
    }
    return normalized;
  }
  for (const [key, value] of Object.entries(headers ?? {})) {
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}
