import {
  agentErrorEventSchema,
  eventsToMessages,
  observationEventSchema,
  type ActionEvent,
  type Event,
  type LLMConvertibleEvent,
} from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import type { ToolDefinition } from '../tool/index.js';
import { ConversationState } from '../conversation/state.js';
import { dispatchLlmResponse } from './response-dispatch.js';

export interface AgentOptions {
  readonly llm: LLMClient;
  readonly tools?: readonly ToolDefinition[];
  readonly toolConcurrencyLimit?: number;
}

export class Agent {
  readonly llm: LLMClient;
  readonly tools: readonly ToolDefinition[];
  readonly toolConcurrencyLimit: number;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.tools = [...(options.tools ?? [])];
    this.toolConcurrencyLimit = Math.max(1, options.toolConcurrencyLimit ?? 1);
  }

  async step(state: ConversationState): Promise<readonly Event[]> {
    const response = await this.llm.complete(eventsToMessages(state.events.filter(isLlmConvertibleEvent)));
    return dispatchLlmResponse(response, state, (action) => this.runTool(action), {
      maxConcurrency: this.toolConcurrencyLimit,
    });
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
