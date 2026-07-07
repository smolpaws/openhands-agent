import { describe, expect, it } from 'vitest';

import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { AnthropicMessagesClient } from '../anthropic.js';
import { GeminiClient } from '../gemini.js';
import { llmProfileSchema, textContent } from '../index.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../openai.js';
import { createClientFromProfile, detectProviderFromBaseUrl, resolveProviderFromProfile } from '../factory.js';

interface FakeFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

describe('createClientFromProfile', () => {
  it('routes Anthropic profiles to the Anthropic Messages client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'anthropic', providerId: 'anthropic', model: 'claude-sonnet-4-5' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('anthropic'), 'anthropic-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('anthropic', calls) });
    const response = await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(AnthropicMessagesClient);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('anthropic-key');
    expect(response.message.content).toEqual([textContent('anthropic pong')]);
  });

  it('routes Gemini profiles to the Gemini client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-3.5-flash' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('gemini', calls) });
    const response = await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(GeminiClient);
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
    expect(calls[0]?.headers['x-goog-api-key']).toBe('gemini-key');
    expect(response.message.content).toEqual([textContent('gemini pong')]);
  });

  it('routes Responses-mode OpenAI-compatible profiles to the Responses client', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'responses',
      providerId: 'openai',
      model: 'gpt-5-mini',
      openAiApiMode: 'responses',
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'openai-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('responses', calls) });
    await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(OpenAIResponsesClient);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
  });

  it('routes OpenAI-compatible chat profiles to the chat client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'chat', providerId: 'openrouter', model: 'openai/gpt-4.1' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openrouter'), 'openrouter-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('chat', calls) });
    await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(client).toBeInstanceOf(OpenAIChatClient);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('uses baseUrl detection for custom provider IDs while preserving provider-key lookup', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'custom-anthropic',
      providerId: 'my-anthropic-proxy',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.com',
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('my-anthropic-proxy'), 'custom-key']]);
    const calls: FakeFetchCall[] = [];

    const client = await createClientFromProfile(profile, store, { fetch: fakeFetch('anthropic', calls) });
    await client.complete([{ role: 'user', content: [textContent('ping')] }]);

    expect(resolveProviderFromProfile(profile)).toBe('anthropic');
    expect(client).toBeInstanceOf(AnthropicMessagesClient);
    expect(calls[0]?.headers['x-api-key']).toBe('custom-key');
  });
});

describe('detectProviderFromBaseUrl', () => {
  it.each([
    ['https://api.anthropic.com', 'anthropic'],
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://llm-proxy.example.test', 'litellm_proxy'],
    [null, 'openai'],
  ] as const)('detects %s as %s', (baseUrl, provider) => {
    expect(detectProviderFromBaseUrl(baseUrl)).toBe(provider);
  });
});

function fakeFetch(kind: 'anthropic' | 'gemini' | 'responses' | 'chat', calls: FakeFetchCall[]) {
  return async (url: string, init: { headers?: HeadersInit; body?: BodyInit | null }) => {
    calls.push({ url, headers: normalizeHeaders(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        if (kind === 'anthropic') {
          return { role: 'assistant', content: [{ type: 'text', text: 'anthropic pong' }], usage: { input_tokens: 1, output_tokens: 1 } };
        }
        if (kind === 'gemini') {
          return {
            candidates: [{ content: { role: 'model', parts: [{ text: 'gemini pong' }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          };
        }
        if (kind === 'responses') {
          return {
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'responses pong' }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
        }
        return {
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'chat pong' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
