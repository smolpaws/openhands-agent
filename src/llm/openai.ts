import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import {
  contentToString,
  messageSchema,
  type Content,
  type LLMProfile,
  type Message,
  type MessageToolCall,
} from './index.js';

export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { readonly method: 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body: string },
) => Promise<FetchResponseLike>;

export interface CreateLlmClientOptions {
  readonly fetch?: FetchLike;
}

export interface LLMClient {
  readonly profile: LLMProfile;
  complete(messages: readonly Message[]): Promise<LLMCompletionResponse>;
}

export const llmUsageSchema = z
  .object({
    promptTokens: z.number().int().min(0).default(0),
    completionTokens: z.number().int().min(0).default(0),
    totalTokens: z.number().int().min(0).default(0),
  })
  .strict();

export const llmCompletionResponseSchema = z
  .object({
    message: messageSchema,
    usage: llmUsageSchema.nullable().default(null),
    raw: z.unknown().optional(),
  })
  .strict();

export type LLMUsage = z.infer<typeof llmUsageSchema>;
export type LLMCompletionResponse = z.infer<typeof llmCompletionResponseSchema>;

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

export function buildChatCompletionsBody(profile: LLMProfile, messages: readonly Message[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: profile.model,
    messages: messages.map((message) => toOpenAIChatMessage(messageSchema.parse(message))),
  };
  if (profile.temperature !== null) {
    body.temperature = profile.temperature;
  }
  if (profile.topP !== null) {
    body.top_p = profile.topP;
  }
  if (profile.maxOutputTokens !== null) {
    body.max_completion_tokens = profile.maxOutputTokens;
  }
  if (profile.timeoutSeconds !== null) {
    body.timeout = profile.timeoutSeconds;
  }
  return body;
}

function toOpenAIChatMessage(message: Message): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: serializeContent(message.content),
  };
  if (message.tool_calls !== null) {
    out.tool_calls = message.tool_calls.map(toOpenAIChatToolCall);
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
            .strict(),
        })
        .strict(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().min(0).default(0),
        completion_tokens: z.number().int().min(0).default(0),
        total_tokens: z.number().int().min(0).default(0),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .passthrough();
