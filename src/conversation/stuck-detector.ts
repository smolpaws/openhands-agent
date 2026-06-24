import type { ActionEvent, Event } from '../event/index.js';
import type { ConversationState } from './state.js';

const DEFAULT_THRESHOLD = 4;
const MAX_EVENTS_TO_SCAN = 20;

export interface StuckDetectionThresholds {
  readonly actionObservation?: number;
  readonly actionError?: number;
  readonly monologue?: number;
  readonly alternatingPattern?: number;
}

export class StuckDetector {
  readonly state: ConversationState;
  readonly thresholds: Required<StuckDetectionThresholds>;

  constructor(state: ConversationState, thresholds: StuckDetectionThresholds = {}) {
    this.state = state;
    this.thresholds = {
      actionObservation: thresholds.actionObservation ?? DEFAULT_THRESHOLD,
      actionError: thresholds.actionError ?? DEFAULT_THRESHOLD,
      monologue: thresholds.monologue ?? DEFAULT_THRESHOLD,
      alternatingPattern: thresholds.alternatingPattern ?? DEFAULT_THRESHOLD * 2,
    };
  }

  isStuck(): boolean {
    const events = eventsSinceLastUser(this.state.events.slice(-MAX_EVENTS_TO_SCAN));
    if (events.length < Math.min(this.thresholds.actionObservation, this.thresholds.actionError, this.thresholds.monologue)) {
      return false;
    }
    return this.hasRepeatingActionObservation(events) || this.hasRepeatingActionError(events) || this.hasMonologue(events);
  }

  private hasRepeatingActionObservation(events: readonly Event[]): boolean {
    const pairs = actionObservationPairs(events).slice(-this.thresholds.actionObservation);
    if (pairs.length < this.thresholds.actionObservation) {
      return false;
    }
    const [first] = pairs;
    return first !== undefined && pairs.every((pair) => sameAction(first.action, pair.action) && sameObservation(first.observation, pair.observation));
  }

  private hasRepeatingActionError(events: readonly Event[]): boolean {
    const pairs = actionObservationPairs(events).slice(-this.thresholds.actionError);
    if (pairs.length < this.thresholds.actionError) {
      return false;
    }
    const [first] = pairs;
    return (
      first !== undefined &&
      pairs.every((pair) => sameAction(first.action, pair.action) && pair.observation.kind === 'AgentErrorEvent')
    );
  }

  private hasMonologue(events: readonly Event[]): boolean {
    let count = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.kind !== 'MessageEvent') {
        continue;
      }
      if (event.source === 'agent') {
        count += 1;
        if (count >= this.thresholds.monologue) {
          return true;
        }
      } else if (event.source === 'user') {
        return false;
      }
    }
    return false;
  }
}

function eventsSinceLastUser(events: readonly Event[]): Event[] {
  let lastUserIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'MessageEvent' && event.source === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex === -1 ? [...events] : events.slice(lastUserIndex + 1);
}

function actionObservationPairs(events: readonly Event[]): { action: ActionEvent; observation: Event }[] {
  const pairs: { action: ActionEvent; observation: Event }[] = [];
  for (let index = 0; index < events.length - 1; index += 1) {
    const action = events[index];
    const observation = events[index + 1];
    if (action?.kind === 'ActionEvent' && isObservationLike(observation)) {
      pairs.push({ action, observation });
    }
  }
  return pairs;
}

function isObservationLike(event: Event | undefined): event is Event {
  return event?.kind === 'ObservationEvent' || event?.kind === 'UserRejectObservation' || event?.kind === 'AgentErrorEvent';
}

function sameAction(left: ActionEvent, right: ActionEvent): boolean {
  return left.tool_name === right.tool_name && stableStringify(left.action) === stableStringify(right.action);
}

function sameObservation(left: Event, right: Event): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'ObservationEvent' && right.kind === 'ObservationEvent') {
    return left.tool_name === right.tool_name && stableStringify(left.observation) === stableStringify(right.observation);
  }
  if (left.kind === 'UserRejectObservation' && right.kind === 'UserRejectObservation') {
    return left.tool_name === right.tool_name && left.rejection_reason === right.rejection_reason;
  }
  if (left.kind === 'AgentErrorEvent' && right.kind === 'AgentErrorEvent') {
    return left.tool_name === right.tool_name && left.error === right.error;
  }
  return false;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
}
