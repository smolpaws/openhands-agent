import { describe, expect, it } from 'vitest';

import {
  actionEventSchema, condensationRequestSchema, condensationSchema, conversationStateUpdateEventSchema,
  messageEventSchema, observationEventSchema, systemPromptEventSchema, type Event,
} from '../../event/index.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { requestBoundaryEvent } from '../../llm/request-history.js';
import { textContent } from '../../llm/index.js';
import { condenseObservationSchema } from '../../tool/condense.js';
import { View } from '../view.js';

const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });
const assistant = (text: string) => messageEventSchema.parse({ source: 'agent', llm_message: { role: 'assistant', content: text } });
const fixed = () => systemPromptEventSchema.parse({ system_prompt: textContent('Fixed identity and runtime'), tools: [] });
const failure = (requestId: string) => conversationStateUpdateEventSchema.parse({ key: 'condensation_operation_failure', value: { version: 1, request_id: requestId, error: 'Recovery interrupted' } });

function agentReset() {
  const system = fixed();
  const old = user('Old consumed task');
  const action = actionEventSchema.parse({ tool_name: 'condense', tool_call_id: 'condense-call', llm_response_id: 'reset-response',
    action: { message_to_future_self: 'Read notes.md' }, tool_call: { id: 'condense-call', name: 'condense', origin: 'completion', arguments: '{"message_to_future_self":"Read notes.md"}' } });
  const observation = observationEventSchema.parse({ action_id: action.id, tool_name: 'condense', tool_call_id: action.tool_call_id, observation: {} });
  const request = condensationRequestSchema.parse({ details: { version: 1, trigger: 'agent', input_event_id: old.id, action_id: action.id, observation_id: observation.id } });
  observation.observation = condenseObservationSchema.parse({ request_id: request.id, message_to_future_self: 'Read notes.md', content: [textContent('Reset completed; recover from your notes.')] });
  const boundary = requestBoundaryEvent(old.id, [action]);
  const commit = condensationSchema.parse({ forgotten_event_ids: [old.id], reset: { version: 1, request_id: request.id } });
  const history: Event[] = [system, old, boundary, action, request, observation, commit];
  return { system, old, action, observation, request, boundary, commit, history };
}

function hardReset() {
  const system = fixed();
  const old = user('Old consumed task');
  const answer = assistant('Old completed answer');
  const pending = user('Unanswered task');
  const boundary = requestBoundaryEvent(old.id, [answer]);
  const request = condensationRequestSchema.parse({ details: { version: 1, trigger: 'provider_context_window', input_event_id: pending.id, protected_user_event_ids: [pending.id] } });
  const commit = condensationSchema.parse({ forgotten_event_ids: [old.id, answer.id], summary: 'Summary of consumed task', summary_offset: 0, reset: { version: 1, request_id: request.id } });
  const history: Event[] = [system, old, boundary, answer, pending, request, commit];
  return { system, old, answer, pending, request, commit, history };
}

