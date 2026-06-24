import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import { llmCompletionResponseSchema, type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { contentToString, messageSchema, type Content, type LLMProfile, type Message } from './index.js';

export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface CreateAnthropicClientOptions {
  readonly fetch?: FetchLike;
}

export class AnthropicMessagesClient implements LLMClient {
  readonly profile: LLMProfile;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(profile: LLMProfile, apiKey: string, fetchImpl: FetchLike = defaultFetch) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async complete(messages: readonly Message[]): Promise<LLMCompletionResponse> {
    const body = buildAnthropicMessagesBody(this.profile, messages);
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic messages completion failed with HTTP ${response.status}: ${text}`);
    }

    return parseAnthropicMessagesResponse(await response.json());
  }
}

export async function createAnthropicClientFromProfile(
  profile: LLMProfile,
  store: SecretStore,
  options: CreateAnthropicClientOptions = {},
): Promise<AnthropicMessagesClient> {
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
      `Missing API key for Anthropic LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`,
    );
  }
  return new AnthropicMessagesClient(profile, apiKey, options.fetch ?? defaultFetch);
}

export function buildAnthropicMessagesBody(profile: LLMProfile, messages: readonly Message[]): Record<string, unknown> {
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const system = parsedMessages.filter((message) => message.role === 'system').flatMap((message) => contentToString(message.content));
  const body: Record<string, unknown> = {
    model: profile.model,
    max_tokens: profile.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    messages: parsedMessages.filter((message) => message.role !== 'system').map(toAnthropicMessage),
  };
  if (system.length > 0) {
    body.system = system.join('\n');
  }
  if (profile.temperature !== null) {
    body.temperature = profile.temperature;
  }
  if (profile.topP !== null) {
    body.top_p = profile.topP;
  }
  if (profile.topK !== null) {
    body.top_k = profile.topK;
  }
  return body;
}

function toAnthropicMessage(message: Message): Record<string, unknown> {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content.map(toAnthropicContentBlock),
  };
}

function toAnthropicContentBlock(content: Content): Record<string, unknown> {
  if (content.type === 'text') {
    return { type: 'text', text: content.text };
  }
  return {
    type: 'image',
    source: {
      type: 'url',
      url: content.image_urls[0] ?? '',
    },
  };
}

function parseAnthropicMessagesResponse(raw: unknown): LLMCompletionResponse {
  const parsed = anthropicMessagesResponseSchema.parse(raw);
  const text = parsed.content
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return llmCompletionResponseSchema.parse({
    message: { role: 'assistant', content: text },
    usage: parsed.usage === null ? null : {
      promptTokens: parsed.usage.input_tokens,
      completionTokens: parsed.usage.output_tokens,
      totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
    },
    raw,
  });
}

function resolveBaseUrl(profile: LLMProfile): string {
  return (profile.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/u, '');
}

function buildHeaders(profile: LLMProfile, apiKey: string): Readonly<Record<string, string>> {
  return {
    'x-api-key': apiKey,
    'content-type': 'application/json',
    'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
    ...profile.headers,
  };
}

async function defaultFetch(
  url: string,
  init: { readonly method: 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body: string },
) {
  return globalThis.fetch(url, init);
}

const anthropicTextBlockSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const anthropicOtherBlockSchema = z.object({ type: z.string() }).passthrough();
const anthropicContentBlockSchema = z.union([anthropicTextBlockSchema, anthropicOtherBlockSchema]);

type AnthropicTextBlock = z.infer<typeof anthropicTextBlockSchema>;

const anthropicMessagesResponseSchema = z
  .object({
    role: z.literal('assistant').default('assistant'),
    content: z.array(anthropicContentBlockSchema),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).default(0),
        output_tokens: z.number().int().min(0).default(0),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .passthrough();
