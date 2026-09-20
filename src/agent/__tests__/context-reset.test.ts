import { describe, expect, it, vi } from 'vitest';

import { LLMSummarizingCondenser } from '../../context/llm-summarizing-condenser.js';
import { View } from '../../context/view.js';
import { ConversationState } from '../../conversation/state.js';
import { EventLog } from '../../conversation/event-log.js';
import { actionEventSchema, condensationRequestSchema, condensationSchema, messageEventSchema, type Event } from '../../event/index.js';
import { InMemoryFileStore } from '../../io/index.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';
import { requestBoundaryEvent, unconsumedUserEventIds } from '../../llm/request-history.js';
import { CondenseTool } from '../../tool/condense.js';
import { CONDENSATION_FAILURE_KEY, executeCondenseTool, finishPendingContextReset, recoverContextWindow } from '../context-reset.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'test' });
const main = { profile, complete: vi.fn() };
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });
const assistant = (text = 'Done') => messageEventSchema.parse({ source: 'agent', llm_message: { role: 'assistant', content: text } });
const successfulHistory = () => {
  const input = user('Old consumed work');
  const reply = assistant();
  return [input, requestBoundaryEvent(input.id, [reply]), reply];
};
function persisted(events: readonly Event[] = successfulHistory()) {
  const store = new InMemoryFileStore();
  const state = new ConversationState({ eventLog: new EventLog(store), events });
  return { state, restore: () => new ConversationState({ eventLog: new EventLog(store) }) };
}
const summary = (view: View) => condensationSchema.parse({
  forgotten_event_ids: view.events.map(event => event.id), summary: 'Saved old work', summary_offset: 0,
});

function recover(state: ConversationState, hardContextReset: Parameters<typeof recoverContextWindow>[4]['hardContextReset']) {
  const history = [...state.events];
  return recoverContextWindow(state, history, history.at(-1)?.id ?? null, main, { hardContextReset }, {});
}

describe('completed request input protection', () => {
  it('recognizes a complete assistant response with its environment corrective nudge', () => {
    const old = user('Seen by the model');
    const reply = assistant('');
    const nudge = messageEventSchema.parse({ source: 'environment', llm_message: { role: 'user', content: 'Use a tool.' } });
    const fresh = user('Not seen by the model');
    const history = [old, requestBoundaryEvent(old.id, [reply, nudge]), reply, nudge, fresh];
    expect(unconsumedUserEventIds(View.fromEvents(history).events, history)).toEqual(new Set([fresh.id]));
  });

  it('does not claim user input was consumed by an agent-source message with a user role', () => {
    const input = user('Keep the request');
    const invalid = messageEventSchema.parse({ source: 'agent', llm_message: { role: 'user', content: 'Not a model response' } });
    const history = [input, requestBoundaryEvent(input.id, [invalid]), invalid];
    expect(unconsumedUserEventIds(View.fromEvents(history).events, history)).toEqual(new Set([input.id]));
  });

  it.each(['partial', 'duplicate', 'before-marker', 'environment-only'])('keeps input with an invalid %s response boundary', variant => {
    const input = user('Still pending');
    const reply = assistant();
    const nudge = messageEventSchema.parse({ source: 'environment', llm_message: { role: 'user', content: 'Nudge' } });
    const marker = requestBoundaryEvent(input.id, variant === 'duplicate' ? [reply, reply] : variant === 'environment-only' ? [nudge] : [reply]);
    const history = variant === 'partial' ? [input, marker]
      : variant === 'before-marker' ? [input, reply, marker]
      : [input, marker, variant === 'environment-only' ? nudge : reply];
    expect(unconsumedUserEventIds(View.fromEvents(history).events, history)).toEqual(new Set([input.id]));
  });
});

