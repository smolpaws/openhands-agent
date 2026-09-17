import type { Event, LLMConvertibleEvent } from '../event/index.js';
import { ManipulationIndices } from './manipulation-indices.js';

type ObservationLikeEvent = Extract<Event, { kind: 'ObservationEvent' | 'AgentErrorEvent' | 'UserRejectObservation' }>;

function isObservation(event: Event): event is ObservationLikeEvent {
  return event.kind === 'ObservationEvent' || event.kind === 'AgentErrorEvent' || event.kind === 'UserRejectObservation';
}

export interface ViewProperty {
  enforce(currentEvents: readonly LLMConvertibleEvent[], allEvents: readonly Event[]): Set<string>;
  manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices;
}

export class ObservationUniquenessProperty implements ViewProperty {
  enforce(currentEvents: readonly LLMConvertibleEvent[], _allEvents: readonly Event[]): Set<string> {
    const seen = new Set<string>();
    const remove = new Set<string>();
    for (const event of currentEvents) {
      if (!isObservation(event)) continue;
      if (seen.has(event.tool_call_id)) remove.add(event.id);
      else seen.add(event.tool_call_id);
    }
    return remove;
  }

  manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices {
    const seen = new Set<string>();
    for (const event of currentEvents) {
      if (!isObservation(event)) continue;
      if (seen.has(event.tool_call_id)) console.warn(`Duplicate observation-like event for tool_call_id=${event.tool_call_id}`);
      else seen.add(event.tool_call_id);
    }
    return ManipulationIndices.complete(currentEvents);
  }
}

export class BatchAtomicityProperty implements ViewProperty {
  enforce(currentEvents: readonly LLMConvertibleEvent[], allEvents: readonly Event[]): Set<string> {
    const allBatches = buildBatches(allEvents);
    const remove = new Set<string>();
    for (const [responseId, viewBatch] of buildBatches(currentEvents)) {
      const fullBatch = allBatches.get(responseId);
      if (fullBatch?.size !== viewBatch.size || [...viewBatch].some((id) => !fullBatch.has(id))) {
        for (const id of viewBatch) remove.add(id);
      }
    }
    return remove;
  }

  manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices {
    const indices = ManipulationIndices.complete(currentEvents);
    for (let index = 1; index < currentEvents.length; index += 1) {
      const left = currentEvents[index - 1];
      const right = currentEvents[index];
      if (left?.kind === 'ActionEvent' && right?.kind === 'ActionEvent' && left.llm_response_id === right.llm_response_id) {
        indices.delete(index);
      }
    }
    return indices;
  }
}

export class ToolCallMatchingProperty implements ViewProperty {
  enforce(currentEvents: readonly LLMConvertibleEvent[], _allEvents: readonly Event[]): Set<string> {
    const actions = new Set<string>();
    const observations = new Set<string>();
    for (const event of currentEvents) {
      if (event.kind === 'ActionEvent') actions.add(event.tool_call_id);
      else if (isObservation(event)) observations.add(event.tool_call_id);
    }
    const remove = new Set<string>();
    for (const event of currentEvents) {
      if (event.kind === 'ActionEvent' && !observations.has(event.tool_call_id)) remove.add(event.id);
      else if (isObservation(event) && !actions.has(event.tool_call_id)) remove.add(event.id);
    }
    return remove;
  }

  manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices {
    const indices = ManipulationIndices.complete(currentEvents);
    const pending = new Set<string>();
    for (const [index, event] of currentEvents.entries()) {
      if (event.kind === 'ActionEvent') pending.add(event.tool_call_id);
      else if (isObservation(event) && !pending.delete(event.tool_call_id)) {
        // Python's strict set.remove likewise rejects duplicate or out-of-order results.
        throw new RangeError(`No pending tool call for observation: ${event.tool_call_id}`);
      }
      if (pending.size > 0) indices.delete(index + 1);
    }
    return indices;
  }
}

export class ToolLoopAtomicityProperty implements ViewProperty {
  enforce(currentEvents: readonly LLMConvertibleEvent[], allEvents: readonly Event[]): Set<string> {
    const loops = toolLoops(allEvents);
    const viewIds = new Set(currentEvents.map((event) => event.id));
    const remove = new Set<string>();
    for (const event of currentEvents) {
      if (remove.has(event.id)) continue;
      for (const loop of loops) {
        if (!loop.has(event.id)) continue;
        if ([...loop].some((id) => !viewIds.has(id))) {
          for (const id of loop) if (viewIds.has(id)) remove.add(id);
        }
        break;
      }
    }
    return remove;
  }

  manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices {
    const indices = ManipulationIndices.complete(currentEvents);
    let inLoop = false;
    for (const [index, event] of currentEvents.entries()) {
      if (event.kind === 'ActionEvent' && event.thinking_blocks.length > 0) inLoop = true;
      else if (event.kind === 'ActionEvent' || isObservation(event)) {
        if (inLoop) indices.delete(index);
      } else inLoop = false;
    }
    return indices;
  }
}

export const viewProperties: readonly ViewProperty[] = [
  new ObservationUniquenessProperty(),
  new BatchAtomicityProperty(),
  new ToolCallMatchingProperty(),
  new ToolLoopAtomicityProperty(),
];

function buildBatches(events: readonly Event[]): Map<string | null, Set<string>> {
  const batches = new Map<string | null, Set<string>>();
  for (const event of events) {
    if (event.kind !== 'ActionEvent') continue;
    let batch = batches.get(event.llm_response_id);
    if (batch === undefined) {
      batch = new Set();
      batches.set(event.llm_response_id, batch);
    }
    batch.add(event.id);
  }
  return batches;
}

function toolLoops(events: readonly Event[]): Set<string>[] {
  const loops: Set<string>[] = [];
  let current: Set<string> | undefined;
  for (const event of events) {
    if (event.kind === 'ActionEvent' && event.thinking_blocks.length > 0) {
      if (current !== undefined) loops.push(current);
      current = new Set([event.id]);
    } else if (event.kind === 'ActionEvent' || isObservation(event)) {
      current?.add(event.id);
    } else if (current !== undefined) {
      loops.push(current);
      current = undefined;
    }
  }
  if (current !== undefined) loops.push(current);
  return loops;
}
