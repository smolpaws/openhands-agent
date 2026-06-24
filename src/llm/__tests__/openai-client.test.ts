import { describe, expect, it } from 'vitest';

import { InMemorySecretStore, llmProviderSecretRef, llmProfileSecretRef } from '../../secrets/index.js';
import { textContent } from '../index.js';
import {
  OpenAIChatClient,
  createLlmClientFromProfile,
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

    const client = await createLlmClientFromProfile(profile, store, { fetch: fakeFetch({ content: 'ok' }) });

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
    const client = await createLlmClientFromProfile(profile, store, { fetch: fakeFetch({ content: 'ok' }, calls) });

    await client.complete([{ role: 'user', content: [textContent('hello')] }]);

    expect(calls[0]?.headers.authorization).toBe('Bearer profile-key');
  });

  it('posts OpenAI-compatible chat completions requests and parses responses', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'default',
      providerId: 'openai',
      model: 'gpt-5.1',
      temperature: 0.2,
      maxOutputTokens: 123,
      headers: { 'X-Trace': 'abc' },
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'openai-key']]);
    const calls: FakeFetchCall[] = [];
    const client = await createLlmClientFromProfile(profile, store, { fetch: fakeFetch({ content: 'pong' }, calls) });

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
      model: 'gpt-5.1',
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

  it('requires a keyring-backed API key', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'default', providerId: 'openai', model: 'gpt-5.1' });

    await expect(createLlmClientFromProfile(profile, new InMemorySecretStore())).rejects.toThrow(
      /Missing API key for LLM profile 'default'/u,
    );
  });

  it('validates normalized completion responses', () => {
    expect(() => llmCompletionResponseSchema.parse({ message: { role: 'assistant', content: 'ok' } })).not.toThrow();
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
          choices: [{ message: { role: 'assistant', content: response.content } }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
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