describe('agent reset View replay', () => {
  it('replays the genuine tool pair after fixed context and a deterministic notice without changing the log', () => {
    const data = agentReset();
    const original = structuredClone(data.history);
    const store = new InMemoryFileStore();
    const log = new EventLog(store);
    log.appendMultiple(data.history);
    const restored = new EventLog(store).toArray();
    const view = View.fromEvents(restored);
    expect(view.events.map(event => event.kind)).toEqual(['SystemPromptEvent', 'MessageEvent', 'ActionEvent', 'ObservationEvent']);
    expect(view.events[1]).toMatchObject({ id: `${data.commit.id}-notice`, timestamp: data.commit.timestamp, source: 'environment', llm_message: { role: 'user' } });
    expect(view.events[2]).toEqual(data.action);
    expect(view.events[3]).toEqual(data.observation);
    expect(View.fromEvents(restored).events).toEqual(view.events);
    expect(data.history).toEqual(original);
  });

  it('preserves text/media arriving during the main request, tool execution and after the commit', () => {
    const data = agentReset();
    const late = user('During main call');
    const media = messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [{ type: 'image', image_urls: ['https://example.invalid/image.png'] }] } });
    const after = user('After commit');
    const history = [data.system, data.old, late, data.boundary, data.action, data.request, media, data.observation, data.commit, after];
    const view = View.fromEvents(history);
    expect(view.events.slice(4)).toEqual([late, media, after]);
  });

  it('starts a new thinking/tool-loop boundary while preserving the real reset pair', () => {
    const data = agentReset();
    const thought = actionEventSchema.parse({ tool_name: 'think', tool_call_id: 'old-think', llm_response_id: 'old-response', action: {},
      tool_call: { id: 'old-think', name: 'think', origin: 'completion', arguments: '{}' }, thinking_blocks: [{ type: 'thinking', thinking: 'Prior private thought', signature: 'fixture' }] });
    const result = observationEventSchema.parse({ action_id: thought.id, tool_name: 'think', tool_call_id: thought.tool_call_id, observation: {} });
    const boundary = requestBoundaryEvent(result.id, [data.action]);
    data.request.details!.input_event_id = result.id;
    data.commit.forgotten_event_ids.add(thought.id);
    data.commit.forgotten_event_ids.add(result.id);
    const view = View.fromEvents([data.system, data.old, thought, result, boundary, data.action, data.request, data.observation, data.commit]);
    expect(view.events.map(event => event.id)).toEqual([data.system.id, `${data.commit.id}-notice`, data.action.id, data.observation.id]);
  });

  it('rejects a forged later cutoff that could discard an unseen user arrival', () => {
    const data = agentReset();
    const late = user('Unseen arrival');
    data.request.details!.input_event_id = late.id;
    data.commit.forgotten_event_ids.add(late.id);
    expect(() => View.fromEvents([data.system, data.old, late, data.boundary, data.action, data.request, data.observation, data.commit])).toThrow(/boundary|cutoff|provenance/i);
  });

  it('requires the durable authoring request boundary, not just a plausible tool pair', () => {
    const data = agentReset();
    expect(() => View.fromEvents(data.history.filter(event => event !== data.boundary))).toThrow(/boundary|provenance/i);
  });

  it.each(['tool-name', 'tool-id', 'action-args', 'result-kind', 'future-message', 'mixed-response', 'summary-offset'] as const)('rejects inconsistent %s', problem => {
    const data = agentReset();
    if (problem === 'tool-name') data.action.tool_call.name = 'think';
    if (problem === 'tool-id') data.action.tool_call.id = 'different';
    if (problem === 'action-args') data.action.tool_call.arguments = '{"message_to_future_self":"Different"}';
    if (problem === 'result-kind') data.observation.observation.kind = 'DifferentObservation';
    if (problem === 'future-message') data.observation.observation.message_to_future_self = 'Changed handoff';
    if (problem === 'summary-offset') data.commit.summary_offset = 0;
    if (problem === 'mixed-response') {
      const extra = actionEventSchema.parse({ ...data.action, id: 'another-action', tool_call_id: 'extra-call', tool_call: { ...data.action.tool_call, id: 'extra-call' } });
      data.history.splice(data.history.indexOf(data.action), 0, extra);
      data.commit.forgotten_event_ids.add(extra.id);
    }
    expect(() => View.fromEvents(data.history)).toThrow();
  });

  it('does not permit discarding fixed context or an unseen arrival', () => {
    const data = agentReset();
    data.commit.forgotten_event_ids.add(data.system.id);
    expect(() => View.fromEvents(data.history)).toThrow(/fixed context|pending input/i);
    data.commit.forgotten_event_ids.delete(data.system.id);
    const late = user('Keep exactly');
    data.history.splice(data.history.indexOf(data.action), 0, late);
    data.commit.forgotten_event_ids.add(late.id);
    expect(() => View.fromEvents(data.history)).toThrow(/pending input/i);
  });

  it('rejects committing the same request again', () => {
    const data = agentReset();
    const duplicate = condensationSchema.parse({ ...data.commit, id: 'duplicate-commit', forgotten_event_ids: [`${data.commit.id}-notice`] });
    expect(() => View.fromEvents([...data.history, duplicate])).toThrow(/already|duplicate|committed/i);
  });
});

