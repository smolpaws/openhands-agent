import {
  agentErrorEventSchema,
  condensationRequestSchema,
  eventsToMessages,
  messageEventSchema,
  observationEventSchema,
  type ActionEvent,
  type Condensation,
  type Event,
  type LLMConvertibleEvent,
} from '../event/index.js';
import { AGENT_OUTCOME } from '../event/error-classification.js';
import { View, type Condenser } from '../context/index.js';
import type { AgentContext } from '../context/index.js';
import { LLMResponseError, type LLMClient } from '../llm/client.js';
import { createLlmUsageEvent } from '../llm/metrics.js';
import { historyForProfile } from '../llm/history.js';
import { historyForRequests } from '../llm/request-history.js';
import { isContentPolicyViolation, LLMContextWindowExceedError, LLMMalformedConversationHistoryError } from '../llm/exceptions.js';
import { textContent, type Message, type TextContent } from '../llm/index.js';
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
  readonly usageId?: string;
}

export class Agent {
  readonly llm: LLMClient;
  readonly tools: readonly ToolDefinition[];
  readonly toolConcurrencyLimit: number;
  readonly context: AgentContext | null;
  readonly condenser: Condenser | null;
  readonly systemPrompt: string | null;
  readonly usageId: string | undefined;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.tools = [...(options.tools ?? [])];
    this.toolConcurrencyLimit = Math.max(1, options.toolConcurrencyLimit ?? 1);
    this.context = options.context ?? null;
    this.condenser = options.condenser ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
    this.usageId = options.usageId;
  }

  async step(state: ConversationState): Promise<readonly Event[]> {
    const history = [...state.events];
    const inputEventId = history.at(-1)?.id ?? null;
    const system = this.renderSystemPrompt();
    await this.llm.resolveRuntimeMetadata?.();
    const messages = await this.messagesForState(state, history, system);
    if (!Array.isArray(messages)) return [messages];
    let response;
    const startedAt = Date.now();
    try {
      response = await this.llm.complete(messages, this.tools.filter((tool) => tool.usable));
    } catch (error) {
      if (error instanceof LLMResponseError) {
        await state.appendEventAsync(createLlmUsageEvent(this.llm.profile, error.metadata, {
          startedAt, completedAt: Date.now(), ...(this.usageId === undefined ? {} : { usageId: this.usageId }),
        }));
      }
      const cause = error instanceof LLMResponseError ? error.cause : error;
      if ((cause instanceof LLMContextWindowExceedError || cause instanceof LLMMalformedConversationHistoryError)
        && this.condenser?.handlesCondensationRequests?.() === true) {
        // Views are rebuilt with property enforcement at the beginning of every step.
        return [await state.appendEventAsync(condensationRequestSchema.parse({}))];
      }
      if (isContentPolicyViolation(cause)) {
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
    const accounting = createLlmUsageEvent(this.llm.profile, response, {
      startedAt, completedAt: Date.now(), ...(this.usageId === undefined ? {} : { usageId: this.usageId }),
    });
    await state.appendEventAsync(accounting);
    return dispatchLlmResponse(response, state, (action) => this.runTool(action), {
      llmResponseId: response.responseId ?? accounting.id,
      maxConcurrency: this.toolConcurrencyLimit,
      inputEventId,
    });
  }

  private async messagesForState(state: ConversationState, history: readonly Event[], system: TextContent[] | null): Promise<Message[] | Condensation> {
    const view = View.fromEvents(history);
    const projectEvents = (events: readonly LLMConvertibleEvent[], profile: typeof this.llm.profile) =>
      historyForProfile(historyForRequests(events, history), history, profile, this.llm.profile);
    const messagesForEvents = (events: readonly LLMConvertibleEvent[]): Message[] => {
      const messages = eventsToMessages(projectEvents(events, this.llm.profile));
      return system === null ? messages : [systemMessage(system), ...messages];
    };
    const condensed = await (this.condenser?.condense(view, this.llm, {
      tools: this.tools.filter(tool => tool.usable),
      messagesForEvents,
      projectEvents,
      onCompletion: async attempt => {
        const metadata = attempt.response ?? (attempt.error instanceof LLMResponseError ? attempt.error.metadata : { usage: null });
        await state.appendEventAsync(createLlmUsageEvent(attempt.llm.profile, metadata, {
          startedAt: attempt.startedAt, completedAt: attempt.completedAt, usageId: 'condenser',
        }));
      },
    }) ?? view);
    if (!(condensed instanceof View)) {
      await state.appendEventAsync(condensed);
      return condensed;
    }
    return messagesForEvents(condensed.events.filter(isLlmConvertibleEvent));
  }

  private renderSystemPrompt(): TextContent[] | null {
    const suffix = this.context?.getSystemMessageSuffix() ?? null;
    // Preserve the static/dynamic boundary for provider prompt caching.
    const blocks = [this.systemPrompt, suffix].filter((text): text is string => text !== null).map(text => textContent(text));
    return blocks.length > 0 ? blocks : null;
  }


  private async runTool(action: ActionEvent): Promise<readonly Event[]> {
    const tool = this.tools.find((candidate) => candidate.name === action.tool_name);
    if (tool === undefined) {
      return [
        agentErrorEventSchema.parse({
          error: `Unknown tool '${action.tool_name}'`,
          tool_name: action.tool_name,
          tool_call_id: action.tool_call_id,
          classification: AGENT_OUTCOME,
        }),
      ];
    }

    const observation = tool.meta?.smolpaws_execution_context === true
      ? await tool.execute(action.action, { actionEventId: action.id, toolCallId: action.tool_call_id })
      : await tool.execute(action.action);
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

function systemMessage(content: TextContent[]): Message {
  return {
    role: 'system',
    content,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}
