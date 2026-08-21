import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { llmCompletionResponseSchema, type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { isContentPolicyViolation, LLMContentPolicyViolationError } from './exceptions.js';
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

  async complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse> {
    const body = buildAnthropicMessagesBody(this.profile, messages, tools);
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Anthropic messages completion failed with HTTP ${response.status}: ${text}`);
      if (isContentPolicyViolation(error)) {
        throw new LLMContentPolicyViolationError(text);
      }
      throw error;
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

export function buildAnthropicMessagesBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown> {
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
    messages: toAnthropicMessages(
      normalizedProfile,
      parsedMessages.filter((message) => message.role !== 'system'),
    ),
  };
  if (system.length > 0) {
    body.system = shouldCacheSystem
      ? [{ type: 'text', text: system.join('\n'), cache_control: { type: 'ephemeral' } }]
      : system.join('\n');
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map(toAnthropicTool);
    body.tool_choice = { type: 'auto' };
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

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  const responsesTool = tool.toResponsesTool();
  return {
    name: responsesTool.name,
    description: responsesTool.description,
    input_schema: responsesTool.parameters,
  };
}

function toAnthropicMessages(profile: LLMProfile, messages: readonly Message[]): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') {
      result.push(toAnthropicMessage(profile, message));
      continue;
    }

    const toolResult = toAnthropicToolResultBlock(message);
    const previous = result.at(-1);
    if (previous?.role === 'user' && Array.isArray(previous.content)) {
      previous.content.push(toolResult);
    } else {
      result.push({ role: 'user', content: [toolResult] });
    }
  }
  return result;
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
  for (const block of message.thinking_blocks) {
    if (block.type === 'redacted_thinking') {
      blocks.push({ type: 'redacted_thinking', data: block.data });
    } else if (block.signature !== null) {
      blocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
    }
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
    input: parseToolArguments(toolCall),
  };
}

function toAnthropicToolResultBlock(message: Message): Record<string, unknown> {
  if (message.tool_call_id === null) {
    throw new Error('Anthropic tool result requires a tool_call_id.');
  }
  return {
    type: 'tool_result',
    tool_use_id: message.tool_call_id,
    content: reduceTextContent(message),
  };
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

function parseToolArguments(toolCall: MessageToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.arguments) as unknown;
  } catch {
    throw new Error(`Anthropic tool call '${toolCall.id}' arguments must be a valid JSON object.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Anthropic tool call '${toolCall.id}' arguments must be a valid JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseAnthropicMessagesResponse(raw: unknown): LLMCompletionResponse {
  const parsed = anthropicMessagesResponseSchema.parse(raw);
  const text = parsed.content
    .filter((block): block is AnthropicTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const thinkingBlocks = parsed.content.filter(
    (block): block is AnthropicThinkingBlock | AnthropicRedactedThinkingBlock =>
      block.type === 'thinking' || block.type === 'redacted_thinking',
  );
  const reasoningContent = thinkingBlocks
    .filter((block): block is AnthropicThinkingBlock => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('');
  const toolUseBlocks = parsed.content.filter((block): block is AnthropicToolUseBlock => block.type === 'tool_use');
  const toolCalls = toolUseBlocks.map(fromAnthropicToolUse);

  return llmCompletionResponseSchema.parse({
    message: {
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      reasoning_content: reasoningContent.length > 0 ? reasoningContent : null,
      thinking_blocks: thinkingBlocks.map((block) => block.type === 'thinking'
        ? { type: 'thinking', thinking: block.thinking, signature: block.signature ?? null }
        : { type: 'redacted_thinking', data: block.data }),
    },
    usage: parsed.usage === null ? null : {
      promptTokens: parsed.usage.input_tokens,
      completionTokens: parsed.usage.output_tokens,
      totalTokens: parsed.usage.input_tokens + parsed.usage.output_tokens,
    },
    raw,
  });
}

function fromAnthropicToolUse(block: AnthropicToolUseBlock): MessageToolCall {
  return {
    id: block.id,
    responses_item_id: null,
    name: block.name,
    arguments: JSON.stringify(block.input),
    origin: 'completion',
  };
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
const anthropicRedactedThinkingBlockSchema = z
  .object({ type: z.literal('redacted_thinking'), data: z.string() })
  .passthrough();
const anthropicToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const knownAnthropicBlockTypes = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);
const anthropicOtherBlockSchema = z
  .object({ type: z.string().refine((type) => !knownAnthropicBlockTypes.has(type)) })
  .passthrough();
const anthropicContentBlockSchema = z.union([
  anthropicTextBlockSchema,
  anthropicThinkingBlockSchema,
  anthropicRedactedThinkingBlockSchema,
  anthropicToolUseBlockSchema,
  anthropicOtherBlockSchema,
]);

type AnthropicTextBlock = z.infer<typeof anthropicTextBlockSchema>;
type AnthropicThinkingBlock = z.infer<typeof anthropicThinkingBlockSchema>;
type AnthropicRedactedThinkingBlock = z.infer<typeof anthropicRedactedThinkingBlockSchema>;
type AnthropicToolUseBlock = z.infer<typeof anthropicToolUseBlockSchema>;

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
