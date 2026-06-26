import {
  actionEventSchema,
  agentErrorEventSchema,
  type ActionEvent,
  type AgentErrorEvent,
  type Event,
} from '../event/index.js';
import { messageSchema, type Message } from '../llm/index.js';

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
}

export class ConversationState {
  readonly events: Event[];
  executionStatus: ConversationExecutionStatus;

  constructor(options: ConversationStateOptions = {}) {
    this.events = [...(options.events ?? [])];
    this.executionStatus = options.executionStatus ?? conversationExecutionStatus.IDLE;
  }

  appendEvent(event: Event): Event {
    this.events.push(event);
    return event;
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
    this.events.push(...errors);
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