describe('durable hard recovery attempt bounds', () => {
  it('does not repeat a failed paid operation after fresh EventLog restore', async () => {
    const { state, restore } = persisted();
    const original = structuredClone(View.fromEvents(state.events).events);
    const failure = new Error('private provider detail');
    const hard = vi.fn(async () => { throw failure; });
    await expect(recover(state, hard)).rejects.toBe(failure);
    await expect(recover(restore(), hard)).rejects.toThrow(/recovery|condensation/i);
    expect(hard).toHaveBeenCalledTimes(1);
    expect(state.events.some(event => event.kind === 'Condensation')).toBe(false);
    expect(View.fromEvents(restore().events).events).toEqual(original);
  });

  it('records a stable failure message while propagating the original provider error', async () => {
    const { state } = persisted();
    const failure = new Error('Authorization: Bearer private-test-sentinel');
    await expect(recover(state, async () => { throw failure; })).rejects.toBe(failure);
    const records = state.events.filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === CONDENSATION_FAILURE_KEY);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('private-test-sentinel');
  });

  it.each([null, '', '   '])('preserves history and bounds retries for unusable summary %s', async text => {
    const { state, restore } = persisted();
    const original = structuredClone(View.fromEvents(state.events).events);
    const hard = vi.fn(async (view: View) => text === null ? null : condensationSchema.parse({
      forgotten_event_ids: view.events.map(event => event.id), summary: text, summary_offset: 0,
    }));
    await expect(recover(state, hard)).rejects.toThrow('usable summary');
    await expect(recover(restore(), hard)).rejects.toThrow(/recovery|condensation/i);
    expect(hard).toHaveBeenCalledTimes(1);
    expect(View.fromEvents(restore().events).events).toEqual(original);
  });

  it('does not replay paid work when the failure marker itself could not be persisted', async () => {
    const { state, restore } = persisted();
    const append = state.appendEventAsync.bind(state);
    vi.spyOn(state, 'appendEventAsync').mockImplementation(async event => {
      if (event.kind === 'ConversationStateUpdateEvent' && event.key === CONDENSATION_FAILURE_KEY) throw new Error('failure marker unavailable');
      return append(event);
    });
    const hard = vi.fn(async () => { throw new Error('provider rejected summary'); });
    await expect(recover(state, hard)).rejects.toThrow('failure marker unavailable');
    const restored = restore();
    await expect(finishPendingContextReset(restored)).rejects.toThrow('interrupted');
    await expect(recover(restore(), hard)).rejects.toThrow(/recovery|condensation/i);
    expect(hard).toHaveBeenCalledTimes(1);
  });

  it('keeps a durable commit valid when its acknowledgement fails', async () => {
    const { state, restore } = persisted();
    const append = state.appendEventAsync.bind(state);
    vi.spyOn(state, 'appendEventAsync').mockImplementation(async event => {
      const result = await append(event);
      if (event.kind === 'Condensation') throw new Error('commit acknowledgement lost');
      return result;
    });
    const hard = vi.fn(async (view: View) => summary(view));
    await expect(recover(state, hard)).rejects.toThrow('commit acknowledgement lost');
    const restored = restore();
    expect(() => View.fromEvents(restored.events)).not.toThrow();
    expect(restored.events.filter(event => event.kind === 'Condensation')).toHaveLength(1);
    expect(restored.events.some(event => event.kind === 'ConversationStateUpdateEvent' && event.key === CONDENSATION_FAILURE_KEY)).toBe(false);
    await expect(finishPendingContextReset(restored)).resolves.toBeNull();
    await expect(recover(restored, hard)).rejects.toThrow(/recovery|condensation/i);
    expect(hard).toHaveBeenCalledTimes(1);
  });

  it('permits recovery again only after a complete successful subsequent main request', async () => {
    const { state } = persisted();
    const hard = vi.fn().mockRejectedValueOnce(new Error('first attempt failed')).mockImplementation(async (view: View) => summary(view));
    await expect(recover(state, hard)).rejects.toThrow('first attempt failed');
    const inputId = state.events.at(-1)!.id;
    const response = assistant('Main model accepted the context again');
    await state.appendEventsAsync([requestBoundaryEvent(inputId, [response]), response]);
    await expect(recover(state, hard)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'Condensation' })]));
    expect(hard).toHaveBeenCalledTimes(2);
  });

  it('does not rearm recovery for an incomplete subsequent response or extra user input', async () => {
    const { state } = persisted();
    const hard = vi.fn(async () => { throw new Error('first attempt failed'); });
    await expect(recover(state, hard)).rejects.toThrow('first attempt failed');
    await state.appendEventAsync(user('Additional input does not prove the model accepted context'));
    await state.appendEventAsync(requestBoundaryEvent(state.events.at(-1)!.id, [assistant()]));
    await expect(recover(state, hard)).rejects.toThrow(/recovery|condensation/i);
    expect(hard).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a summary when accounting persistence failed', async () => {
    const { state, restore } = persisted();
    const complete = vi.fn(async () => ({ usage: null, message: messageSchema.parse({ role: 'assistant', content: 'Summary generated once' }) }));
    const hard = new LLMSummarizingCondenser({ llm: { profile: { ...profile, profileId: 'hard' }, complete } });
    const failure = new Error('accounting write failed');
    const history = [...state.events];
    await expect(recoverContextWindow(state, history, history.at(-1)!.id, main, hard, {
      onCompletion: async () => { throw failure; },
    })).rejects.toBe(failure);
    await expect(recover(restore(), hard.hardContextReset.bind(hard))).rejects.toThrow(/recovery|condensation/i);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('marks interrupted recovery failed and refuses to replay it after another restart', async () => {
    const { state, restore } = persisted();
    await state.appendEventAsync(condensationRequestSchema.parse({ details: { version: 1,
      trigger: 'provider_context_window', input_event_id: state.events.at(-1)!.id, protected_user_event_ids: [],
    } }));
    const restored = restore();
    await expect(finishPendingContextReset(restored)).rejects.toThrow('interrupted');
    const hard = vi.fn(async (view: View) => summary(view));
    await expect(recover(restore(), hard)).rejects.toThrow(/recovery|condensation/i);
    expect(hard).not.toHaveBeenCalled();
  });
});


