import { describe, expect, it } from 'vitest';

import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { textContent } from '../index.js';
import { AnthropicMessagesClient, createAnthropicClientFromProfile, llmProfileSchema } from '../anthropic.js';

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
});

interface FakeFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeAnthropicFetch(response: { text: string }, calls: FakeFetchCall[] = []) {
  return async (url: string, init: { headers: Readonly<Record<string, string>>; body: string }) => {
    calls.push({
      url,
      headers: normalizeHeaders(init.headers),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: response.text }],
          usage: { input_tokens: 11, output_tokens: 5 },
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
