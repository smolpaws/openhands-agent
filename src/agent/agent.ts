import {
  agentErrorEventSchema,
  eventsToMessages,
  messageEventSchema,
  observationEventSchema,
  type ActionEvent,
  type Event,
  type LLMConvertibleEvent,
} from '../event/index.js';
import { View, type Condenser } from '../context/index.js';
import type { AgentContext } from '../context/index.js';
import type { LLMClient } from '../llm/client.js';
import { isContentPolicyViolation } from '../llm/exceptions.js';
import { textContent, type Message } from '../llm/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { ConversationState } from '../conversation/state.js';
import { dispatchLlmResponse } from './response-dispatch.js';

export const CONTENT_POLICY_NUDGE = 'Your previous response was blocked by the model\'s content filter. Please continue, rephrasing to avoid the flagged content.';

export interface AgentOptions {
  readonly llm: LLMClient;
  readonly tools?: readonly ToolDefinition[];
  readonly toolConcurrencyLimit?: number;
  readonly context?: AgentContext | null;
  readonly condenser?: Condenser | null;
  readonly systemPrompt?: string | null;
}

export class Agent {
  readonly llm: LLMClient;
  readonly tools: readonly ToolDefinition[];
  readonly toolConcurrencyLimit: number;
  readonly context: AgentContext | null;
  readonly condenser: Condenser | null;
  readonly systemPrompt: string | null;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.tools = [...(options.tools ?? [])];
    this.toolConcurrencyLimit = Math.max(1, options.toolConcurrencyLimit ?? 1);
    this.context = options.context ?? null;
    this.condenser = options.condenser ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
  }

  async step(state: ConversationState): Promise<readonly Event[]> {
    const messages = this.messagesForState(state);
    if (messages === null) {
      return [state.events.at(-1)].filter((event): event is Event => event !== undefined);
    }
    let response;
    try {
      response = await this.llm.complete(messages, this.tools.filter((tool) => tool.usable));
    } catch (error) {
      if (isContentPolicyViolation(error)) {
        // Content-policy blocks are deterministic; nudge the model and let the
        // run loop continue instead of emitting a fatal error.
        return [
          await state.appendEventAsync(
            messageEventSchema.parse({
              source: 'user',
              llm_message: {
                role: 'user',
                content: [textContent(CONTENT_POLICY_NUDGE)],
              },
            }),
          ),
        ];
      }
      throw error;
    }
    return dispatchLlmResponse(response, state, (action) => this.runTool(action), {
      maxConcurrency: this.toolConcurrencyLimit,
    });
  }

  private messagesForState(state: ConversationState): Message[] | null {
    const view = View.fromEvents(state.events);
    const condensed = this.condenser?.condense(view, this.llm) ?? view;
    if (!(condensed instanceof View)) {
      state.appendEvent(condensed);
      return null;
    }
    const messages = eventsToMessages(condensed.events.filter(isLlmConvertibleEvent));
    const system = this.renderSystemPrompt();
    if (system !== null) {
      return [systemMessage(system), ...messages];
    }
    return messages;
  }

  private renderSystemPrompt(): string | null {
    const suffix = this.context?.getSystemMessageSuffix() ?? null;
    if (this.systemPrompt !== null && suffix !== null) {
      return `${this.systemPrompt}\n\n${suffix}`;
    }
    return this.systemPrompt ?? suffix;
  }


  private async runTool(action: ActionEvent): Promise<readonly Event[]> {
    const tool = this.tools.find((candidate) => candidate.name === action.tool_name);
    if (tool === undefined) {
      return [
        agentErrorEventSchema.parse({
          error: `Unknown tool '${action.tool_name}'`,
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id,
        }),
      ];
    }

    const observation = await tool.execute(action.action);
    return [
      observationEventSchema.parse({
        action_id: action.id,
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id,
        observation,
      }),
    ];
  }
}

function isLlmConvertibleEvent(event: Event): event is LLMConvertibleEvent {
  return (
    event.kind === 'SystemPromptEvent' ||
    event.kind === 'MessageEvent' ||
    event.kind === 'ActionEvent' ||
    event.kind === 'ObservationEvent' ||
    event.kind === 'UserRejectObservation' ||
    event.kind === 'AgentErrorEvent' ||
    event.kind === 'CondensationSummaryEvent'
  );
}

function systemMessage(text: string): Message {
  return {
    role: 'system',
    content: [textContent(text)],
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}
