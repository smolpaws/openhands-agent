import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  actionEventSchema, agentErrorEventSchema, condensationRequestSchema, condensationSchema,
  conversationStateUpdateEventSchema, messageEventSchema, observationEventSchema,
  userRejectObservationSchema, type Event,
} from '../../event/index.js';
import { ManipulationIndices, View } from '../view.js';

type Recipe = {
  kind: string; id: string; call?: string; batch?: string; thinking?: boolean;
  forget?: string[]; summary?: string; offset?: number;
};
type Case = { name: string; source: string; events: Recipe[] };
type Expected = {
  name: string; event_ids: string[]; summaries: { id: string; summary: string }[];
  manipulation_indices: number[]; unhandled_condensation_request: boolean;
};
const cases: Case[] = JSON.parse(readFileSync(new URL('./fixtures/view-cases.json', import.meta.url), 'utf8'));
const oracle: { upstream_commit: string; cases: Expected[] } = JSON.parse(readFileSync(new URL('./fixtures/view-python-oracle.json', import.meta.url), 'utf8'));
const manifest: { commit: string } = JSON.parse(readFileSync(new URL('../../../transpile/upstream.json', import.meta.url), 'utf8'));

function buildEvent(recipe: Recipe): Event {
  const base = { id: recipe.id, timestamp: '2026-01-01T00:00:00Z' };
  switch (recipe.kind) {
    case 'message':
      return messageEventSchema.parse({ ...base, source: 'user', llm_message: { role: 'user', content: recipe.id } });
    case 'action':
      return actionEventSchema.parse({ ...base, action: {}, tool_name: 'test_tool', tool_call_id: recipe.call,
        llm_response_id: recipe.batch, tool_call: { id: recipe.call, name: 'test_tool', arguments: '{}', origin: 'completion' },
        thinking_blocks: recipe.thinking ? [{ type: 'thinking', thinking: 'Test thinking', signature: 'sig' }] : [] });
    case 'observation':
      return observationEventSchema.parse({ ...base, tool_name: 'test_tool', tool_call_id: recipe.call, action_id: recipe.call, observation: { content: [{ type: 'text', text: 'Success' }] } });
    case 'error':
      return agentErrorEventSchema.parse({ ...base, tool_name: 'test_tool', tool_call_id: recipe.call, error: 'Interrupted' });
    case 'reject':
      return userRejectObservationSchema.parse({ ...base, tool_name: 'test_tool', tool_call_id: recipe.call, action_id: recipe.call });
    case 'condensation':
      return condensationSchema.parse({ ...base, forgotten_event_ids: recipe.forget, summary: recipe.summary, summary_offset: recipe.offset, llm_response_id: `${recipe.id}-response` });
    case 'request':
      return condensationRequestSchema.parse(base);
    case 'state':
      return conversationStateUpdateEventSchema.parse({ ...base, key: 'test', value: {} });
    default:
      throw new Error(`Unknown event recipe kind: ${recipe.kind}`);
  }
}

describe('View pinned Python oracle', () => {
  it('uses the canonical source revision and every case', () => {
    expect(oracle.upstream_commit).toBe(manifest.commit);
    expect(oracle.cases.map((item) => item.name)).toEqual(cases.map((item) => item.name));
  });

  it.each(cases)('$name ($source)', (testCase) => {
    const events = testCase.events.map(buildEvent);
    const original = structuredClone(events);
    const expected = oracle.cases.find((item) => item.name === testCase.name)!;
    const view = View.fromEvents(events);

    expect(view.events.map((event) => event.id)).toEqual(expected.event_ids);
    expect(view.events.filter((event) => event.kind === 'CondensationSummaryEvent').map(({ id, summary }) => ({ id, summary }))).toEqual(expected.summaries);
    expect([...view.manipulationIndices]).toEqual(expected.manipulation_indices);
    expect(view.unhandledCondensationRequest).toBe(expected.unhandled_condensation_request);
    expect(events).toEqual(original);

    const replay = new View();
    for (const event of events) replay.appendEvent(event);
    replay.enforceProperties(events);
    expect(replay.events.map((event) => event.id)).toEqual(expected.event_ids);
    expect([...replay.manipulationIndices]).toEqual(expected.manipulation_indices);
  });
});

describe('View property enforcement', () => {
  it('keeps the full-log batch reference when the supplied history aliases the view', () => {
    const first = buildEvent({ kind: 'action', id: 'a1', call: 'a1', batch: 'batch' });
    const second = buildEvent({ kind: 'action', id: 'a2', call: 'a2', batch: 'batch' });
    const result = buildEvent({ kind: 'observation', id: 'o2', call: 'a2' });
    const view = View.fromEvents([]);
    for (const event of [first, second, result]) view.appendEvent(event);
    view.enforceProperties(view.events);
    expect(view.events).toEqual([]);
  });
});

describe('ManipulationIndices (pinned manipulation_indices.py)', () => {
  it.each([0, 1, 3])('complete includes both ends for %i events', (count) => {
    const events = Array.from({ length: count }, (_, index) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: `message ${index}` } }));
    expect([...ManipulationIndices.complete(events)]).toEqual(Array.from({ length: count + 1 }, (_, index) => index));
  });

  it.each([[-1, 0], [0, 0], [1, 4], [4, 4], [5, 8], [8, 8]])('findNext(%i) = %i', (threshold, next) => {
    expect(new ManipulationIndices([8, 0, 4]).findNext(threshold)).toBe(next);
  });

  it('rejects a missing boundary instead of splitting an atomic unit', () => {
    expect(() => new ManipulationIndices([0, 4]).findNext(5)).toThrow('No manipulation index found >= 5.');
    expect(() => new ManipulationIndices().findNext(0)).toThrow(RangeError);
  });
});
