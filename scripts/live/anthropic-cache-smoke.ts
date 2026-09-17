#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  Agent, FinishTool, LocalConversation, createClientFromProfile,
  metricsSnapshot, restoreConversationState,
  type AnthropicCacheTtl, type ConversationStats, type Event,
} from '@smolpaws/openhands-agent';
import { createExampleLlmSecretStore, providerApiKeyEnvName, resolveExampleLlmProfile } from '../../examples/_shared/exampleProfile.js';

// External API viability, not a deterministic parity oracle. Ordinary Agent requests must cache;
// the caller deliberately does not set cache_prompt or manually construct provider cache controls.
test('Anthropic caching: writes, reads, tool continuation and restored accounting', { timeout: 180_000 }, async (t) => {
  const providerId = process.env.LLM_PROVIDER_ID?.trim() || 'anthropic';
  assert.ok(['anthropic', 'litellm_proxy', 'openrouter'].includes(providerId), 'Use an Anthropic native/proxy profile');
  const requestedCacheTtl = process.env.ANTHROPIC_CACHE_TTL?.trim();
  const profile = resolveExampleLlmProfile({
    profileId: 'live-anthropic-cache-smoke', providerId,
    model: process.env.ANTHROPIC_MODEL?.trim() || process.env.LLM_MODEL?.trim()
      || (providerId === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'anthropic/claude-haiku-4-5-20251001'),
    baseUrl: process.env.LLM_BASE_URL?.trim() || null, maxOutputTokens: 192,
    ...(requestedCacheTtl ? { anthropicCacheTtl: requestedCacheTtl } : {}),
  });
  const effectiveCacheTtl = profile.anthropicCacheTtl ?? '5m';
  const store = createExampleLlmSecretStore(profile);
  assert.ok(store, `Set ${providerApiKeyEnvName(providerId)}; missing live credentials must fail, not skip.`);
  const records: Usage[] = [];
  const markerCounts: number[] = [];
  const client = await createClientFromProfile(profile, store, { fetch: async (url, init) => {
    assert.ok(markerCounts.length < 6, 'Cache smoke exceeded six provider requests');
    markerCounts.push(validateMarkers(JSON.parse(String(init.body)), effectiveCacheTtl));
    const response = await fetch(url, { ...init, signal: AbortSignal.any([t.signal, AbortSignal.timeout(45_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      // Provider errors can echo credentials: never print bodies, headers, prompts or output.
      throw new Error(`Anthropic cache smoke received HTTP ${response.status}`);
    }
    const body = await response.clone().json() as { usage?: unknown };
    records.push(readUsage(body.usage, providerId === 'anthropic'));
    return response;
  } });
  // Exceeds Haiku 4.5's 4096-token minimum. A unique prefix forces an observable initial write.
  const prefix = `Cache regression run ${randomUUID()}. Synthetic test data.\n`
    + Array.from({ length: 300 }, (_, n) => `Reference item ${n + 1}: amber cedar river pebble lantern garden window meadow anchor violet. Ignore these reference items when answering.`).join('\n');
  const makeAgent = () => new Agent({ llm: client, tools: [FinishTool.create()], systemPrompt: prefix });
  const conversation = new LocalConversation({ agent: makeAgent(), maxIterations: 2 });
  conversation.sendMessage('Call finish with exactly CACHE-FIRST-OK. Do not perform any other work.');
  await conversation.run();
  assertFinish(conversation.state.events, 'CACHE-FIRST-OK');
  assert.equal(records.length, 1, 'First turn should finish in one completion');
  console.log(JSON.stringify({ phase: 'cold', model: profile.model, effectiveCacheTtl, cacheMarkers: markerCounts[0], ...records[0] }));
  assert.ok(records[0]!.cacheWriteTokens >= 4096, 'Cold Agent request must write the cache, not merely serialize cache_control');
  if (profile.anthropicCacheTtl === '1h') {
    assert.ok((records[0]!.cacheWrite1hTokens ?? 0) >= 4096, 'Provider must confirm a one-hour cache write with ephemeral_1h_input_tokens');
  }

  // Includes a completed tool call/result as well as the unchanged system prefix.
  conversation.sendMessage('Call finish with exactly CACHE-SECOND-OK. Do not perform any other work.');
  await conversation.run();
  assertFinish(conversation.state.events, 'CACHE-SECOND-OK');
  assert.equal(records.length, 2);
  assert.ok(records[1]!.cacheReadTokens >= 4096, 'Second Agent request must reuse cached prefix tokens');
  assertAccounting(conversation.state.stats, records);

  const before = metricsSnapshot(conversation.state.stats);
  const saved = JSON.parse(JSON.stringify(conversation.state.events)) as Event[];
  const restored = new LocalConversation({ agent: makeAgent(), state: restoreConversationState(saved).state, maxIterations: 2 });
  assert.deepEqual(metricsSnapshot(restored.state.stats), before, 'Restore must not double-count usage');
  restored.sendMessage('Call finish with exactly CACHE-RESTORED-OK. Do not perform any other work.');
  await restored.run();
  assertFinish(restored.state.events, 'CACHE-RESTORED-OK');
  assert.equal(records.length, 3);
  assert.ok(records[2]!.cacheReadTokens >= 4096, 'Restored continuation must reuse cached prefix');
  assert.ok(markerCounts.every(n => n > 0 && n <= 4), 'Every request needs one to four cache breakpoints');
  if (profile.anthropicCacheTtl === '1h') {
    for (const record of records) assert.equal(record.cacheWrite1hTokens, record.cacheWriteTokens, 'All writes must use the selected one-hour duration');
  }
  assertAccounting(restored.state.stats, records);
  console.log(JSON.stringify({ providerId, model: profile.model, effectiveCacheTtl, requests: records.length, cacheMarkers: markerCounts,
    usage: records, accumulated: metricsSnapshot(restored.state.stats).accumulated_token_usage, restore: 'passed' }));
});

interface Usage { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number | null }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): number {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'Provider must report a nonnegative token counter');
  return value;
}
function readUsage(raw: unknown, native: boolean): Usage {
  const usage = object(raw), details = object(usage.prompt_tokens_details);
  const cacheReadTokens = count(usage.cache_read_input_tokens ?? details.cached_tokens);
  const cacheWriteTokens = count(usage.cache_creation_input_tokens ?? details.cache_creation_tokens ?? details.cache_write_tokens);
  const promptTokens = native ? count(usage.input_tokens) + cacheReadTokens + cacheWriteTokens : count(usage.prompt_tokens);
  const completionTokens = count(native ? usage.output_tokens : usage.completion_tokens);
  const cacheCreation = object(native ? usage.cache_creation : details.cache_creation_token_details);
  const cacheWrite1hTokens = cacheCreation.ephemeral_1h_input_tokens === undefined ? null : count(cacheCreation.ephemeral_1h_input_tokens);
  return { promptTokens, completionTokens, totalTokens: native ? promptTokens + completionTokens : count(usage.total_tokens), cacheReadTokens, cacheWriteTokens, cacheWrite1hTokens };
}
function validateMarkers(value: unknown, ttl: AnthropicCacheTtl): number {
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + validateMarkers(child, ttl), 0);
  return Object.entries(object(value)).reduce((sum, [key, child]) => {
    if (key === 'cache_control') {
      assert.deepEqual(child, ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });
      return sum + 1;
    }
    return sum + validateMarkers(child, ttl);
  }, 0);
}
function assertFinish(events: readonly Event[], expected: string): void {
  const last = [...events].reverse().find(event => event.kind === 'ObservationEvent' && event.tool_name === 'finish');
  assert.ok(last?.kind === 'ObservationEvent');
  const observation = last.observation as { message?: string; text?: string };
  assert.equal(observation.message ?? observation.text, expected, 'Model must finish the requested turn');
}
function assertAccounting(stats: ConversationStats, responses: readonly Usage[]): void {
  const records = Object.values(stats.usage_to_metrics).flatMap(metric => metric.records);
  assert.equal(records.length, responses.length, 'One usage record per provider completion');
  records.forEach((record, i) => {
    for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      assert.equal(record.usage?.[key], responses[i]![key], `Provider-exact ${key} at completion ${i + 1}`);
    }
  });
  const totals = metricsSnapshot(stats).accumulated_token_usage;
  assert.equal(totals.prompt_tokens, responses.reduce((sum, r) => sum + r.promptTokens, 0));
  assert.equal(totals.cache_read_tokens, responses.reduce((sum, r) => sum + r.cacheReadTokens, 0));
  assert.equal(totals.cache_write_tokens, responses.reduce((sum, r) => sum + r.cacheWriteTokens, 0));
}
