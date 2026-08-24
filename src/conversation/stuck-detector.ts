import type { ActionEvent, Event } from '../event/index.js';

const MAX_EVENTS_TO_SCAN = 20;

export interface StuckDetectionThresholds {
  readonly actionObservation?: number;
  readonly actionError?: number;
  readonly monologue?: number;
  readonly alternatingPattern?: number;
}

/** The minimal state surface StuckDetector reads; trivially satisfied by ConversationState. */
export interface StuckDetectorState {
  readonly events: readonly Event[];
}

export class StuckDetector {
  readonly state: StuckDetectorState;
  readonly thresholds: Required<StuckDetectionThresholds>;
  private lastNudgedErrorEventId: string | null = null;

  constructor(state: StuckDetectorState, thresholds: StuckDetectionThresholds = {}) {
    this.state = state;
    this.thresholds = {
      actionObservation: thresholds.actionObservation ?? 4,
      actionError: thresholds.actionError ?? 3,
      monologue: thresholds.monologue ?? 3,
      alternatingPattern: thresholds.alternatingPattern ?? 6,
    };
  }

  isStuck(): boolean {
    const events = eventsSinceLastUser(this.state.events.slice(-MAX_EVENTS_TO_SCAN));
    if (events.length < Math.min(this.thresholds.actionObservation, this.thresholds.actionError, this.thresholds.monologue)) {
      return false;
    }
    return this.hasRepeatingActionObservation(events) || this.hasRepeatingActionError(events) || this.hasMonologue(events);
  }

  /**
   * Nudge text once a trailing run of one action repeatedly erroring first
   * reaches the threshold. Nudges once per streak: a frozen streak (e.g. an
   * empty/reasoning-only response that adds no new action) keeps the same
   * error event, so it is not re-emitted.
   */
  getActionErrorNudge(): string | null {
    const events = eventsSinceLastUser(this.state.events.slice(-MAX_EVENTS_TO_SCAN));
    const threshold = this.thresholds.actionError;
    const pairs = actionObservationPairs(events).slice(-(threshold + 1));
    if (actionErrorStreak(pairs) !== threshold) {
      return null;
    }

    const [first] = pairs;
    if (first === undefined || first.observation.kind !== 'AgentErrorEvent') {
      return null;
    }
    if (first.observation.id === this.lastNudgedErrorEventId) {
      return null;
    }
    this.lastNudgedErrorEventId = first.observation.id;

    return (
      `You've called \`${first.action.tool_name}\` with the same arguments ` +
      `${threshold} times in a row and gotten the same error each time: ${first.observation.error}. ` +
      'Repeating the exact same call again will not work — review the error message and either ' +
      'correct the arguments or try a different approach.'
    );
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
    // One repeat past the threshold: the first threshold-many repeats only
    // trigger a nudge (see getActionErrorNudge).
    const pairs = actionObservationPairs(events).slice(-(this.thresholds.actionError + 1));
    return actionErrorStreak(pairs) > this.thresholds.actionError;
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

/** Length of the trailing run of one action repeatedly erroring (most recent first). */
function actionErrorStreak(pairs: readonly { action: ActionEvent; observation: Event }[]): number {
  if (pairs.length === 0) {
    return 0;
  }
  const [first] = pairs;
  if (first === undefined) {
    return 0;
  }
  let streak = 0;
  for (const pair of pairs) {
    if (!sameAction(first.action, pair.action)) {
      break;
    }
    if (pair.observation.kind !== 'AgentErrorEvent') {
      break;
    }
    streak += 1;
  }
  return streak;
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
