import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  contentSchema,
  messageSchema,
  messageToolCallSchema,
  reasoningItemSchema,
  redactedThinkingBlockSchema,
  textContent,
  thinkingBlockSchema,
  type Content,
  type Message,
} from '../llm/index.js';

export const N_CHAR_PREVIEW = 500;
export const FULL_STATE_KEY = 'full_state';

export const sourceTypeSchema = z.union([
  z.literal('agent'),
  z.literal('user'),
  z.literal('environment'),
  z.literal('hook'),
]);

const recordSchema = z.record(z.string(), z.unknown());

const baseEventFields = {
  id: z.string().default(() => randomUUID()),
  timestamp: z.string().default(() => new Date().toISOString()),
  source: sourceTypeSchema,
} as const;

function eventObject<const Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ ...baseEventFields, ...shape }).strict();
}

export const tokenEventSchema = eventObject({
  kind: z.literal('TokenEvent').default('TokenEvent'),
  prompt_token_ids: z.array(z.number().int()),
  response_token_ids: z.array(z.number().int()),
});

export const streamingDeltaEventSchema = eventObject({
  kind: z.literal('StreamingDeltaEvent').default('StreamingDeltaEvent'),
  source: z.literal('agent').default('agent'),
  content: z.string().nullable().default(null),
  reasoning_content: z.string().nullable().default(null),
});

export const conversationErrorEventSchema = eventObject({
  kind: z.literal('ConversationErrorEvent').default('ConversationErrorEvent'),
  code: z.string(),
  detail: z.string(),
});

export const llmCompletionLogEventSchema = eventObject({
  kind: z.literal('LLMCompletionLogEvent').default('LLMCompletionLogEvent'),
  source: z.literal('environment').default('environment'),
  filename: z.string(),
  log_data: z.string(),
  model_name: z.string().default('unknown'),
  usage_id: z.string().default('default'),
});

export const pauseEventSchema = eventObject({
  kind: z.literal('PauseEvent').default('PauseEvent'),
  source: z.literal('user').default('user'),
});

export const interruptEventSchema = eventObject({
  kind: z.literal('InterruptEvent').default('InterruptEvent'),
  source: z.literal('user').default('user'),
});

export const conversationStateUpdateEventSchema = eventObject({
  kind: z.literal('ConversationStateUpdateEvent').default('ConversationStateUpdateEvent'),
  source: z.literal('environment').default('environment'),
  key: z.string().default(() => randomUUID()),
  value: z.unknown().default({}),
});

export const systemPromptEventSchema = eventObject({
  kind: z.literal('SystemPromptEvent').default('SystemPromptEvent'),
  source: z.literal('agent').default('agent'),
  system_prompt: contentSchema.refine((content) => content.type === 'text', 'system_prompt must be text'),
  tools: z.array(recordSchema),
  dynamic_context: contentSchema
    .refine((content) => content.type === 'text', 'dynamic_context must be text')
    .nullable()
    .default(null),
});

export const messageEventSchema = eventObject({
  kind: z.literal('MessageEvent').default('MessageEvent'),
  llm_message: messageSchema,
  llm_response_id: z.string().nullable().default(null),
  activated_skills: z.array(z.string()).default([]),
  extended_content: z.array(contentSchema).default([]),
  sender: z.string().nullable().default(null),
  critic_result: z.unknown().nullable().default(null),
});

export const actionEventSchema = eventObject({
  kind: z.literal('ActionEvent').default('ActionEvent'),
  source: z.literal('agent').default('agent'),
  thought: z.array(contentSchema).default([]),
  action: recordSchema,
  tool_name: z.string(),
  tool_call_id: z.string(),
  tool_call: messageToolCallSchema,
  llm_response_id: z.string().nullable().default(null),
  reasoning_content: z.string().nullable().default(null),
  thinking_blocks: z.array(z.union([thinkingBlockSchema, redactedThinkingBlockSchema])).default([]),
  responses_reasoning_item: reasoningItemSchema.nullable().default(null),
});

export const observationEventSchema = eventObject({
  kind: z.literal('ObservationEvent').default('ObservationEvent'),
  source: z.literal('environment').default('environment'),
  observation: recordSchema,
  action_id: z.string(),
  tool_name: z.string(),
  tool_call_id: z.string(),
});

