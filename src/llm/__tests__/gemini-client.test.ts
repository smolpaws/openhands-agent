import { describe, expect, it } from 'vitest';

import { InMemorySecretStore, llmProviderSecretRef } from '../../secrets/index.js';
import { textContent } from '../index.js';
import { GeminiClient, buildGeminiGenerateContentBody, createGeminiClientFromProfile, llmProfileSchema } from '../gemini.js';

describe('profile-resolved Gemini client', () => {
  it('resolves provider-scoped Gemini keys and constructs a client', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-2.5-pro' });
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);

    const client = await createGeminiClientFromProfile(profile, store, { fetch: fakeGeminiFetch({ text: 'ok' }) });

    expect(client).toBeInstanceOf(GeminiClient);
    expect(client.profile.providerId).toBe('gemini');
  });

  it('posts Gemini generateContent requests and parses responses', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'gemini',
      providerId: 'gemini',
      model: 'gemini-2.5-pro',
      temperature: 0.3,
      topP: 0.8,
      topK: 40,
      maxOutputTokens: 2048,
      headers: { 'X-Goog-Request-Reason': 'test' },
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const calls: FakeFetchCall[] = [];
    const client = await createGeminiClientFromProfile(profile, store, { fetch: fakeGeminiFetch({ text: 'pong' }, calls) });

    const result = await client.complete([
      { role: 'system', content: [textContent('You are terse.')] },
      { role: 'user', content: [textContent('Ping?')] },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(calls[0]?.headers['x-goog-api-key']).toBe('gemini-key');
    expect(calls[0]?.headers['x-goog-request-reason']).toBe('test');
    expect(calls[0]?.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'You are terse.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Ping?' }] }],
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        topK: 40,
        maxOutputTokens: 2048,
      },
    });
    expect(result.message.role).toBe('assistant');
    expect(result.message.content).toEqual([textContent('pong')]);
    expect(result.usage).toEqual({ promptTokens: 13, completionTokens: 8, totalTokens: 21 });
  });

  it('requires a keyring-backed API key', async () => {
    const profile = llmProfileSchema.parse({ profileId: 'gemini', providerId: 'gemini', model: 'gemini-2.5-pro' });

    await expect(createGeminiClientFromProfile(profile, new InMemorySecretStore())).rejects.toThrow(
      /Missing API key for Gemini LLM profile 'gemini'/u,
    );
  });

  it('maps reasoning effort to thinkingConfig and round-trips thought signatures on function calls', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'gemini',
      providerId: 'gemini',
      model: 'gemini-3-pro',
      reasoningEffort: 'high',
    });
    const store = new InMemorySecretStore([[llmProviderSecretRef('gemini'), 'gemini-key']]);
    const client = await createGeminiClientFromProfile(profile, store, {
      fetch: fakeGeminiPartsFetch([
        { text: 'private plan', thought: true, thoughtSignature: 'thought_sig_123' },
        { functionCall: { name: 'lookup', args: { query: 'x' } } },
      ]),
    });

    const result = await client.complete([{ role: 'user', content: [textContent('call a tool')] }]);
    const body = buildGeminiGenerateContentBody(profile, [result.message]);

    expect(result.message.reasoning_content).toBe('private plan');
    expect(result.message.thinking_blocks).toEqual([{ type: 'thinking', thinking: 'private plan', signature: 'thought_sig_123' }]);
    expect(result.message.tool_calls).toEqual([
      { id: 'gemini_call_1', responses_item_id: null, name: 'lookup', arguments: '{"query":"x"}', origin: 'completion' },
    ]);
    expect(body.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(body.contents).toEqual([
      {
        role: 'model',
        parts: [{ functionCall: { name: 'lookup', args: { query: 'x' } }, thoughtSignature: 'thought_sig_123' }],
      },
    ]);
  });
});

interface FakeFetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function fakeGeminiFetch(response: { text: string }, calls: FakeFetchCall[] = []) {
  return async (url: string, init: { headers: Readonly<Record<string, string>>; body: string }) => {
    calls.push({ url, headers: normalizeHeaders(init.headers), body: JSON.parse(init.body) as Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { role: 'model', parts: [{ text: response.text }] } }],
          usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 8, totalTokenCount: 21 },
        };
      },
      async text() {
        return JSON.stringify(await this.json());
      },
    };
  };
}


function fakeGeminiPartsFetch(parts: readonly Record<string, unknown>[]) {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        candidates: [{ content: { role: 'model', parts } }],
        usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 8, totalTokenCount: 21 },
      };
    },
    async text() {
      return JSON.stringify(await this.json());
    },
  });
}

function normalizeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}