describe('reset clears previously pruned active tool history', () => {
  const action = (name: string, callId: string) => actionEventSchema.parse({
    action: {}, tool_name: name, tool_call_id: callId, llm_response_id: callId,
    tool_call: { id: callId, name, arguments: '{}', origin: 'completion' },
  });

  it('commits voluntary reset after an older unmatched tool action was pruned', async () => {
    const orphan = action('think', 'old-unmatched');
    const { state, restore } = persisted([...successfulHistory(), orphan]);
    const resetAction = action('condense', 'reset-call');
    await state.appendEventsAsync([requestBoundaryEvent(orphan.id, [resetAction]), resetAction]);
    await state.appendEventsAsync(await executeCondenseTool(CondenseTool.create(), resetAction, state, orphan.id, true));
    const emitted = await finishPendingContextReset(state);
    expect(emitted?.[0]).toMatchObject({ kind: 'Condensation' });
    const commit = emitted![0]!;
    if (commit.kind !== 'Condensation') throw new Error('Expected reset commit');
    expect(commit.forgotten_event_ids.has(orphan.id)).toBe(true);
    expect(View.fromEvents(restore().events).events.map(event => event.kind)).toEqual(['MessageEvent', 'ActionEvent', 'ObservationEvent']);
  });

  it('summarizes valid history but also forgets invalid raw tool remnants on hard recovery', async () => {
    const orphan = action('think', 'old-unmatched');
    const pending = user('New request remains verbatim');
    const { state, restore } = persisted([...successfulHistory(), orphan, pending]);
    const hard = vi.fn(async (view: View) => summary(view));
    const emitted = await recover(state, hard);
    const commit = emitted.find(event => event.kind === 'Condensation');
    expect(commit?.forgotten_event_ids.has(orphan.id)).toBe(true);
    expect(hard.mock.calls[0]![0].events.some(event => event.id === orphan.id)).toBe(false);
    expect(View.fromEvents(restore().events).events).toEqual(expect.arrayContaining([pending]));
  });
});