export const userRejectObservationSchema = eventObject({
  kind: z.literal('UserRejectObservation').default('UserRejectObservation'),
  source: z.literal('environment').default('environment'),
  tool_name: z.string(),
  tool_call_id: z.string(),
  rejection_reason: z.string().default('User rejected the action'),
  rejection_source: z.union([z.literal('user'), z.literal('hook')]).default('user'),
  action_id: z.string(),
});

export const agentErrorEventSchema = eventObject({
  kind: z.literal('AgentErrorEvent').default('AgentErrorEvent'),
  source: z.literal('agent').default('agent'),
  tool_name: z.string(),
  tool_call_id: z.string(),
  error: z.string(),
});

export const condensationSchema = eventObject({
  kind: z.literal('Condensation').default('Condensation'),
  source: z.literal('agent').default('agent'),
  summary: z.string(),
  forgotten_event_ids: z
    .union([z.set(z.string()), z.array(z.string())])
    .transform((ids) => (ids instanceof Set ? ids : new Set(ids))),
  llm_response_id: z.string().nullable().default(null),
});

export const condensationRequestSchema = eventObject({
  kind: z.literal('CondensationRequest').default('CondensationRequest'),
  source: z.literal('agent').default('agent'),
});

export const condensationSummaryEventSchema = eventObject({
  kind: z.literal('CondensationSummaryEvent').default('CondensationSummaryEvent'),
  source: z.literal('agent').default('agent'),
  summary: z.string(),
  llm_response_id: z.string().nullable().default(null),
});

export const acpToolCallEventSchema = eventObject({
  kind: z.literal('ACPToolCallEvent').default('ACPToolCallEvent'),
  source: z.literal('agent').default('agent'),
  tool_call_id: z.string(),
  title: z.string(),
  kind_name: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  content: z.array(contentSchema).default([]),
});

export const hookExecutionEventSchema = eventObject({
  kind: z.literal('HookExecutionEvent').default('HookExecutionEvent'),
  source: z.literal('hook').default('hook'),
  hook_name: z.string(),
  event_type: z.string(),
  status: z.string(),
  message: z.string().nullable().default(null),
});

export const resumeTranscriptEventSchema = eventObject({
  kind: z.literal('ResumeTranscriptEvent').default('ResumeTranscriptEvent'),
  source: z.literal('environment').default('environment'),
  transcript: z.array(recordSchema).default([]),
});

export const eventSchema = z.discriminatedUnion('kind', [
  tokenEventSchema,
  streamingDeltaEventSchema,
  conversationErrorEventSchema,
  llmCompletionLogEventSchema,
  pauseEventSchema,
  interruptEventSchema,
  conversationStateUpdateEventSchema,
  systemPromptEventSchema,
  messageEventSchema,
  actionEventSchema,
  observationEventSchema,
  userRejectObservationSchema,
  agentErrorEventSchema,
  condensationSchema,
  condensationRequestSchema,
  condensationSummaryEventSchema,
  acpToolCallEventSchema,
  hookExecutionEventSchema,
  resumeTranscriptEventSchema,
]);

export const llmConvertibleEventSchema = z.discriminatedUnion('kind', [
  systemPromptEventSchema,
  messageEventSchema,
  actionEventSchema,
  observationEventSchema,
  userRejectObservationSchema,
  agentErrorEventSchema,
  condensationSummaryEventSchema,
]);

export type SourceType = z.infer<typeof sourceTypeSchema>;
export type Event = z.infer<typeof eventSchema>;
export type TokenEvent = z.infer<typeof tokenEventSchema>;
export type StreamingDeltaEvent = z.infer<typeof streamingDeltaEventSchema>;
export type ConversationErrorEvent = z.infer<typeof conversationErrorEventSchema>;
export type LLMCompletionLogEvent = z.infer<typeof llmCompletionLogEventSchema>;
export type PauseEvent = z.infer<typeof pauseEventSchema>;
export type InterruptEvent = z.infer<typeof interruptEventSchema>;
export type ConversationStateUpdateEvent = z.infer<typeof conversationStateUpdateEventSchema>;
export type SystemPromptEvent = z.infer<typeof systemPromptEventSchema>;
export type MessageEvent = z.infer<typeof messageEventSchema>;
export type ActionEvent = z.infer<typeof actionEventSchema>;
export type ObservationEvent = z.infer<typeof observationEventSchema>;
export type UserRejectObservation = z.infer<typeof userRejectObservationSchema>;
export type AgentErrorEvent = z.infer<typeof agentErrorEventSchema>;
export type Condensation = z.infer<typeof condensationSchema>;
export type CondensationRequest = z.infer<typeof condensationRequestSchema>;
export type CondensationSummaryEvent = z.infer<typeof condensationSummaryEventSchema>;
export type LLMConvertibleEvent = z.infer<typeof llmConvertibleEventSchema>;

