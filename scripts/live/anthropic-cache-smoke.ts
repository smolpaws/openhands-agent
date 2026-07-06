#!/usr/bin/env tsx

import {
  createAnthropicClientFromProfile,
  llmProfileSchema,
  messageSchema,
  textContent,
  type FetchLike,
  type LLMCompletionResponse,
} from '@smolpaws/openhands-agent';

import { createExampleLlmSecretStore, providerApiKeyEnvName } from '../../examples/_shared/exampleProfile.js';

const MODEL = process.env.ANTHROPIC_MODEL?.trim() || process.env.LLM_MODEL?.trim() || 'claude-sonnet-4-5';
const MAX_OUTPUT_TOKENS = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS ?? 96);
const CACHEABLE_CONTEXT = Array.from({ length: 80 }, (_, index) => `Cache smoke line ${index + 1}: prompt caching format proof.`).join('\n');

const profile = llmProfileSchema.parse({
  profileId: process.env.LLM_PROFILE?.trim() || 'live-anthropic-cache-smoke',
  providerId: 'anthropic',
  model: MODEL,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
});
const maybeStore = createExampleLlmSecretStore(profile);
if (maybeStore === null) {
  console.log(`anthropic-cache-smoke: set ${providerApiKeyEnvName(profile.providerId)} to run this live prompt-cache smoke test.`);
  process.exit(0);
}
const store = maybeStore;

interface CapturedRequest {
  readonly cacheControlCount: number;
  readonly messageCount: number;
  readonly systemBlockCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countCacheControls(value: unknown): number {
  if (!isRecord(value) && !Array.isArray(value)) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControls(item), 0);
  }
  return Object.entries(value).reduce((sum, [key, child]) => sum + (key === 'cache_control' ? 1 : 0) + countCacheControls(child), 0);
}

function summarizeRequestBody(body: unknown): CapturedRequest {
  const payload = isRecord(body) ? body : {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = payload.system;
  return {
    cacheControlCount: countCacheControls(payload),
    messageCount: messages.length,
    systemBlockCount: Array.isArray(system) ? system.length : system === undefined ? 0 : 1,
  };
}

function makeFetch(capturedRequests: CapturedRequest[]): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(String(init.body)) as unknown;
    capturedRequests.push(summarizeRequestBody(body));
    const response = await fetch(url, init);
    const responseText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      async json() {
        return JSON.parse(responseText) as unknown;
      },
      async text() {
        return responseText;
      },
    };
  };
}

function usageSummary(response: LLMCompletionResponse): Record<string, unknown> {
  const usage = isRecord(response.raw) && isRecord(response.raw.usage) ? response.raw.usage : {};
  return {
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
  };
}

const capturedRequests: CapturedRequest[] = [];
const client = await createAnthropicClientFromProfile(profile, store, { fetch: makeFetch(capturedRequests) });
const prompt = `${CACHEABLE_CONTEXT}\n\nReply with exactly: cache-smoke-ready`;
const messages = [messageSchema.parse({ role: 'user', content: [textContent(prompt, true)] })];

const first = await client.complete(messages);
const second = await client.complete(messages);
const requestCacheControlCounts = capturedRequests.map((request) => request.cacheControlCount);
if (!requestCacheControlCounts.every((count) => count > 0)) {
  throw new Error(`Expected Anthropic request bodies to include cache_control; got ${requestCacheControlCounts.join(',')}`);
}

const output = {
  providerId: profile.providerId,
  model: profile.model,
  requestCacheControlCounts,
  requests: capturedRequests,
  firstUsage: usageSummary(first),
  secondUsage: usageSummary(second),
  cacheReadObserved: Number(usageSummary(second).cacheReadInputTokens ?? 0) > 0,
};

console.log(JSON.stringify(output, null, 2));
