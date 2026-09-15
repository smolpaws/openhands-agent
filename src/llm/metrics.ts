import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conversationStateUpdateEventSchema, type Event } from '../event/index.js';
import { llmUsageSchema, type LLMResponseMetadata } from './client.js';
import type { LLMProfile } from './index.js';
import { estimateUsageCost } from './pricing.js';

// Python persists full ConversationStats in base_state.json. The native SDK's
// EventLog is its durable store: record deltas here, project the upstream shape.
export const LLM_USAGE_KEY = 'llm_usage';
export const LLM_METRICS_RESET_KEY = 'llm_metrics_reset';
const costSchema = z.object({
  amount: z.number().finite().nonnegative(), currency: z.string().min(1),
  source: z.enum(['provider', 'calculated']), pricing: z.record(z.string(), z.unknown()).optional(),
}).strict();
const usageRecordSchema = z.object({
  version: z.literal(1), record_id: z.string().min(1), response_id: z.string().nullable(),
  usage_id: z.string().min(1), profile_id: z.string(), provider_id: z.string(),
  model: z.string(), requested_model: z.string(), timestamp: z.string().datetime(),
  latency: z.number().finite().nonnegative(), usage: llmUsageSchema.nullable(), cost: costSchema.nullable(),
}).strict();
export type UsageRecord = z.infer<typeof usageRecordSchema>;

const fields = {
  prompt_tokens: 'promptTokens', completion_tokens: 'completionTokens', total_tokens: 'totalTokens',
  cache_read_tokens: 'cacheReadTokens', cache_write_tokens: 'cacheWriteTokens',
  cache_miss_tokens: 'cacheMissTokens', reasoning_tokens: 'reasoningTokens', tool_use_prompt_tokens: 'toolUsePromptTokens',
} as const;
type TokenField = keyof typeof fields;
export type TokenUsage = Record<TokenField, number | null> & {
  model: string; response_id: string | null; context_window: number | null; per_turn_token: number | null;
};
export interface MetricsCoverage {
  completion_count: number;
  missing_usage_count: number;
  missing_cost_count: number;
  missing_fields: Record<TokenField, number>;
  unmeasured_history: boolean;
}
export interface MetricsSnapshot {
  model_name: string;
  accumulated_cost: number | null;
  max_budget_per_task: null;
  accumulated_token_usage: TokenUsage;
  known_token_usage: TokenUsage;
  known_costs: Record<string, number>;
  cost_sources: Record<string, number>;
  cache_hit_rate: number | null;
  coverage: MetricsCoverage;
}
export interface Metrics extends MetricsSnapshot {
  records: UsageRecord[];
  token_usages: TokenUsage[];
  costs: Array<{ model: string; cost: number | null; timestamp: number; source: string | null; currency: string | null; response_id: string | null; record_id: string }>;
  response_latencies: Array<{ model: string; latency: number; response_id: string | null; record_id: string }>;
}
export interface ConversationStats {
  usage_to_metrics: Record<string, Metrics>;
  coverage: { unmeasured_history: boolean; invalid_record_count: number; first_recorded_at: string | null };
}

export function createLlmUsageEvent(profile: LLMProfile, response: LLMResponseMetadata, timing: {
  startedAt: number; completedAt: number; usageId?: string;
}) {
  const recordId = randomUUID();
  const reported = response.usage?.reportedCost;
  const cost = reported === undefined
    ? estimateUsageCost(profile, response.usage, timing.startedAt, timing.completedAt, response.model)
    : { ...reported, source: 'provider' as const };
  const record = usageRecordSchema.parse({
    version: 1, record_id: recordId, response_id: response.responseId ?? null,
    usage_id: timing.usageId ?? `profile:${profile.profileId}`, profile_id: profile.profileId,
    provider_id: profile.providerId, model: response.model ?? profile.model, requested_model: profile.model,
    timestamp: new Date(timing.completedAt).toISOString(), latency: Math.max(0, timing.completedAt - timing.startedAt) / 1000,
    usage: structuredClone(response.usage), cost,
  });
  return conversationStateUpdateEventSchema.parse({ id: recordId, key: LLM_USAGE_KEY, value: record });
}

export function createMetricsResetEvent() {
  return conversationStateUpdateEventSchema.parse({ key: LLM_METRICS_RESET_KEY, value: { version: 1 } });
}

