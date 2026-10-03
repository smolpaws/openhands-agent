import { describe, expect, it } from 'vitest';
import { condensationSchema, conversationStateUpdateEventSchema, messageEventSchema, type Event } from '../../event/index.js';
import { llmProfileSchema, messageSchema } from '../index.js';
import { createLlmUsageEvent, llmHistoryOrigin } from '../metrics.js';
import { latestReportedInputTokens } from '../reported-input.js';
import { requestBoundaryEvent } from '../request-history.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'gpt-5', maxInputTokens: 1000 });
const response = (promptTokens: number | undefined) => ({
  responseId: 'reused-provider-id', message: messageSchema.parse({ role: 'assistant', content: 'Hello' }),
  usage: { ...(promptTokens === undefined ? {} : { promptTokens }), totalTokens: 9000, completionTokens: 8000 },
});
const usage = (tokens: number | undefined, succeeded = true, selected = profile, usageId?: string) =>
  createLlmUsageEvent(selected, response(tokens), { startedAt: 0, completedAt: 1,
    requestSucceeded: succeeded, ...(usageId === undefined ? {} : { usageId }) });

describe('latest successful main input report', () => {
  it('uses the last request, not cumulative totals or reusable provider IDs', () => {
    expect(latestReportedInputTokens([usage(750), usage(870)], profile)).toBe(870);
  });
  it('keeps reported zero distinct from missing usage or no successful request', () => {
    expect(latestReportedInputTokens([usage(0)], profile)).toBe(0);
    expect(latestReportedInputTokens([usage(750), usage(undefined)], profile)).toBeNull();
    expect(latestReportedInputTokens([], profile)).toBeUndefined();
  });
  it('ignores failed requests and auxiliary reports, even for an identical profile', () => {
    expect(latestReportedInputTokens([usage(750), usage(990, false), usage(5000, true, profile, 'condenser')], profile)).toBe(750);
  });
  it('does not reuse an old binding after a profile or endpoint switch', () => {
    const changed = { ...profile, baseUrl: 'https://different.test/v1' };
    expect(latestReportedInputTokens([usage(750)], changed)).toBeUndefined();
    expect(latestReportedInputTokens([usage(750)], { ...profile, profileId: 'other' })).toBeUndefined();
  });
  it('invalidates only on committed condensation, not a metrics reset', () => {
    const statsReset = conversationStateUpdateEventSchema.parse({ key: 'llm_metrics_reset', value: { version: 1 } });
    expect(latestReportedInputTokens([usage(750), statsReset], profile)).toBe(750);
    expect(latestReportedInputTokens([usage(750), condensationSchema.parse({ forgotten_event_ids: [] })], profile)).toBeUndefined();
  });
  it('does not associate failed legacy accounting with another binding or a partial response boundary', () => {
    const legacy = createLlmUsageEvent(profile, response(870), { startedAt: 0, completedAt: 1 });
    const output = messageEventSchema.parse({ source: 'agent', llm_message: response(870).message });
    const marker = requestBoundaryEvent(null, [output]);
    expect(latestReportedInputTokens([legacy, marker], profile)).toBeUndefined();
    expect(latestReportedInputTokens([legacy, usage(200, true, { ...profile, profileId: 'other' }), marker, output], profile)).toBeUndefined();
  });
  it('rejects unanchored legacy accounting from a different persisted endpoint origin', () => {
    const legacy = createLlmUsageEvent(profile, response(870), { startedAt: 0, completedAt: 1 });
    const value = legacy.value as Record<string, unknown>;
    delete value.history_origin;
    const output = messageEventSchema.parse({ source: 'agent', llm_message: response(870).message });
    const anchor = conversationStateUpdateEventSchema.parse({ key: 'llm_history_origin', value: { version: 1, origin: llmHistoryOrigin(profile) } });
    expect(latestReportedInputTokens([legacy, requestBoundaryEvent(null, [output]), output, anchor], { ...profile, baseUrl: 'https://different.test/v1' })).toBeUndefined();
  });
  it('reads successful legacy accounting through its completed boundary and survives serialized fork history', () => {
    const legacy = createLlmUsageEvent(profile, response(870), { startedAt: 0, completedAt: 1 });
    const output = messageEventSchema.parse({ source: 'agent', llm_message: response(870).message, llm_response_id: 'reused-provider-id' });
    expect(latestReportedInputTokens([legacy], profile)).toBeUndefined();
    const events: Event[] = [legacy, requestBoundaryEvent(null, [output]), output];
    expect(latestReportedInputTokens(JSON.parse(JSON.stringify(events)), profile)).toBe(870);
  });
});
