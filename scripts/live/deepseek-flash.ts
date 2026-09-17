#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  Agent, FinishTool, LocalConversation, ToolDefinition,
  createClientFromProfile, messageSchema, metricsSnapshot, restoreConversationState, textContent,
  type ConversationStats, type Event,
} from '@smolpaws/openhands-agent';
import { createExampleLlmSecretStore, resolveExampleLlmProfile } from '../../examples/_shared/exampleProfile.js';

// A real-provider regression, separate from deterministic tests and parity oracles.
test('DeepSeek Flash: concurrent tools, restored continuation, and provider-exact usage', { timeout: 180_000 }, async (t) => {
  const profile = resolveExampleLlmProfile({
    profileId: 'live-deepseek-flash', providerId: 'deepseek',
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com', openAiApiMode: 'chat_completions',
    maxOutputTokens: 4096,
  });
  const store = createExampleLlmSecretStore(profile);
  assert.ok(store, 'Set DEEPSEEK_API_KEY to run the live test (missing credentials must fail, not skip).');
  let requests = 0;
  const providerResponses: ProviderUsageResponse[] = [];
  const client = await createClientFromProfile(profile, store, { fetch: async (url, init) => {
    assert.ok(++requests <= 12, 'live test exceeded its request budget');
    const response = await fetch(url, { ...init, signal: AbortSignal.any([t.signal, AbortSignal.timeout(45_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      // Provider errors can echo credentials. Never print response bodies or headers.
      throw new Error(`DeepSeek returned HTTP ${response.status}`);
    }
    // Keep only accounting metadata. Do not log or retain the body, prompts,
    // headers, or response content in test diagnostics.
    const metadata = providerUsageResponseSchema.safeParse(await response.clone().json());
    assert.ok(metadata.success, 'DeepSeek response must include id, model, and usage metadata');
    providerResponses.push(metadata.data);
    return response;
  } });

  const text = await client.complete([messageSchema.parse({ role: 'user', content: [textContent('Reply with exactly DEEPSEEK-SMOKE-OK.')] })]);
  assert.equal(text.message.content.filter(c => c.type === 'text').map(c => c.text).join('').trim(), 'DEEPSEEK-SMOKE-OK');

  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.signal.addEventListener('abort', () => release(), { once: true });
  let effects = 0;
  const tool = new ToolDefinition({
    name: 'slow_echo', description: 'Perform the requested echo once and return its result.',
    inputSchema: z.object({}), executor: async () => {
      effects += 1;
      entered();
      await gate;
      return { text: 'The echo completed once.', is_error: false };
    },
  });
  const makeAgent = () => new Agent({ llm: client, tools: [tool, FinishTool.create()] });
  const conversation = new LocalConversation({ agent: makeAgent(), maxIterations: 6 });
  conversation.sendMessage('First call slow_echo exactly once. After its result, obey the latest user message. Use finish for your final answer.');
  const run = conversation.run();
  try {
    await Promise.race([started, run.then(() => { throw new Error('Agent finished without calling slow_echo'); })]);
    await conversation.sendMessageAsync('This arrived while slow_echo was running. Do not call it again. After its result, use finish with exactly DEEPSEEK-OVERLAP-OK.');
  } finally { release(); }
  await run;
  assert.equal(conversation.state.executionStatus, 'finished');
  assert.equal(effects, 1, 'concurrent input must not repeat the tool');
  assertFinish(conversation.state.events, 'DEEPSEEK-OVERLAP-OK');
  // The first direct client call has no conversation and must not enter its ledger.
  assertAccounting(conversation.state.stats, providerResponses.slice(1));
  const firstMetrics = metricsSnapshot(conversation.state.stats);
  const firstRecordIds = Object.values(conversation.state.stats.usage_to_metrics).flatMap(m => m.records.map(r => r.record_id));

  // JSON round-trip the real events: the user must remain between action and observation.
  const snapshot = JSON.stringify(conversation.state.events);
  const saved = JSON.parse(snapshot) as Event[];
  const actionIndex = saved.findIndex(e => e.kind === 'ActionEvent' && e.tool_name === 'slow_echo');
  const resultIndex = saved.findIndex(e => e.kind === 'ObservationEvent' && e.tool_name === 'slow_echo');
  assert.ok(actionIndex >= 0 && resultIndex > actionIndex);
  assert.ok(saved.slice(actionIndex + 1, resultIndex).some(e => e.kind === 'MessageEvent' && e.source === 'user'));
  const restored = new LocalConversation({ agent: makeAgent(), state: restoreConversationState(saved).state, maxIterations: 4 });
  assert.deepEqual(metricsSnapshot(restored.state.stats), firstMetrics, 'restore must not add usage or cost');
  assertAccounting(restored.state.stats, providerResponses.slice(1));
  restored.sendMessage('Continue after restoring the conversation. Do not call slow_echo again. Use finish with exactly DEEPSEEK-RESTORE-OK.');
  await restored.run();
  assert.equal(restored.state.executionStatus, 'finished');
  assert.equal(effects, 1, 'restore must not repeat the completed tool');
  assertFinish(restored.state.events, 'DEEPSEEK-RESTORE-OK');
  assert.ok(JSON.stringify(conversation.state.events) === snapshot, 'original history must remain unchanged');
  assertAccounting(restored.state.stats, providerResponses.slice(1));
  const restoredRecordIds = Object.values(restored.state.stats.usage_to_metrics).flatMap(m => m.records.map(r => r.record_id));
  assert.deepEqual(restoredRecordIds.slice(0, firstRecordIds.length), firstRecordIds, 'existing call records must survive restore unchanged');
  assert.equal(providerResponses.length, requests);
  const metrics = metricsSnapshot(restored.state.stats);
  console.log(JSON.stringify({
    model: profile.model, requests, toolExecutions: effects, overlap: 'passed', restore: 'passed',
    usage: 'provider-exact', recordedCompletions: metrics.coverage.completion_count,
    calculatedCosts: metrics.cost_sources.calculated ?? 0, unknownCosts: metrics.coverage.missing_cost_count,
  }));
});

const providerUsageResponseSchema = z.object({
  id: z.string(), model: z.string(), usage: z.record(z.string(), z.unknown()),
});
type ProviderUsageResponse = z.infer<typeof providerUsageResponseSchema>;

const tokenFields = [
  ['prompt_tokens', 'promptTokens'], ['completion_tokens', 'completionTokens'], ['total_tokens', 'totalTokens'],
  ['cache_read_tokens', 'cacheReadTokens'], ['cache_write_tokens', 'cacheWriteTokens'], ['cache_miss_tokens', 'cacheMissTokens'],
  ['reasoning_tokens', 'reasoningTokens'], ['tool_use_prompt_tokens', 'toolUsePromptTokens'],
] as const;

function nativeTokenCounts(usage: ProviderUsageResponse['usage']) {
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | null | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | null | undefined;
  const count = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'native token counter must be a nonnegative integer');
    return value;
  };
  return {
    promptTokens: count(usage.prompt_tokens), completionTokens: count(usage.completion_tokens), totalTokens: count(usage.total_tokens),
    cacheReadTokens: count(usage.prompt_cache_hit_tokens ?? promptDetails?.cached_tokens),
    cacheWriteTokens: count(promptDetails?.cache_write_tokens), cacheMissTokens: count(usage.prompt_cache_miss_tokens),
    reasoningTokens: count(completionDetails?.reasoning_tokens), toolUsePromptTokens: undefined,
  };
}

function assertAccounting(stats: ConversationStats, responses: readonly ProviderUsageResponse[]): void {
  const records = Object.values(stats.usage_to_metrics).flatMap(m => m.records);
  assert.equal(records.length, responses.length, 'one ledger record per actual Agent completion');
  assert.equal(new Set(records.map(r => r.record_id)).size, records.length, 'call records need distinct local identities');
  // Compare by call order, not a map keyed by response ID: providers may reuse IDs.
  const expected = responses.map(response => nativeTokenCounts(response.usage));
  for (const [index, record] of records.entries()) {
    const response = responses[index]!;
    assert.equal(record.response_id, response.id);
    assert.equal(record.model, response.model);
    assert.deepEqual(record.usage?.providerUsage, response.usage, 'persisted provider usage must be exact');
    for (const [, field] of tokenFields) assert.equal(record.usage?.[field], expected[index]![field], `native ${field} must match`);
    if (record.cost !== null) {
      assert.equal(record.cost.source, 'calculated', 'DeepSeek supplies tokens; the SDK supplies a labeled estimate');
      assert.equal(record.cost.currency, 'USD');
      assert.equal(record.cost.pricing?.sourceUrl, 'https://api-docs.deepseek.com/quick_start/pricing/');
      assert.equal(typeof record.cost.pricing?.checkedAt, 'string');
      const quote = z.object({
        cachedInputPerMillion: z.number().nonnegative(), uncachedInputPerMillion: z.number().nonnegative(),
        outputPerMillion: z.number().nonnegative(),
      }).safeParse(record.cost.pricing?.rates);
      assert.ok(quote.success, 'calculated cost must retain the actual rates used');
      const counts = expected[index]!;
      assert.ok(counts.cacheReadTokens !== undefined && counts.completionTokens !== undefined);
      const miss = counts.cacheMissTokens ?? (counts.promptTokens === undefined ? undefined : counts.promptTokens - counts.cacheReadTokens);
      assert.ok(miss !== undefined && miss >= 0);
      const amount = (counts.cacheReadTokens * quote.data.cachedInputPerMillion
        + miss * quote.data.uncachedInputPerMillion + counts.completionTokens * quote.data.outputPerMillion) / 1_000_000;
      assert.equal(record.cost.amount, amount, 'calculated cost must use the actual provider token counts');
    }
  }
  const metrics = metricsSnapshot(stats);
  assert.equal(metrics.coverage.completion_count, responses.length);
  assert.equal(metrics.coverage.missing_usage_count, 0);
  assert.equal(metrics.coverage.unmeasured_history, false);
  for (const [field, nativeField] of tokenFields) {
    const known = expected.reduce((sum, counts) => sum + (counts[nativeField] ?? 0), 0);
    const missing = expected.filter(counts => counts[nativeField] === undefined).length;
    assert.equal(metrics.known_token_usage[field], known, `known ${field} must sum actual calls`);
    assert.equal(metrics.coverage.missing_fields[field], missing);
    assert.equal(metrics.accumulated_token_usage[field], missing > 0 ? null : known, `incomplete ${field} must remain unknown`);
  }
  const missingCosts = records.filter(record => record.cost === null).length;
  const knownCost = records.reduce((sum, record) => sum + (record.cost?.amount ?? 0), 0);
  assert.equal(metrics.coverage.missing_cost_count, missingCosts);
  assert.equal(metrics.cost_sources.calculated ?? 0, records.length - missingCosts);
  assert.equal(metrics.known_costs.USD ?? 0, knownCost);
  assert.equal(metrics.accumulated_cost, missingCosts > 0 ? null : knownCost);
}

function assertFinish(events: readonly Event[], expected: string): void {
  const finish = events.filter(e => e.kind === 'ActionEvent' && e.tool_name === 'finish').at(-1);
  assert.ok(finish?.kind === 'ActionEvent');
  assert.equal(finish.action.message, expected);
}
