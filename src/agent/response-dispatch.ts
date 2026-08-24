import { messageEventSchema, type Event } from '../event/index.js';
import { type LLMCompletionResponse } from '../llm/client.js';
import { messageSchema, textContent, type Message } from '../llm/index.js';
import {
  ConversationState,
  ParallelToolExecutor,
  actionEventsFromMessage,
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

  if (classifyResponse(message) === llmResponseType.TOOL_CALLS) {
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

  if (classifyResponse(message) === llmResponseType.CONTENT || classifyResponse(message) === llmResponseType.REASONING_ONLY) {
    emitted.push(
      await state.appendEventAsync(
        messageEventSchema.parse({
          source: 'agent',
          llm_message: message,
          llm_response_id: options.llmResponseId ?? null,
        }),
      ),
    );
    return emitted;
  }

  // Empty response (no tool call, no content, no reasoning): send a corrective
  // nudge. It is a user-role message so the model sees it as a turn, but the
  // event source is 'environment' so the framework (not the human) is its
  // origin — this keeps it from resetting the stuck-detection user-turn window
  // (upstream #3954).
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
