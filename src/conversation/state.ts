import {
  actionEventSchema,
  agentErrorEventSchema,
  type ActionEvent,
  type AgentErrorEvent,
  type Event,
} from '../event/index.js';
import { messageSchema, type Message } from '../llm/index.js';
import { DuplicateEventError, type EventLog } from './event-log.js';

export const conversationExecutionStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  FINISHED: 'finished',
  ERROR: 'error',
  STUCK: 'stuck',
  DELETING: 'deleting',
} as const;

export type ConversationExecutionStatus = (typeof conversationExecutionStatus)[keyof typeof conversationExecutionStatus];

export interface ConversationStateOptions {
  readonly events?: readonly Event[];
  readonly executionStatus?: ConversationExecutionStatus;
  readonly eventLog?: EventLog | null;
}

export class ConversationState {
  readonly events: Event[];
  readonly eventLog: EventLog | null;
  executionStatus: ConversationExecutionStatus;

  constructor(options: ConversationStateOptions = {}) {
    this.eventLog = options.eventLog ?? null;
    this.events = this.eventLog === null ? [...(options.events ?? [])] : this.eventLog.toArray();
    this.executionStatus = options.executionStatus ?? conversationExecutionStatus.IDLE;

    if (this.eventLog !== null) {
      appendMissingEvents(this.eventLog, options.events ?? []);
      this.syncFromDisk();
    }
  }

  appendEvent(event: Event): Event {
    if (this.eventLog === null) {
      this.events.push(event);
      return event;
    }

    this.eventLog.append(event);
    this.syncFromDisk();
    return event;
  }

  async appendEventAsync(event: Event): Promise<Event> {
    await this.appendEventsAsync([event]);
    return event;
  }

  async appendEventsAsync(events: readonly Event[]): Promise<readonly Event[]> {
    if (events.length === 0) {
      return events;
    }
    if (this.eventLog === null) {
      for (const event of events) {
        this.events.push(event);
      }
      return events;
    }

    await this.eventLog.appendMultipleAsync(events);
    this.syncFromDisk();
    return events;
  }

  syncFromDisk(): void {
    if (this.eventLog === null) {
      return;
    }
    this.eventLog.refresh();
    this.events.length = 0;
    for (const event of this.eventLog.toArray()) {
      this.events.push(event);
    }
  }

  pendingActions(): ActionEvent[] {
    return ConversationState.getUnmatchedActions(this.events);
  }

  emitOrphanedActionErrors(error = 'Tool call interrupted before completion. The conversation was paused.'): AgentErrorEvent[] {
    const errors = this.pendingActions().map((action) =>
      agentErrorEventSchema.parse({
        error,
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id,
      }),
    );
    for (const errorEvent of errors) {
      this.appendEvent(errorEvent);
    }
    return errors;
  }

  static getUnmatchedActions(events: readonly Event[]): ActionEvent[] {
    const observedActionIds = new Set<string>();
    const observedToolCallIds = new Set<string>();
    const unmatched: ActionEvent[] = [];

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === undefined) {
        continue;
      }
      if (event.kind === 'ObservationEvent' || event.kind === 'UserRejectObservation') {

        observedActionIds.add(event.action_id);
        continue;
      }
      if (event.kind === 'AgentErrorEvent') {
        observedToolCallIds.add(event.tool_call_id);
        continue;
      }
      if (event.kind === 'ActionEvent' && !observedActionIds.has(event.id) && !observedToolCallIds.has(event.tool_call_id)) {
        unmatched.unshift(event);
      }
    }

    return unmatched;
  }
}

function appendMissingEvents(eventLog: EventLog, events: readonly Event[]): void {
  const missing = events.filter((event) => !eventLog.has(event.id));
  if (missing.length === 0) {
    return;
  }

  try {
    eventLog.appendMultiple(missing);
  } catch (error) {
    if (!(error instanceof DuplicateEventError)) {
      throw error;
    }
    appendMissingEventsIndividually(eventLog, missing);
  }
}

function appendMissingEventsIndividually(eventLog: EventLog, events: readonly Event[]): void {
  for (const event of events) {
    if (eventLog.has(event.id)) {
      continue;
    }
    try {
      eventLog.append(event);
    } catch (error) {
      if (!(error instanceof DuplicateEventError)) {
        throw error;
      }
    }
  }
}

export function actionEventsFromMessage(message: Message, llmResponseId: string | null = null): ActionEvent[] {
  const parsed = messageSchema.parse(message);
  return (parsed.tool_calls ?? []).map((toolCall) =>
    actionEventSchema.parse({
      thought: parsed.content,
      action: parseToolArguments(toolCall.arguments),
      tool_name: toolCall.name,
      tool_call_id: toolCall.id,
      tool_call: toolCall,
      llm_response_id: llmResponseId,
      reasoning_content: parsed.reasoning_content,
      thinking_blocks: parsed.thinking_blocks,
      responses_reasoning_item: parsed.responses_reasoning_item,
    }),
  );
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { arguments: args };
  }
  return { arguments: args };
}

export interface CancellationToken {
  cancel(): void;
  readonly isCancelled: boolean;
}

export function cancellationToken(): CancellationToken {
  let cancelled = false;
  return {
    cancel() {
      cancelled = true;
    },
    get isCancelled() {
      return cancelled;
    },
  };
}

export class PendingActionsQueue {
  private readonly queue: ActionEvent[];

  constructor(actions: readonly ActionEvent[] = []) {
    this.queue = [...actions];
  }

  get pending(): readonly ActionEvent[] {
    return [...this.queue];
  }

  enqueue(...actions: readonly ActionEvent[]): number {
    this.queue.push(...actions);
    return this.queue.length;
  }

  drain(limit = this.queue.length): ActionEvent[] {
    if (limit <= 0) {
      return [];
    }
    return this.queue.splice(0, limit);
  }

  cancelPending(token: CancellationToken): AgentErrorEvent[] {
    if (!token.isCancelled) {
      return [];
    }
    const skipped = this.drain();
    return skipped.map((action) =>
      agentErrorEventSchema.parse({
        error: 'Tool call cancelled by interrupt.',
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id,
      }),
    );
  }
}