describe('hard-reset View protection', () => {
  it('replays a warning and full summary before pending users, preserving late arrivals', () => {
    const data = hardReset();
    const late = user('During summarization');
    const view = View.fromEvents([...data.history.slice(0, -1), late, data.commit]);
    expect(view.events.map(event => event.kind)).toEqual(['SystemPromptEvent', 'MessageEvent', 'CondensationSummaryEvent', 'MessageEvent', 'MessageEvent']);
    expect(view.events.slice(-2)).toEqual([data.pending, late]);
  });

  it('rejects forgetting pending input even when the request falsely omits it from protected ids', () => {
    const data = hardReset();
    if (data.request.details?.trigger !== 'provider_context_window') throw new Error('fixture');
    data.request.details.protected_user_event_ids = [];
    data.commit.forgotten_event_ids.add(data.pending.id);
    expect(() => View.fromEvents(data.history)).toThrow(/pending|protected/i);
  });

  it('rejects protected IDs that are not genuine active user input', () => {
    const data = hardReset();
    if (data.request.details?.trigger !== 'provider_context_window') throw new Error('fixture');
    data.request.details.protected_user_event_ids = [data.pending.id, data.answer.id];
    expect(() => View.fromEvents(data.history)).toThrow(/protected|user/i);
  });
});

describe('typed request abort projection', () => {
  it('clears an aborted typed request without discarding any context', () => {
    const data = agentReset();
    const history = data.history.slice(0, -1);
    const before = View.fromEvents(history);
    const after = View.fromEvents([...history, failure(data.request.id)]);
    expect(before.unhandledCondensationRequest).toBe(true);
    expect(after.unhandledCondensationRequest).toBe(false);
    expect(after.events).toEqual(before.events);
  });

  it('does not clear another outstanding standard request', () => {
    const data = agentReset();
    const standard = condensationRequestSchema.parse({});
    const view = View.fromEvents([standard, ...data.history.slice(0, -1), failure(data.request.id)]);
    expect(view.unhandledCondensationRequest).toBe(true);
  });

  it('rejects a reset commit for an aborted request', () => {
    const data = agentReset();
    expect(() => View.fromEvents([...data.history.slice(0, -1), failure(data.request.id), data.commit])).toThrow(/abort|fail/i);
  });

  it('rejects malformed or uncorrelated operation failure markers', () => {
    const data = agentReset();
    expect(() => View.fromEvents([...data.history.slice(0, -1), failure('unknown')])).toThrow(/request|correlat/i);
    const bad = failure(data.request.id);
    bad.value = { version: 2, request_id: data.request.id, error: 'bad version' };
    expect(() => View.fromEvents([...data.history.slice(0, -1), bad])).toThrow();
  });
});

describe('reset metadata schemas', () => {
  it('rejects empty references, duplicate protected users and self-overlapping tool identifiers', () => {
    const data = agentReset();
    expect(() => condensationSchema.parse({ forgotten_event_ids: [], reset: { version: 1, request_id: '' } })).toThrow();
    expect(() => condensationRequestSchema.parse({ details: { ...data.request.details, action_id: '' } })).toThrow();
    expect(() => condensationRequestSchema.parse({ details: { ...data.request.details, observation_id: data.action.id } })).toThrow();
    expect(() => condensationRequestSchema.parse({ details: { version: 1, trigger: 'provider_context_window', protected_user_event_ids: ['same', 'same'] } })).toThrow();
  });
});
