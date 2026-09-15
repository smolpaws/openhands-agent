import { describe, expect, it } from 'vitest';
import { Agent } from '../../agent/agent.js';
import { LocalConversation } from '../local-conversation.js';
import { ConversationState } from '../state.js';
import { restoreConversationState } from '../restore.js';
import { messageSchema, llmProfileSchema } from '../../llm/index.js';
import type { LLMClient, LLMCompletionResponse } from '../../llm/client.js';
import { createLlmUsageEvent, createMetricsResetEvent, metricsSnapshot, statsForEvents } from '../../llm/metrics.js';
import { conversationStateUpdateEventSchema, messageEventSchema } from '../../event/index.js';
import { FinishTool, ThinkTool } from '../../tool/builtins.js';
import { EventLog } from '../event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { OpenAIChatClient } from '../../llm/openai.js';

// Adapted from pinned test_llm_metrics.py and test_conversation_stats.py.
const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'requested-model' });
const response = (prompt: number, completion: number, extra = {}): LLMCompletionResponse => ({
  message: messageSchema.parse({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }),
  usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, ...extra },
  ...{ responseId: 'provider-reuses-this-id', model: 'served-model' },
});
const client = (responses: LLMCompletionResponse[]): LLMClient => ({ profile, complete: async () => {
  const next = responses.shift(); if (!next) throw new Error('unexpected completion'); return next;
} });

