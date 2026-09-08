import { messageEventSchema, type Event } from '../event/index.js';
import { type LLMCompletionResponse } from '../llm/client.js';
import { messageSchema, textContent, type Message, type TextContent } from '../llm/index.js';
import {
  ConversationState,
  ParallelToolExecutor,
  actionEventsFromMessage,
  conversationExecutionStatus,
  type ToolRunner,
} from '../conversation/index.js';

export const llmResponseType = {
  TOOL_CALLS: 'tool_calls',
  CONTENT: 'content',
  REASONING_ONLY: 'reasoning_only',
  EMPTY: 'empty',
} as const;

export type LLMResponseType = (typeof llmResponseType)[keyof typeof llmResponseType];

export interface DispatchLlmResponseOptions {
  readonly llmResponseId?: string | null;
  readonly maxConcurrency?: number;
  readonly executor?: ParallelToolExecutor;
  readonly maskSecretsInOutput?: ((text: string) => string) | null;
}

export const CORRECTIVE_NUDGE = 'Your last response did not include a function call or a message. Please use a tool to proceed with the task.';

export function classifyResponse(message: Message): LLMResponseType {
  const parsed = messageSchema.parse(message);
  if (parsed.tool_calls !== null && parsed.tool_calls.length > 0) {
    return llmResponseType.TOOL_CALLS;
  }
  if (parsed.content.some((content) => content.type === 'text' && content.text.trim().length > 0)) {
    return llmResponseType.CONTENT;
  }
  if (parsed.responses_reasoning_item !== null || parsed.reasoning_content !== null || parsed.thinking_blocks.length > 0) {
    return llmResponseType.REASONING_ONLY;
  }
  return llmResponseType.EMPTY;
}

export async function dispatchLlmResponse(
  response: LLMCompletionResponse,
  state: ConversationState,
  runner: ToolRunner,
  options: DispatchLlmResponseOptions = {},
): Promise<readonly Event[]> {
  const emitted: Event[] = [];
  const message = messageSchema.parse(response.message);
  const responseType = classifyResponse(message);

  if (responseType === llmResponseType.TOOL_CALLS) {
    const actions = actionEventsFromMessage(message, options.llmResponseId ?? null);
    for (const event of await state.appendEventsAsync(actions)) {
      emitted.push(event);
    }
    const executor = options.executor ?? new ParallelToolExecutor(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency });
    const results = await executor.executeBatch(actions, runner);
    for (const batch of results) {
      for (const event of await state.appendEventsAsync(batch)) {
        emitted.push(event);
      }
    }
    return emitted;
  }

  // Every non-tool response emits the assistant message as it was received,
  // with registered secret values masked in its text (upstream #4783).
  emitted.push(
    await state.appendEventAsync(
      messageEventSchema.parse({
        source: 'agent',
        llm_message: maskMessageSecrets(message, options.maskSecretsInOutput ?? null),
        llm_response_id: options.llmResponseId ?? null,
      }),
    ),
  );

  if (responseType === llmResponseType.CONTENT) {
    // Visible text is a complete turn: hand control back to the user, exactly
    // like the Python SDK's _handle_content_response. The run loop stops when
    // the status is no longer RUNNING.
    state.executionStatus = conversationExecutionStatus.FINISHED;
    return emitted;
  }

  // Reasoning-only or empty: the model produced no user-facing content and no
  // tool call, so it did not actually make progress. Follow the assistant
  // message with a corrective nudge and keep the run loop going. The nudge is a
  // user-role message so the model reads it as a turn, but its event source is
  // 'environment' so the framework (not the human) is its origin — this keeps
  // it from resetting the stuck-detection user-turn window (upstream #3954).
  emitted.push(
    await state.appendEventAsync(
      messageEventSchema.parse({
        source: 'environment',
        llm_message: {
          role: 'user',
          content: [textContent(CORRECTIVE_NUDGE)],
        },
        llm_response_id: options.llmResponseId ?? null,
      }),
    ),
  );

  return emitted;
}

function maskMessageSecrets(message: Message, mask: ((text: string) => string) | null): Message {
  // Mirror Python `ResponseDispatchMixin._mask_secrets`: mask registered secret
  // values in the durable message's text. `thinking_blocks` and
  // `responses_reasoning_item` are signed provider payloads and are left alone.
  if (mask === null) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((part) => (isTextContent(part) ? { ...part, text: mask(part.text) } : part)),
    reasoning_content: message.reasoning_content === null ? null : mask(message.reasoning_content),
  };
}

function isTextContent(part: Message['content'][number]): part is TextContent {
  return part.type === 'text';
}
