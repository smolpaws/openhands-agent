import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import { llmCompletionResponseSchema, type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { contentToString, messageSchema, reduceTextContent, type Content, type LLMProfile, type Message, type MessageToolCall } from './index.js';
import { getAnthropicThinkingBudget, normalizeGenerationParamsForModel, supportsPromptCaching } from './provider-quirks.js';

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
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const systemMessages = parsedMessages.filter((message) => message.role === 'system');
  const system = systemMessages.flatMap((message) => contentToString(message.content));
  const shouldCacheSystem = supportsPromptCaching(normalizedProfile) && systemMessages.some((message) => message.content.some((content) => content.cache_prompt));
  const maxTokens = normalizedProfile.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const thinkingBudget = getAnthropicThinkingBudget(normalizedProfile, maxTokens);
  const body: Record<string, unknown> = {
    model: normalizedProfile.model,
    max_tokens: maxTokens,
    messages: parsedMessages.filter((message) => message.role !== 'system').map((message) => toAnthropicMessage(normalizedProfile, message)),
  };
  if (system.length > 0) {
    body.system = shouldCacheSystem
      ? [{ type: 'text', text: system.join('\n'), cache_control: { type: 'ephemeral' } }]
      : system.join('\n');
  }
  if (normalizedProfile.temperature !== null) {
    body.temperature = normalizedProfile.temperature;
  }
  if (normalizedProfile.topP !== null) {
    body.top_p = normalizedProfile.topP;
  }
  if (normalizedProfile.topK !== null) {
    body.top_k = normalizedProfile.topK;
  }
  if (thinkingBudget !== undefined) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }
  return body;
}

function toAnthropicMessage(profile: LLMProfile, message: Message): Record<string, unknown> {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: toAnthropicAssistantContent(message) };
  }
  if (message.role === 'tool') {
    return { role: 'user', content: [toAnthropicToolResultBlock(message)] };
  }
  return {
    role: 'user',
    content: message.content.map((content) => toAnthropicContentBlock(profile, content)),
  };
}

function toAnthropicAssistantContent(message: Message): readonly Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const thinkingBlock = message.thinking_blocks.find(
    (block): block is Extract<Message['thinking_blocks'][number], { type: 'thinking' }> => block.type === 'thinking' && block.signature !== null,
  );
  if (thinkingBlock !== undefined) {
    blocks.push({ type: 'thinking', thinking: thinkingBlock.thinking, signature: thinkingBlock.signature });
  }

  const text = reduceTextContent(message);
  if (text.length > 0) {
    blocks.push({ type: 'text', text });
  }
  if (message.tool_calls !== null) {
    blocks.push(...message.tool_calls.map(toAnthropicToolUseBlock));
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

function toAnthropicToolUseBlock(toolCall: MessageToolCall): Record<string, unknown> {
  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input: parseToolArguments(toolCall.arguments),
  };
}

function toAnthropicToolResultBlock(message: Message): Record<string, unknown> {
  const block: Record<string, unknown> = {
    type: 'tool_result',
    tool_use_id: message.tool_call_id ?? '',
    content: reduceTextContent(message),
  };
  return block;
}

function toAnthropicContentBlock(profile: LLMProfile, content: Content): Record<string, unknown> {
  const block: Record<string, unknown> = content.type === 'text'
    ? { type: 'text', text: content.text }
    : {
        type: 'image',
        source: {
          type: 'url',
          url: content.image_urls[0] ?? '',
        },
      };
  if (content.cache_prompt && supportsPromptCaching(profile)) {
    block.cache_control = { type: 'ephemeral' };
  }
  return block;
}

function parseToolArguments(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function parseAnthropicMessagesResponse(raw: unknown): LLMCompletionResponse {
  const parsed = anthropicMessagesResponseSchema.parse(raw);
  const text = parsed.content
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const thinkingBlocks = parsed.content.filter((block): block is AnthropicThinkingBlock => block.type === 'thinking');
  const reasoningContent = thinkingBlocks.map((block) => block.thinking).join('');

  return llmCompletionResponseSchema.parse({
    message: {
      role: 'assistant',
      content: text,
      reasoning_content: reasoningContent.length > 0 ? reasoningContent : null,
      thinking_blocks: thinkingBlocks.map((block) => ({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature ?? null,
      })),
    },
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
const anthropicThinkingBlockSchema = z
  .object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().nullable().optional() })
  .passthrough();
const anthropicOtherBlockSchema = z.object({ type: z.string() }).passthrough();
const anthropicContentBlockSchema = z.union([anthropicTextBlockSchema, anthropicThinkingBlockSchema, anthropicOtherBlockSchema]);

type AnthropicTextBlock = z.infer<typeof anthropicTextBlockSchema>;
type AnthropicThinkingBlock = z.infer<typeof anthropicThinkingBlockSchema>;

const anthropicMessagesResponseSchema = z
  .object({
    role: z.literal('assistant').default('assistant'),
    content: z.array(anthropicContentBlockSchema),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).default(0),
        output_tokens: z.number().int().min(0).default(0),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