describe('durable provider accounting', () => {
  it('records per-call deltas once, and accumulates after restoring instead of adding a cumulative snapshot', async () => {
    const llm = client([response(100, 50), response(200, 100)]);
    const first = new LocalConversation({ agent: new Agent({ llm }) });
    first.sendMessage('First'); await first.run();
    expect((first.state as unknown as { stats?: unknown }).stats, 'metrics must survive the response dispatcher').toBeDefined();
    const saved = JSON.stringify(first.state.events);
    const restored = restoreConversationState(JSON.parse(saved)).state;
    const next = new LocalConversation({ agent: new Agent({ llm }), state: restored });
    next.sendMessage('Second'); await next.run();
    const bucket = next.state.stats.usage_to_metrics['profile:test']!;
    expect(bucket.token_usages.map(u => u.prompt_tokens)).toEqual([100, 200]);
    expect(bucket.accumulated_token_usage.prompt_tokens).toBe(300);
    expect(bucket.accumulated_token_usage.completion_tokens).toBe(150);
    expect(bucket.accumulated_token_usage.per_turn_token).toBe(300);
    expect(bucket.records[0]?.record_id).not.toBe(bucket.records[1]?.record_id);
    expect(bucket.records.map(r => r.response_id)).toEqual(['provider-reuses-this-id', 'provider-reuses-this-id']);
    const accounting = next.state.events.filter(e => e.kind === 'ConversationStateUpdateEvent' && e.key === 'llm_usage');
    const replayed = new ConversationState({ events: [...next.state.events, ...accounting] });
    expect(replayed.stats).toEqual(next.state.stats);
    expect(JSON.stringify(first.state.events)).toBe(saved);
  });

  it('keeps missing token/cost fields distinct from explicit zero and preserves known subtotals', async () => {
    const llm = client([response(10, 2, { cacheReadTokens: 0, reportedCost: { amount: 0, currency: 'USD' } }), response(20, 3)]);
    const conversation = new LocalConversation({ agent: new Agent({ llm }) });
    conversation.sendMessage('First'); await conversation.run();
    const before = conversation.state.stats.usage_to_metrics['profile:test']!;
    expect(before.accumulated_cost).toBe(0);
    expect(before.accumulated_token_usage.cache_read_tokens).toBe(0);
    conversation.sendMessage('Second'); await conversation.run();
    const after = conversation.state.stats.usage_to_metrics['profile:test']!;
    expect(after.accumulated_cost).toBeNull();
    expect(after.accumulated_token_usage.cache_read_tokens).toBeNull();
    expect(after.accumulated_token_usage.prompt_tokens).toBe(30);
    expect(after.coverage.missing_cost_count).toBe(1);
    expect(after.known_costs.USD).toBe(0);
    expect(before.token_usages).toHaveLength(1); // Prior snapshots stay immutable.
  });

  it('charges a completion once when it dispatches multiple tools', async () => {
    const completion = response(50, 12);
    completion.message = messageSchema.parse({ role: 'assistant', tool_calls: [
      { id: 'think', name: 'think', arguments: JSON.stringify({ thought: 'Done' }), origin: 'completion' },
      { id: 'finish', name: 'finish', arguments: JSON.stringify({ message: 'Done' }), origin: 'completion' },
    ] });
    delete completion.responseId;
    const conversation = new LocalConversation({ agent: new Agent({ llm: client([completion]), tools: [ThinkTool.create(), FinishTool.create()] }) });
    conversation.sendMessage('Complete'); await conversation.run();
    const stats = conversation.state.stats;
    const actions = conversation.state.events.filter(e => e.kind === 'ActionEvent');
    expect(actions).toHaveLength(2);
    expect(stats.usage_to_metrics['profile:test']!.coverage.completion_count).toBe(1);
    expect(stats.coverage.unmeasured_history).toBe(false);
    expect(new Set(actions.map(e => e.llm_response_id)).size).toBe(1);
    expect(metricsSnapshot(stats).accumulated_token_usage.total_tokens).toBe(62);
  });

  it('retains missing latest counts and never invents usage for a failed network call', async () => {
    const unknown = response(1, 1); unknown.usage = null;
    const conversation = new LocalConversation({ agent: new Agent({ llm: client([response(10, 2), unknown]) }) });
    conversation.sendMessage('First'); await conversation.run();
    conversation.sendMessage('Second'); await conversation.run();
    const metrics = metricsSnapshot(conversation.state.stats);
    expect(metrics.coverage).toMatchObject({ completion_count: 2, missing_usage_count: 1 });
    expect(metrics.accumulated_token_usage).toMatchObject({ prompt_tokens: null, per_turn_token: null });
    const failed = new Agent({ llm: { profile, complete: async () => { throw new Error('network failed'); } } });
    const before = structuredClone(conversation.state.stats);
    await expect(failed.step(conversation.state)).rejects.toThrow('network failed');
    expect(conversation.state.stats).toEqual(before);
  });

  it('records a received billable response even if its message cannot be parsed', async () => {
    const raw = { id: 'invalid-content', model: 'served-model', choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    const llm = new OpenAIChatClient(profile, 'test-key', async () => ({
      ok: true, status: 200, json: async () => raw, text: async () => JSON.stringify(raw),
    }));
    const state = new ConversationState();
    await expect(new Agent({ llm }).step(state)).rejects.toThrow('invalid or incomplete LLM response');
    const restored = restoreConversationState(JSON.parse(JSON.stringify(state.events))).state;
    const metrics = metricsSnapshot(restored.stats);
    expect(metrics.coverage.completion_count).toBe(1);
    expect(metrics.accumulated_token_usage.total_tokens).toBe(12);
    expect(state.events.some(e => e.kind === 'MessageEvent' || e.kind === 'ActionEvent')).toBe(false);
  });

  it('separates usage buckets and retains the actual model on every call', () => {
    const a = usageEvent(response(10, 2), 'agent');
    const b = usageEvent({ ...response(20, 3), model: 'another-model' }, 'condenser');
    const stats = statsForEvents([a, b]);
    expect(Object.keys(stats.usage_to_metrics)).toEqual(['agent', 'condenser']);
    expect(stats.usage_to_metrics.agent!.model_name).toBe('served-model');
    expect(metricsSnapshot(stats).model_name).toBe('mixed');
    expect(metricsSnapshot(stats).accumulated_token_usage.prompt_tokens).toBe(30);
  });

  it('isolates nested provider metadata from both response and snapshot mutation', () => {
    const completion = response(10, 2, { providerUsage: { details: { cached: 5 } } });
    const event = usageEvent(completion);
    const original = JSON.stringify(event);
    (completion.usage!.providerUsage!.details as { cached: number }).cached = 99;
    const stats = statsForEvents([event]);
    (stats.usage_to_metrics['profile:test']!.records[0]!.usage!.providerUsage!.details as { cached: number }).cached = 100;
    expect(JSON.stringify(event)).toBe(original);
    expect(statsForEvents([event]).usage_to_metrics['profile:test']!.records[0]!.usage!.providerUsage).toEqual({ details: { cached: 5 } });
  });

  it('round-trips unknown usage, cost, response ID and native null fields through EventLog', () => {
    const missing = response(0, 0); missing.usage = null; delete missing.responseId;
    const native = response(1, 2, { providerUsage: { details: null, nested: { value: null } } });
    const store = new InMemoryFileStore();
    const log = new EventLog(store);
    log.append(usageEvent(missing)); log.append(usageEvent(native));
    const original = statsForEvents(log.toArray());
    const restored = statsForEvents(new EventLog(store).toArray());
    expect(restored).toEqual(original);
    const records = restored.usage_to_metrics['profile:test']!.records;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ usage: null, cost: null, response_id: null });
    expect(records[1]!.usage!.providerUsage).toEqual(native.usage!.providerUsage);
    expect(restored.coverage.invalid_record_count).toBe(0);
  });

  it('marks pre-accounting history unknown, but starts a fresh valid fork baseline exactly once', () => {
    const legacy = messageEventSchema.parse({ source: 'agent', llm_message: response(0, 0).message });
    const old = usageEvent(response(10, 2));
    const current = usageEvent(response(20, 3));
    const reset = createMetricsResetEvent();
    expect(metricsSnapshot(statsForEvents([legacy, old])).accumulated_token_usage.prompt_tokens).toBeNull();
    expect(metricsSnapshot(statsForEvents([legacy, old])).known_token_usage.prompt_tokens).toBe(10);
    const fork = statsForEvents([legacy, old, reset, current, reset, old]);
    expect(metricsSnapshot(fork).accumulated_token_usage.prompt_tokens).toBe(20);
    expect(fork.coverage.unmeasured_history).toBe(false);
    const invalidReset = conversationStateUpdateEventSchema.parse({ key: 'llm_metrics_reset', value: { version: 2 } });
    const invalid = statsForEvents([old, invalidReset]);
    expect(metricsSnapshot(invalid).known_token_usage.prompt_tokens).toBe(10);
    expect(invalid.coverage).toMatchObject({ invalid_record_count: 1, unmeasured_history: true });
  });

  it('flags conflicting duplicate records and safely groups provider cost units', () => {
    const first = usageEvent(response(10, 2, { reportedCost: { amount: 1, currency: 'constructor' } }));
    const conflicting = structuredClone(first);
    (conflicting.value as { usage: { promptTokens: number } }).usage.promptTokens = 11;
    const valid = statsForEvents([first]);
    expect(metricsSnapshot(valid).known_costs.constructor).toBe(1);
    expect(metricsSnapshot(valid).accumulated_cost).toBeNull();
    const invalid = statsForEvents([first, conflicting]);
    expect(invalid.coverage).toMatchObject({ invalid_record_count: 1, unmeasured_history: true });
    expect(metricsSnapshot(invalid).known_token_usage.prompt_tokens).toBe(10);
  });
});

function usageEvent(completion: LLMCompletionResponse, usageId?: string) {
  return createLlmUsageEvent(profile, completion, { startedAt: 1_000, completedAt: 2_000, ...(usageId === undefined ? {} : { usageId }) });
}