export function statsForEvents(events: readonly Event[]): ConversationStats {
  let records: UsageRecord[] = [];
  const seen = new Map<string, string>();
  const resets = new Set<string>();
  const responseIds = new Set<string>();
  let unmeasured = false;
  let invalid = 0;
  for (const event of events) {
    if (event.kind === 'ConversationStateUpdateEvent' && event.key === LLM_METRICS_RESET_KEY) {
      if (resets.has(event.id)) continue;
      resets.add(event.id);
      if (!z.object({ version: z.literal(1) }).strict().safeParse(event.value).success) {
        invalid += 1; unmeasured = true; continue;
      }
      records = []; responseIds.clear(); unmeasured = false; invalid = 0;
    } else if (event.kind === 'ConversationStateUpdateEvent' && event.key === LLM_USAGE_KEY) {
      const parsed = usageRecordSchema.safeParse(structuredClone(event.value));
      if (!parsed.success) { invalid += 1; unmeasured = true; continue; }
      const record = parsed.data;
      const fingerprint = JSON.stringify(record);
      if (seen.has(record.record_id)) {
        if (seen.get(record.record_id) !== fingerprint) { invalid += 1; unmeasured = true; }
        continue;
      }
      seen.set(record.record_id, fingerprint); responseIds.add(record.response_id ?? record.record_id); records.push(record);
    } else if (event.kind === 'ActionEvent' || (event.kind === 'MessageEvent' && event.source === 'agent')) {
      if (event.llm_response_id === null || !responseIds.has(event.llm_response_id)) unmeasured = true;
    }
  }
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.usage_id) ?? []; bucket.push(record); grouped.set(record.usage_id, bucket);
  }
  return {
    usage_to_metrics: Object.fromEntries([...grouped].map(([id, bucket]) => [id, metricsForRecords(bucket, unmeasured)])),
    coverage: { unmeasured_history: unmeasured, invalid_record_count: invalid, first_recorded_at: records[0]?.timestamp ?? null },
  };
}

export function metricsSnapshot(stats: ConversationStats): MetricsSnapshot {
  const records = Object.values(stats.usage_to_metrics).flatMap(metrics => metrics.records)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return compactMetrics(metricsForRecords(records, stats.coverage.unmeasured_history));
}

/** Per-usage compact wire updates, matching upstream's key="stats" serializer. */
export function statsSnapshot(stats: ConversationStats) {
  return structuredClone({ usage_to_metrics: Object.fromEntries(Object.entries(stats.usage_to_metrics).map(([id, metrics]) => {
    return [id, compactMetrics(metrics)];
  })), coverage: stats.coverage });
}

function compactMetrics(metrics: Metrics): MetricsSnapshot {
  return {
    model_name: metrics.model_name, accumulated_cost: metrics.accumulated_cost,
    max_budget_per_task: metrics.max_budget_per_task, accumulated_token_usage: metrics.accumulated_token_usage,
    known_token_usage: metrics.known_token_usage, known_costs: metrics.known_costs,
    cost_sources: metrics.cost_sources, cache_hit_rate: metrics.cache_hit_rate, coverage: metrics.coverage,
  };
}

function tokenUsage(record: UsageRecord): TokenUsage {
  const usage = record.usage;
  const counts = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, usage?.[field] ?? null])) as Record<TokenField, number | null>;
  return { ...counts, model: record.model, response_id: record.response_id, context_window: null,
    per_turn_token: usage?.promptTokens !== undefined && usage.completionTokens !== undefined ? usage.promptTokens + usage.completionTokens : null };
}

function metricsForRecords(records: UsageRecord[], unmeasured: boolean): Metrics {
  const models = new Set(records.map(record => record.model));
  const model = models.size === 1 ? records[0]!.model : models.size === 0 ? 'default' : 'mixed';
  const tokens = records.map(tokenUsage);
  const known = { model, response_id: null, context_window: null, per_turn_token: tokens.length === 0 ? 0 : tokens.at(-1)!.per_turn_token } as TokenUsage;
  const totals = { ...known };
  const missing = {} as Record<TokenField, number>;
  for (const field of Object.keys(fields) as TokenField[]) {
    missing[field] = tokens.filter(record => record[field] === null).length;
    known[field] = tokens.reduce((sum, record) => sum + (record[field] ?? 0), 0);
    totals[field] = unmeasured || missing[field] > 0 ? null : known[field];
  }
  if (unmeasured && records.length === 0) totals.per_turn_token = null;
  const knownCosts = Object.create(null) as Record<string, number>;
  const costSources = Object.create(null) as Record<string, number>;
  for (const record of records) if (record.cost !== null) {
    knownCosts[record.cost.currency] = (knownCosts[record.cost.currency] ?? 0) + record.cost.amount;
    costSources[record.cost.source] = (costSources[record.cost.source] ?? 0) + 1;
  }
  const missingCost = records.filter(record => record.cost === null).length;
  return {
    model_name: model, accumulated_cost: !unmeasured && missingCost === 0 && records.every(r => r.cost?.currency === 'USD') ? knownCosts.USD ?? 0 : null,
    max_budget_per_task: null, accumulated_token_usage: totals, known_token_usage: known,
    known_costs: knownCosts, cost_sources: costSources,
    cache_hit_rate: totals.prompt_tokens !== null && totals.prompt_tokens > 0 && totals.cache_read_tokens !== null
      && totals.cache_read_tokens <= totals.prompt_tokens ? totals.cache_read_tokens / totals.prompt_tokens : null,
    coverage: { completion_count: records.length, missing_usage_count: records.filter(r => r.usage === null).length,
      missing_cost_count: missingCost, missing_fields: missing, unmeasured_history: unmeasured },
    records, token_usages: tokens,
    costs: records.map(r => ({ model: r.model, cost: r.cost?.amount ?? null, timestamp: Date.parse(r.timestamp) / 1000,
      source: r.cost?.source ?? null, currency: r.cost?.currency ?? null, response_id: r.response_id, record_id: r.record_id })),
    response_latencies: records.map(r => ({ model: r.model, latency: r.latency, response_id: r.response_id, record_id: r.record_id })),
  };
}