export function toLLMMessage(event: LLMConvertibleEvent): Message {
  switch (event.kind) {
    case 'SystemPromptEvent':
      return {
        role: 'system',
        content: event.dynamic_context === null ? [event.system_prompt] : [event.system_prompt, event.dynamic_context],
        tool_calls: null,
        tool_call_id: null,
        name: null,
        reasoning_content: null,
        thinking_blocks: [],
        responses_reasoning_item: null,
      };
    case 'MessageEvent':
      return {
        ...event.llm_message,
        content: [...event.llm_message.content, ...event.extended_content],
      };
    case 'ActionEvent':
      return {
        role: 'assistant',
        content: event.thought,
        tool_calls: [event.tool_call],
        tool_call_id: null,
        name: null,
        reasoning_content: event.reasoning_content,
        thinking_blocks: event.thinking_blocks,
        responses_reasoning_item: event.responses_reasoning_item,
      };
    case 'ObservationEvent':
      return toolMessage(event.tool_name, event.tool_call_id, observationContent(event.observation));
    case 'UserRejectObservation':
      return toolMessage(event.tool_name, event.tool_call_id, [textContent(`Action rejected: ${event.rejection_reason}`)]);
    case 'AgentErrorEvent':
      return toolMessage(event.tool_name, event.tool_call_id, [textContent(event.error)]);
    case 'CondensationSummaryEvent':
      return {
        role: 'assistant',
        content: [textContent(event.summary)],
        tool_calls: null,
        tool_call_id: null,
        name: null,
        reasoning_content: null,
        thinking_blocks: [],
        responses_reasoning_item: null,
      };
  }
}

export function eventsToMessages(events: readonly LLMConvertibleEvent[]): Message[] {
  const messages: Message[] = [];
  let i = 0;

  while (i < events.length) {
    const event = events[i];
    if (event === undefined) {
      break;
    }

    let message: Message;
    if (event.kind === 'ActionEvent') {
      const batch: [ActionEvent, ...ActionEvent[]] = [event];
      const responseId = event.llm_response_id;
      let j = i + 1;
      while (j < events.length) {
        const next = events[j];
        if (next?.kind !== 'ActionEvent' || next.llm_response_id !== responseId) {
          break;
        }
        batch.push(next);
        j += 1;
      }
      message = combineActionEvents(batch);
      i = j;
    } else {
      message = toLLMMessage(event);
      i += 1;
    }

    const previous = messages.at(-1);
    if (previous !== undefined && canMergeUserMessages(previous, message)) {
      previous.content = [...previous.content, ...message.content];
    } else {
      messages.push(message);
    }
  }

  return messages;
}

function combineActionEvents(events: readonly [ActionEvent, ...ActionEvent[]]): Message {
  if (events.length === 1) {
    return toLLMMessage(events[0]);
  }

  const [first, ...rest] = events;
  for (const event of rest) {
    if (event.thought.length !== 0) {
      throw new Error('Expected empty thought for multi-action events after the first one');
    }
  }

  return {
    role: 'assistant',
    content: first.thought,
    tool_calls: events.map((event) => event.tool_call),
    tool_call_id: null,
    name: null,
    reasoning_content: first.reasoning_content,
    thinking_blocks: first.thinking_blocks,
    responses_reasoning_item: first.responses_reasoning_item,
  };
}

function toolMessage(name: string, toolCallId: string, content: readonly Content[]): Message {
  return {
    role: 'tool',
    content: [...content],
    tool_calls: null,
    tool_call_id: toolCallId,
    name,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}

function observationContent(observation: Record<string, unknown>): Content[] {
  const toLlmContent = observation.to_llm_content;
  if (Array.isArray(toLlmContent)) {
    return z.array(contentSchema).parse(toLlmContent);
  }

  const content = observation.content;
  if (Array.isArray(content)) {
    return z.array(contentSchema).parse(content);
  }

  return [textContent(JSON.stringify(observation))];
}

function isPlainUserMessage(message: Message): boolean {
  return message.role === 'user' && message.tool_calls === null && message.tool_call_id === null && message.name === null;
}

function canMergeUserMessages(previous: Message, current: Message): boolean {
  return isPlainUserMessage(previous) && isPlainUserMessage(current);
}
