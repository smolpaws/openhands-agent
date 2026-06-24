import {
  agentErrorEventSchema,
  eventsToMessages,
  observationEventSchema,
  type ActionEvent,
  type Event,
  type LLMConvertibleEvent,
} from '../event/index.js';
import { View, type Condenser } from '../context/index.js';
import type { AgentContext } from '../context/index.js';
import type { LLMClient } from '../llm/client.js';
import { textContent, type Message } from '../llm/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { ConversationState } from '../conversation/state.js';
import { dispatchLlmResponse } from './response-dispatch.js';

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
    const response = await this.llm.complete(messages);
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
