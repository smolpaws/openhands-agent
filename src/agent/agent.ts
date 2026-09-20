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
import { View, type Condenser, type CondenserContext } from '../context/index.js';
import { AgentResetCondenser } from '../context/agent-reset-condenser.js';
import { contextWarningEvent } from '../context/context-warnings.js';
import { CondenseTool } from '../tool/condense.js';
import { executeCondenseTool, finishPendingContextReset, recoverContextWindow, type HardCondenser } from './context-reset.js';
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
  readonly hardCondenser?: HardCondenser | null;
  readonly systemPrompt?: string | null;
  readonly usageId?: string;
}

export class Agent {
  readonly llm: LLMClient;
  readonly tools: readonly ToolDefinition[];
  readonly toolConcurrencyLimit: number;
  readonly context: AgentContext | null;
  readonly condenser: Condenser | null;
  readonly hardCondenser: HardCondenser | null;
  readonly systemPrompt: string | null;
  readonly usageId: string | undefined;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    const tools = (options.tools ?? []).filter(tool => tool.meta?.smolpaws_agent_condense !== true);
    if (options.condenser instanceof AgentResetCondenser) {
      if (tools.some(tool => tool.name === 'condense')) throw new Error('The condense tool name is reserved in agent-reset mode.');
      this.tools = [...tools, CondenseTool.create()];
    } else {
      this.tools = tools;
    }
    this.hardCondenser = options.hardCondenser ?? null;
    if (this.hardCondenser !== null && !(options.condenser instanceof AgentResetCondenser)) {
      throw new Error('A hard condenser requires agent-reset mode.');
    }
    this.toolConcurrencyLimit = Math.max(1, options.toolConcurrencyLimit ?? 1);
    this.context = options.context ?? null;
    this.condenser = options.condenser ?? null;
    this.systemPrompt = options.systemPrompt ?? null;
    this.usageId = options.usageId;
  }

  async step(state: ConversationState): Promise<readonly Event[]> {
    if (this.condenser instanceof AgentResetCondenser) {
      const recovered = await finishPendingContextReset(state);
      if (recovered !== null) return recovered;
    }
    const history = [...state.events];
    const inputEventId = history.at(-1)?.id ?? null;
    const system = this.renderSystemPrompt();
    await this.llm.resolveRuntimeMetadata?.();
    const context = this.condenserContext(state, history, system);
    if (this.condenser instanceof AgentResetCondenser) {
      const warning = await contextWarningEvent(history, View.fromEvents(history), this.llm, this.condenser.warningThresholds, context);
      if (warning !== null) {
        await state.appendEventAsync(warning);
        history.push(warning);
      }
    }
    const messages = await this.messagesForState(state, history, context);
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
      if (this.condenser instanceof AgentResetCondenser && cause instanceof LLMContextWindowExceedError && this.hardCondenser !== null) {
        return recoverContextWindow(state, history, inputEventId, this.llm, this.hardCondenser, context);
      }
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
    const emitted = await dispatchLlmResponse(response, state, (action) => {
      const tool = this.tools.find(candidate => candidate.name === action.tool_name);
      if (this.condenser instanceof AgentResetCondenser && tool?.meta?.smolpaws_agent_condense === true) {
        return executeCondenseTool(tool, action, state, inputEventId, response.message.tool_calls?.length === 1);
      }
      return this.runTool(action);
    }, {
      llmResponseId: response.responseId ?? accounting.id,
      maxConcurrency: this.toolConcurrencyLimit,
      inputEventId,
    });
    const reset = this.condenser instanceof AgentResetCondenser ? await finishPendingContextReset(state) : null;
    return reset === null ? emitted : [...emitted, ...reset];
  }

  private async messagesForState(state: ConversationState, history: readonly Event[], context: CondenserContext): Promise<Message[] | Condensation> {
    const view = View.fromEvents(history);
    const condensed = await (this.condenser?.condense(view, this.llm, context) ?? view);
    if (!(condensed instanceof View)) {
      await state.appendEventAsync(condensed);
      return condensed;
    }
    return [...context.messagesForEvents!(condensed.events.filter(isLlmConvertibleEvent))];
  }

  private condenserContext(state: ConversationState, history: readonly Event[], system: TextContent[] | null): CondenserContext {
    const projectEvents = (events: readonly LLMConvertibleEvent[], profile: typeof this.llm.profile) =>
      historyForProfile(historyForRequests(events, history), history, profile, this.llm.profile);
    return {
      tools: this.tools.filter(tool => tool.usable),
      messagesForEvents: events => {
        const messages = eventsToMessages(projectEvents(events, this.llm.profile));
        return system === null ? messages : [systemMessage(system), ...messages];
      },
      projectEvents,
      onCompletion: async attempt => {
        const metadata = attempt.response ?? (attempt.error instanceof LLMResponseError ? attempt.error.metadata : { usage: null });
        await state.appendEventAsync(createLlmUsageEvent(attempt.llm.profile, metadata, {
          startedAt: attempt.startedAt, completedAt: attempt.completedAt, usageId: 'condenser',
        }));
      },
    };
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
