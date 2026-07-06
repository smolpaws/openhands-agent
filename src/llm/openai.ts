import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import { llmCompletionResponseSchema, type FetchLike, type FetchResponseLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import {
  contentToString,
  messageSchema,
  type Content,
  type LLMProfile,
  type Message,
  type MessageToolCall,
} from './index.js';
import { normalizeGenerationParamsForModel } from './provider-quirks.js';

export { llmCompletionResponseSchema, llmUsageSchema } from './client.js';
export type { FetchLike, FetchResponseLike, LLMClient, LLMCompletionResponse, LLMUsage } from './client.js';
export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface CreateLlmClientOptions {
  readonly fetch?: FetchLike;
}

export class OpenAIChatClient implements LLMClient {
  readonly profile: LLMProfile;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(profile: LLMProfile, apiKey: string, fetchImpl: FetchLike = defaultFetch) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async complete(messages: readonly Message[]): Promise<LLMCompletionResponse> {
    const body = buildChatCompletionsBody(this.profile, messages);
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI-compatible completion failed with HTTP ${response.status}: ${text}`);
    }


    return parseChatCompletionsResponse(await response.json());
  }
}

export class OpenAIResponsesClient implements LLMClient {
  readonly profile: LLMProfile;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(profile: LLMProfile, apiKey: string, fetchImpl: FetchLike = defaultFetch) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async complete(messages: readonly Message[]): Promise<LLMCompletionResponse> {
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/responses`, {
      method: 'POST',
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(buildOpenAIResponsesBody(this.profile, messages)),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI Responses completion failed with HTTP ${response.status}: ${text}`);
    }

    return parseOpenAIResponsesResponse(await response.json());
  }
}


export async function createLlmClientFromProfile(
  profile: LLMProfile,
  store: SecretStore,
  options: CreateLlmClientOptions = {},
): Promise<OpenAIChatClient> {
  const apiKey = await getLlmApiKey(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride,
    },
    store,
  );
  if (apiKey === null) {
    throw new Error(
      `Missing API key for LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`,
    );
  }
  return new OpenAIChatClient(profile, apiKey, options.fetch ?? defaultFetch);
}


export async function createOpenAIResponsesClientFromProfile(
  profile: LLMProfile,
  store: SecretStore,
  options: CreateLlmClientOptions = {},
): Promise<OpenAIResponsesClient> {
  const apiKey = await getLlmApiKey(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride,
    },
    store,
  );
  if (apiKey === null) {
    throw new Error(
      `Missing API key for LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`,
    );
  }
  return new OpenAIResponsesClient(profile, apiKey, options.fetch ?? defaultFetch);
}

export function buildChatCompletionsBody(profile: LLMProfile, messages: readonly Message[]): Record<string, unknown> {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const body: Record<string, unknown> = {
    model: normalizedProfile.model,
    messages: messages.map((message) => toOpenAIChatMessage(messageSchema.parse(message))),
  };
  if (normalizedProfile.temperature !== null) {
    body.temperature = normalizedProfile.temperature;
  }
  if (normalizedProfile.topP !== null) {
    body.top_p = normalizedProfile.topP;
  }
  if (normalizedProfile.maxOutputTokens !== null) {
    body.max_completion_tokens = normalizedProfile.maxOutputTokens;
  }
  if (normalizedProfile.timeoutSeconds !== null) {
    body.timeout = normalizedProfile.timeoutSeconds;
  }
  if (normalizedProfile.reasoningEffort !== null) {
    body.reasoning_effort = normalizedProfile.reasoningEffort;
  }
  return body;
}

export function buildOpenAIResponsesBody(profile: LLMProfile, messages: readonly Message[]): Record<string, unknown> {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const instructions = parsedMessages.filter((message) => message.role === 'system').flatMap((message) => contentToString(message.content));
  const body: Record<string, unknown> = {
    model: normalizedProfile.model,
    input: parsedMessages.filter((message) => message.role !== 'system').flatMap(toOpenAIResponsesInputItems),
    include: ['reasoning.encrypted_content'],
    store: false,
  };
  if (instructions.length > 0) {
    body.instructions = instructions.join('\n');
  }
  if (normalizedProfile.maxOutputTokens !== null) {
    body.max_output_tokens = normalizedProfile.maxOutputTokens;
  }
  if (normalizedProfile.temperature !== null) {
    body.temperature = normalizedProfile.temperature;
  }
  if (normalizedProfile.topP !== null) {
    body.top_p = normalizedProfile.topP;
  }
  if (normalizedProfile.reasoningEffort !== null || normalizedProfile.reasoningSummary !== null) {
    body.reasoning = {
      ...(normalizedProfile.reasoningEffort === null ? {} : { effort: normalizedProfile.reasoningEffort }),
      ...(normalizedProfile.reasoningSummary === null ? {} : { summary: normalizedProfile.reasoningSummary }),
    };
  }
  return body;
}

function toOpenAIResponsesInputItems(message: Message): readonly Record<string, unknown>[] {
  if (message.role === 'user') {
    const content = message.content.map((contentItem) => {
      if (contentItem.type === 'text') {
        return { type: 'input_text', text: contentItem.text };
      }
      return { type: 'input_image', image_url: contentItem.image_urls[0] ?? '', detail: 'auto' };
    });
    return [{ type: 'message', role: 'user', content: content.length > 0 ? content : [{ type: 'input_text', text: '' }] }];
  }

  if (message.role === 'assistant') {
    const items: Record<string, unknown>[] = [];
    const reasoningItem = toOpenAIResponsesReasoningInputItem(message);
    if (reasoningItem !== null) {
      items.push(reasoningItem);
    }
    const content = message.content
      .filter((contentItem): contentItem is Extract<Content, { type: 'text' }> => contentItem.type === 'text' && contentItem.text.length > 0)
      .map((contentItem) => ({ type: 'output_text', text: contentItem.text }));
    if (content.length > 0) {
      items.push({ type: 'message', role: 'assistant', content });
    }
    if (message.tool_calls !== null) {
      items.push(...message.tool_calls.map(toOpenAIResponsesFunctionCallInputItem));
    }
    return items;
  }

  if (message.role === 'tool') {
    return message.content
      .filter((contentItem): contentItem is Extract<Content, { type: 'text' }> => contentItem.type === 'text' && message.tool_call_id !== null)
      .map((contentItem) => ({ type: 'function_call_output', call_id: normalizeResponsesCallId(message.tool_call_id ?? ''), output: contentItem.text }));
  }

  return [];
}

function toOpenAIResponsesReasoningInputItem(message: Message): Record<string, unknown> | null {
  const reasoning = message.responses_reasoning_item;
  if (reasoning === null || reasoning.id === null || reasoning.encrypted_content === null) {
    return null;
  }
  return {
    type: 'reasoning',
    id: reasoning.id,
    summary: reasoning.summary.map((text) => ({ type: 'summary_text', text })),
    encrypted_content: reasoning.encrypted_content,
  };
}

function toOpenAIResponsesFunctionCallInputItem(toolCall: MessageToolCall): Record<string, unknown> {
  const callId = normalizeResponsesCallId(toolCall.id);
  return {
    type: 'function_call',
    id: toolCall.responses_item_id ?? callId,
    call_id: callId,
    name: toolCall.name,
    arguments: toolCall.arguments,
  };
}

function normalizeResponsesCallId(value: string): string {
  return value.startsWith('call_') ? value : `call_${value.replace(/[^a-zA-Z0-9_-]/gu, '_')}`;
}

function toOpenAIChatMessage(message: Message): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: serializeContent(message.content),
  };
  if (message.tool_calls !== null) {
    out.tool_calls = message.tool_calls.map(toOpenAIChatToolCall);
    if (isEmptySerializedContent(out.content)) {
      delete out.content;
    }
  }
  if (message.tool_call_id !== null) {
    out.tool_call_id = message.tool_call_id;
  }
  if (message.name !== null) {
    out.name = message.name;
  }
  return out;
}

function serializeContent(content: readonly Content[]): string | readonly Record<string, unknown>[] {
  if (content.every((item) => item.type === 'text')) {
    return contentToString(content).join('\n');
  }
  return content.map((item) => {
    if (item.type === 'text') {
      return { type: 'text', text: item.text };
    }
    return { type: 'image_url', image_url: { url: item.image_urls[0] ?? '' } };
  });
}

function isEmptySerializedContent(content: unknown): boolean {
  if (content === '') {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((item) => {
    if (typeof item !== 'object' || item === null || !('type' in item)) {
      return false;
    }
    const record = item as { readonly type?: unknown; readonly text?: unknown };
    return record.type === 'text' && record.text === '';
  });
}

function toOpenAIChatToolCall(toolCall: MessageToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  };
}

function parseChatCompletionsResponse(raw: unknown): LLMCompletionResponse {
  const parsed = openAIChatCompletionResponseSchema.parse(raw);
  const firstChoice = parsed.choices[0];
  if (firstChoice === undefined) {
    throw new Error('OpenAI-compatible completion returned no choices.');
  }

  const message = messageSchema.parse({
    role: firstChoice.message.role,
    content: firstChoice.message.content,
    tool_calls: firstChoice.message.tool_calls?.map(fromOpenAIChatToolCall) ?? null,
  });

  return llmCompletionResponseSchema.parse({
    message,
    usage: parsed.usage === null ? null : {
      promptTokens: parsed.usage.prompt_tokens,
      completionTokens: parsed.usage.completion_tokens,
      totalTokens: parsed.usage.total_tokens,
    },
    raw,
  });
}

function fromOpenAIChatToolCall(toolCall: OpenAIChatToolCall): MessageToolCall {
  return {
    id: toolCall.id,
    responses_item_id: null,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    origin: 'completion',
  };
}

function parseOpenAIResponsesResponse(raw: unknown): LLMCompletionResponse {
  const parsed = openAIResponsesResponseSchema.parse(raw);
  const text = parsed.output
    .filter((item): item is OpenAIResponsesMessageItem => item.type === 'message')
    .flatMap((item) => item.content)
    .filter((content): content is OpenAIResponsesOutputText => content.type === 'output_text')
    .map((content) => content.text)
    .join('\n');
  const reasoningItem = parsed.output.find((item): item is OpenAIResponsesReasoningItem => item.type === 'reasoning') ?? null;
  const toolCalls = parsed.output
    .filter((item): item is OpenAIResponsesFunctionCallItem => item.type === 'function_call')
    .map(fromOpenAIResponsesFunctionCall);

  return llmCompletionResponseSchema.parse({
    message: {
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      responses_reasoning_item: reasoningItem === null ? null : {
        id: reasoningItem.id,
        summary: normalizeResponsesReasoningSummary(reasoningItem.summary),
        content: normalizeResponsesReasoningContent(reasoningItem.content),
        encrypted_content: reasoningItem.encrypted_content ?? null,
        status: reasoningItem.status ?? null,
      },
    },
    usage: parsed.usage === null ? null : {
      promptTokens: parsed.usage.input_tokens,
      completionTokens: parsed.usage.output_tokens,
      totalTokens: parsed.usage.total_tokens,
    },
    raw,
  });
}

function fromOpenAIResponsesFunctionCall(item: OpenAIResponsesFunctionCallItem): MessageToolCall {
  return {
    id: item.call_id,
    responses_item_id: item.id,
    name: item.name,
    arguments: item.arguments,
    origin: 'responses',
  };
}

function normalizeResponsesReasoningSummary(summary: readonly OpenAIResponsesReasoningSummaryItem[]): string[] {
  return summary.flatMap((item) => (item.text.length === 0 ? [] : [item.text]));
}

function normalizeResponsesReasoningContent(content: readonly OpenAIResponsesReasoningContentItem[] | null): string[] | null {
  if (content === null) {
    return null;
  }
  const values = content.flatMap((item) => {
    if (item.text !== null && item.text.length > 0) {
      return [item.text];
    }
    if (item.content !== null && item.content.length > 0) {
      return [item.content];
    }
    return [];
  });
  return values.length > 0 ? values : null;
}


function resolveBaseUrl(profile: LLMProfile): string {
  const baseUrl = profile.baseUrl ?? defaultBaseUrlForProvider(profile.providerId);
  return baseUrl.replace(/\/+$/u, '');
}

function defaultBaseUrlForProvider(providerId: string): string {
  if (providerId === 'openrouter') {
    return DEFAULT_OPENROUTER_BASE_URL;
  }
  return DEFAULT_OPENAI_BASE_URL;
}

function buildHeaders(profile: LLMProfile, apiKey: string): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    ...profile.headers,
  };
}

async function defaultFetch(
  url: string,
  init: { readonly method: 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body: string },
): Promise<FetchResponseLike> {
  return globalThis.fetch(url, init);
}

const openAIChatToolCallSchema = z
  .object({
    id: z.string(),
    type: z.literal('function').default('function'),
    function: z.object({ name: z.string(), arguments: z.string() }).strict(),
  })
  .strict();

type OpenAIChatToolCall = z.infer<typeof openAIChatToolCallSchema>;

const openAIChatCompletionResponseSchema = z
  .object({
    choices: z.array(
      z
        .object({
          message: z
            .object({
              role: z.union([z.literal('assistant'), z.literal('tool'), z.literal('user'), z.literal('system')]),
              content: z.string().nullable().default(null),
              tool_calls: z.array(openAIChatToolCallSchema).optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().min(0).default(0),
        completion_tokens: z.number().int().min(0).default(0),
        total_tokens: z.number().int().min(0).default(0),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();

const openAIResponsesOutputTextSchema = z.object({ type: z.literal('output_text'), text: z.string() }).passthrough();
const openAIResponsesContentItemSchema = z.union([openAIResponsesOutputTextSchema, z.object({ type: z.string() }).passthrough()]);
const openAIResponsesMessageItemSchema = z
  .object({
    type: z.literal('message'),
    role: z.literal('assistant').default('assistant'),
    content: z.array(openAIResponsesContentItemSchema).default([]),
  })
  .passthrough();
const openAIResponsesReasoningSummaryItemSchema = z
  .object({
    type: z.string().default('summary_text'),
    text: z.string().default(''),
  })
  .passthrough();
const openAIResponsesReasoningContentItemSchema = z
  .object({
    type: z.string().default('reasoning_text'),
    text: z.string().nullable().default(null),
    content: z.string().nullable().default(null),
  })
  .passthrough();
const openAIResponsesReasoningItemSchema = z
  .object({
    type: z.literal('reasoning'),
    id: z.string().nullable().default(null),
    summary: z.array(openAIResponsesReasoningSummaryItemSchema).default([]),
    content: z.array(openAIResponsesReasoningContentItemSchema).nullable().default(null),
    encrypted_content: z.string().nullable().default(null),
    status: z.string().nullable().default(null),
  })
  .passthrough();
const openAIResponsesFunctionCallItemSchema = z
  .object({
    type: z.literal('function_call'),
    id: z.string().nullable().default(null),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string().default('{}'),
  })
  .passthrough();
const openAIResponsesOutputItemSchema = z.union([
  openAIResponsesMessageItemSchema,
  openAIResponsesReasoningItemSchema,
  openAIResponsesFunctionCallItemSchema,
  z.object({ type: z.string() }).passthrough(),
]);

type OpenAIResponsesOutputText = z.infer<typeof openAIResponsesOutputTextSchema>;
type OpenAIResponsesMessageItem = z.infer<typeof openAIResponsesMessageItemSchema>;
type OpenAIResponsesReasoningItem = z.infer<typeof openAIResponsesReasoningItemSchema>;
type OpenAIResponsesReasoningSummaryItem = z.infer<typeof openAIResponsesReasoningSummaryItemSchema>;
type OpenAIResponsesReasoningContentItem = z.infer<typeof openAIResponsesReasoningContentItemSchema>;
type OpenAIResponsesFunctionCallItem = z.infer<typeof openAIResponsesFunctionCallItemSchema>;

const openAIResponsesResponseSchema = z
  .object({
    output: z.array(openAIResponsesOutputItemSchema).default([]),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).default(0),
        output_tokens: z.number().int().min(0).default(0),
        total_tokens: z.number().int().min(0).default(0),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
