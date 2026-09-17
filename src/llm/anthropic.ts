import { LLMContextBudget, type MetadataFetchLike } from './context-budget.js';
import type { LLMTokenCountTool } from './client.js';
import { orderCompletedToolResults } from './tool-result-order.js';
import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { llmCompletionResponseSchema, llmResponseMetadataSchema, parseLlmResponseWithMetadata, throwProviderErrorWithMetadata, type FetchLike, type LLMClient, type LLMCompletionResponse, type LLMResponseMetadata } from './client.js';
import { providerResponseError, mapProviderException } from './exceptions.js';
import { messageSchema, reduceTextContent, type Content, type LLMProfile, type Message, type MessageToolCall } from './index.js';
import { getAnthropicThinkingBudget, normalizeGenerationParamsForModel } from './provider-quirks.js';
import { ANTHROPIC_CACHE_CONTROL, prepareAnthropicPromptCaching, finalizeAnthropicCacheBreakpoints } from './anthropic-prompt-cache.js';

export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface CreateAnthropicClientOptions {
  readonly fetch?: FetchLike;
  readonly metadataFetch?: MetadataFetchLike;
}

export class AnthropicMessagesClient implements LLMClient {
  readonly profile: LLMProfile;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(profile: LLMProfile, apiKey: string, fetchImpl: FetchLike = defaultFetch, metadataFetch?: MetadataFetchLike) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.contextBudget = new LLMContextBudget(profile, { ...(metadataFetch ? { fetch: metadataFetch } : {}), headers: buildHeaders(profile, apiKey) });
  }

  private readonly contextBudget: LLMContextBudget;
  readonly tokenCountAccuracy = 'estimate' as const;
  get effectiveMaxInputTokens(): number | null { return this.contextBudget.effectiveMaxInputTokens; }
  getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null> { return this.contextBudget.getTokenCount(messages, tools); }
  resolveRuntimeMetadata(): Promise<void> { return this.contextBudget.resolveRuntimeMetadata(); }

  async complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse> {
    const body = buildAnthropicMessagesBody(this.profile, messages, tools);
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/v1/messages`, {
      method: 'POST',
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(body),
    }).catch(error => { throw mapProviderException(error); });

    if (!response.ok) {
      const text = await response.text();
      throwProviderErrorWithMetadata(text, providerResponseError('Anthropic messages', response.status, text), parseAnthropicMetadata);
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
  return new AnthropicMessagesClient(profile, apiKey, options.fetch ?? defaultFetch, options.metadataFetch);
}

export function buildAnthropicMessagesBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown> {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = prepareAnthropicPromptCaching(normalizedProfile, orderCompletedToolResults(messages.map((message) => messageSchema.parse(message))));
  const systemMessages = parsedMessages.filter((message) => message.role === 'system');
  const system = systemMessages.flatMap((message) => message.content.flatMap(toAnthropicContentBlocks));
  const maxTokens = normalizedProfile.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const thinkingBudget = getAnthropicThinkingBudget(normalizedProfile, maxTokens);
  const body: Record<string, unknown> = {
    model: normalizedProfile.model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(
      parsedMessages.filter((message) => message.role !== 'system'),
    ),
  };
  if (system.length > 0) {
    body.system = system;
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
  finalizeAnthropicCacheBreakpoints(normalizedProfile, body);
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

function toAnthropicMessages(messages: readonly Message[]): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') {
      result.push(toAnthropicMessage(message));
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

function toAnthropicMessage(message: Message): Record<string, unknown> {
  if (message.role === 'assistant') {
    return { role: 'assistant', content: toAnthropicAssistantContent(message) };
  }
  if (message.role === 'tool') {
    return { role: 'user', content: [toAnthropicToolResultBlock(message)] };
  }
  return {
    role: 'user',
    content: message.content.flatMap(toAnthropicContentBlocks),
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

  blocks.push(...message.content.filter(content => content.type !== 'text' || content.text.length > 0).flatMap(toAnthropicContentBlocks));
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
    content: message.content.every(content => content.type === 'text')
      ? reduceTextContent(message)
      : message.content.flatMap(content => toAnthropicContentBlocks({ ...content, cache_prompt: false })),
    ...(message.content.some(content => content.cache_prompt) ? { cache_control: ANTHROPIC_CACHE_CONTROL } : {}),
  };
}

function toAnthropicContentBlocks(content: Content): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = content.type === 'text'
    ? [{ type: 'text', text: content.text }]
    : content.image_urls.map(url => ({ type: 'image', source: { type: 'url', url } }));
  const last = blocks.at(-1);
  if (last && content.cache_prompt) last.cache_control = ANTHROPIC_CACHE_CONTROL;
  return blocks;
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
  return parseLlmResponseWithMetadata(raw, parseAnthropicMetadata, parseAnthropicContent);
}

function parseAnthropicMetadata(raw: unknown): LLMResponseMetadata {
  const parsed = anthropicMessagesResponseSchema.pick({ id: true, model: true, usage: true }).parse(raw);
  const usage = parsed.usage;
  // Unlike OpenAI, Anthropic's base input count excludes reads and writes.
  // TTL-specific cache_creation counters only subdivide the write count.
  // An absent optional category is unreported, not an assertion of zero usage.
  const promptTokens = usage?.input_tokens === undefined || usage.cache_read_input_tokens === undefined || usage.cache_creation_input_tokens === undefined
    ? undefined : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return llmResponseMetadataSchema.parse({
    usage: usage === null ? null : Object.fromEntries(Object.entries({
      promptTokens,
      completionTokens: usage.output_tokens,
      totalTokens: promptTokens === undefined || usage.output_tokens === undefined
        ? undefined : promptTokens + usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      providerUsage: usage,
    }).filter(([, value]) => value !== undefined)),
    ...(parsed.id === undefined ? {} : { responseId: parsed.id }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  });
}

function parseAnthropicContent(raw: unknown, metadata: LLMResponseMetadata): LLMCompletionResponse {
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
    ...metadata,
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
    id: z.string().optional(),
    model: z.string().optional(),
    role: z.literal('assistant').default('assistant'),
    content: z.array(anthropicContentBlockSchema),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).optional(),
        output_tokens: z.number().int().min(0).optional(),
        cache_read_input_tokens: z.number().int().min(0).optional(),
        cache_creation_input_tokens: z.number().int().min(0).optional(),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
