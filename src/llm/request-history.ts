import { z } from 'zod';

import { conversationStateUpdateEventSchema, type Event, type LLMConvertibleEvent } from '../event/index.js';

export const LLM_REQUEST_BOUNDARY_KEY = 'llm_request_boundary';

export const llmRequestBoundarySchema = z.object({
  version: z.literal(1),
  // Event serialization omits nulls, so an omitted ID also means an empty input log.
  input_event_id: z.string().nullable().default(null),
  response_event_ids: z.array(z.string()).min(1),
}).strict();

/** Persist with the response events, never associate by a provider's reusable response ID. */
export function requestBoundaryEvent(inputEventId: string | null, responseEvents: readonly Event[]): Event {
  return conversationStateUpdateEventSchema.parse({
    key: LLM_REQUEST_BOUNDARY_KEY,
    value: llmRequestBoundarySchema.parse({ version: 1, input_event_id: inputEventId, response_event_ids: responseEvents.map(event => event.id) }),
  });
}

/**
 * Project only retained input events after replaying condensation in durable order.
 * A response precedes users that arrived after its request snapshot. The saved log,
 * public eventsToMessages conversion and unknown legacy causality remain unchanged.
 */
export function historyForRequests(view: readonly LLMConvertibleEvent[], history: readonly Event[]): LLMConvertibleEvent[] {
  let ordered = [...view];
  for (const { inputIndex, responseIds, firstResponseIndex } of completedRequestBoundaries(history)) {
    const lateIds = new Set(history.slice(inputIndex + 1, firstResponseIndex).filter(event =>
      event.kind === 'MessageEvent' && event.source === 'user' && event.llm_message.role === 'user',
    ).map(event => event.id));
    if (lateIds.size === 0) continue;
    const retainedResponseIndices = ordered.flatMap((event, index) => responseIds.has(event.id) ? [index] : []);
    if (retainedResponseIndices.length === 0) continue;
    const firstRetainedResponse = retainedResponseIndices[0]!;
    const lastRetainedResponse = retainedResponseIndices.at(-1)!;
    // Summary placement belongs to the condenser. An unrelated response also
    // forms a barrier: direct overlapping Agent.step calls have no serial order.
    let barrier = -1;
    for (let index = 0; index <= lastRetainedResponse; index += 1) {
      const event = ordered[index]!;
      if (event.kind === 'CondensationSummaryEvent' || !responseIds.has(event.id) && (event.kind === 'ActionEvent'
        || event.kind === 'MessageEvent' && event.llm_message.role === 'assistant')) barrier = index;
    }
    const late = ordered.slice(barrier + 1, firstRetainedResponse).filter(event => lateIds.has(event.id));
    if (late.length === 0) continue;
    const movedIds = new Set(late.map(event => event.id));
    ordered = [
      ...ordered.slice(0, lastRetainedResponse + 1).filter(event => !movedIds.has(event.id)),
      ...late,
      ...ordered.slice(lastRetainedResponse + 1),
    ];
  }
  return ordered;
}

/** User input absent from every completed request remains verbatim during recovery. */
export function unconsumedUserEventIds(view: readonly LLMConvertibleEvent[], history: readonly Event[]): Set<string> {
  const indices = new Map(history.map((event, index) => [event.id, index]));
  let consumedThrough = -1;
  for (const { inputIndex } of completedRequestBoundaries(history)) consumedThrough = Math.max(consumedThrough, inputIndex);
  return new Set(view.filter(event => event.kind === 'MessageEvent' && event.source === 'user'
    && event.llm_message.role === 'user' && (indices.get(event.id) ?? Infinity) > consumedThrough).map(event => event.id));
}

/** A successful subsequent main request, not new user input, rearms paid recovery. */
export function hasCompletedLlmRequestAfter(history: readonly Event[], eventId: string): boolean {
  const index = history.findIndex(event => event.id === eventId);
  return index >= 0 && completedRequestBoundaries(history).some(boundary => boundary.inputIndex >= index);
}

interface CompletedRequestBoundary {
  readonly inputIndex: number;
  readonly responseIds: ReadonlySet<string>;
  readonly firstResponseIndex: number;
}

function completedRequestBoundaries(history: readonly Event[]): CompletedRequestBoundary[] {
  const indices = new Map(history.map((event, index) => [event.id, index]));
  const completed: CompletedRequestBoundary[] = [];
  for (const [markerIndex, marker] of history.entries()) {
    if (marker.kind !== 'ConversationStateUpdateEvent' || marker.key !== LLM_REQUEST_BOUNDARY_KEY) continue;
    const boundary = llmRequestBoundarySchema.parse(marker.value);
    const inputIndex = boundary.input_event_id === null ? -1 : indices.get(boundary.input_event_id);
    const responseIds = new Set(boundary.response_event_ids);
    if (inputIndex === undefined || inputIndex >= markerIndex || responseIds.size !== boundary.response_event_ids.length) continue;
    const responseIndices = boundary.response_event_ids.map(id => indices.get(id));
    // A partial or misordered batch cannot establish a completed causal boundary.
    if (responseIndices.some(index => index === undefined || index <= markerIndex)) continue;
    const responses = responseIndices.map(index => history[index!]!);
    if (!responses.some(isMainResponse) || !responses.every(event => isMainResponse(event)
      || event.kind === 'MessageEvent' && event.source === 'environment' && event.llm_message.role === 'user')) continue;
    completed.push({ inputIndex, responseIds, firstResponseIndex: Math.min(...responseIndices as number[]) });
  }
  return completed;
}

function isMainResponse(event: Event): boolean {
  return event.kind === 'ActionEvent' || event.kind === 'MessageEvent'
    && event.source === 'agent' && event.llm_message.role === 'assistant';
}
