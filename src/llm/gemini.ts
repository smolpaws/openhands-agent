import { LLMContextBudget, type MetadataFetchLike } from './context-budget.js';
import type { LLMTokenCountTool } from './client.js';
import { providerResponseError, mapProviderException } from './exceptions.js';
import { orderCompletedToolResults } from './tool-result-order.js';
import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { JsonObject, ToolDefinition } from '../tool/index.js';
import { llmCompletionResponseSchema, llmResponseMetadataSchema, parseLlmResponseWithMetadata, throwProviderErrorWithMetadata, type FetchLike, type LLMClient, type LLMCompletionResponse, type LLMResponseMetadata } from './client.js';
import { contentToString, messageSchema, type Content, type LLMProfile, type Message, type MessageToolCall } from './index.js';

export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface CreateGeminiClientOptions {
  readonly fetch?: FetchLike;
  readonly metadataFetch?: MetadataFetchLike;
}

export class GeminiClient implements LLMClient {
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
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/interactions`, {
      method: 'POST',
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(buildGeminiInteractionsBody(this.profile, messages, tools)),
    }).catch(error => { throw mapProviderException(error); });

    if (!response.ok) {
      const text = await response.text();
      throwProviderErrorWithMetadata(text, providerResponseError('Gemini Interactions', response.status, text), parseGeminiMetadata);
    }

    return parseGeminiInteractionResponse(await response.json());
  }
}

export async function createGeminiClientFromProfile(
  profile: LLMProfile,
  store: SecretStore,
  options: CreateGeminiClientOptions = {},
): Promise<GeminiClient> {
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
      `Missing API key for Gemini LLM profile '${profile.profileId}'. Set provider key '${profile.providerId}' or enable and set a profile override.`,
    );
  }
  return new GeminiClient(profile, apiKey, options.fetch ?? defaultFetch, options.metadataFetch);
}

export function buildGeminiInteractionsBody(
  profile: LLMProfile,
  messages: readonly Message[],
  tools: readonly ToolDefinition[] = [],
): Record<string, unknown> {
  assertSupportedGenerationParams(profile);
  const parsedMessages = orderCompletedToolResults(messages.map((message) => messageSchema.parse(message)));
  const systemInstruction = parsedMessages
    .filter((message) => message.role === 'system')
    .flatMap((message) => contentToString(message.content))
    .join('\n');
  const body: Record<string, unknown> = {
    model: profile.model,
    store: false,
    input: parsedMessages
      .filter((message) => message.role !== 'system')
      .flatMap(toGeminiInteractionSteps),
  };
  if (systemInstruction.length > 0) {
    body.system_instruction = systemInstruction;
  }
  if (tools.length > 0) {
    body.tools = tools.map(toGeminiInteractionTool);
  }
  const generationConfig = buildGenerationConfig(profile, tools.length > 0);
  if (Object.keys(generationConfig).length > 0) {
    body.generation_config = generationConfig;
  }
  return body;
}

function assertSupportedGenerationParams(profile: LLMProfile): void {
  const unsupported = [
    ['temperature', profile.temperature],
    ['topP', profile.topP],
    ['topK', profile.topK],
  ].filter((entry): entry is [string, number] => entry[1] !== null);
  if (unsupported.length > 0) {
    throw new Error(
      `Gemini Interactions does not support profile fields: ${unsupported.map(([name]) => name).join(', ')}.`,
    );
  }
}

function buildGenerationConfig(profile: LLMProfile, hasTools: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (profile.maxOutputTokens !== null) {
    config.max_output_tokens = profile.maxOutputTokens;
  }
  if (profile.reasoningEffort !== null) {
    config.thinking_level = profile.reasoningEffort;
    config.thinking_summaries = 'auto';
  }
  if (hasTools) {
    config.tool_choice = 'auto';
  }
  return config;
}

function toGeminiInteractionTool(tool: ToolDefinition): Record<string, unknown> {
  const responsesTool = tool.toResponsesTool();
  return {
    type: 'function',
    name: responsesTool.name,
    description: responsesTool.description,
    parameters: stripUnsupportedSchemaProperties(responsesTool.parameters),
  };
}

function stripUnsupportedSchemaProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUnsupportedSchemaProperties);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schema' && key !== 'additionalProperties')
      .map(([key, child]) => [key, stripUnsupportedSchemaProperties(child)]),
  );
}

function toGeminiInteractionSteps(message: Message): readonly Record<string, unknown>[] {
  if (message.role === 'user') {
    return [{ type: 'user_input', content: toGeminiContent(message.content) }];
  }
  if (message.role === 'tool') {
    if (message.tool_call_id === null) {
      throw new Error('Gemini function result requires a tool_call_id.');
    }
    const step: Record<string, unknown> = {
      type: 'function_result',
      call_id: message.tool_call_id,
      result: toGeminiContent(message.content),
    };
    if (message.name !== null) {
      step.name = message.name;
    }
    return [step];
  }

  const steps: Record<string, unknown>[] = [];
  for (const block of message.thinking_blocks) {
    if (block.type !== 'thinking') {
      continue;
    }
    const step: Record<string, unknown> = {
      type: 'thought',
      summary: block.thinking.length === 0 ? [] : [{ type: 'text', text: block.thinking }],
    };
    if (block.signature !== null) {
      step.signature = block.signature;
    }
    steps.push(step);
  }
  const content = toGeminiContent(message.content);
  if (content.length > 0) {
    steps.push({ type: 'model_output', content });
  }
  if (message.tool_calls !== null) {
    steps.push(...message.tool_calls.map(toGeminiFunctionCallStep));
  }
  return steps;
}

function toGeminiContent(content: readonly Content[]): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const item of content) {
    if (item.type === 'text') {
      if (item.text.length > 0) {
        result.push({ type: 'text', text: item.text });
      }
    } else {
      result.push(...item.image_urls.map((uri) => ({ type: 'image', uri })));
    }
  }
  return result;
}

function toGeminiFunctionCallStep(toolCall: MessageToolCall): Record<string, unknown> {
  return {
    type: 'function_call',
    id: toolCall.id,
    name: toolCall.name,
    arguments: parseFunctionCallArguments(toolCall),
  };
}

function parseFunctionCallArguments(toolCall: MessageToolCall): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.arguments) as unknown;
  } catch {
    throw new Error(`Gemini function call '${toolCall.id}' arguments must be a valid JSON object.`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Gemini function call '${toolCall.id}' arguments must be a valid JSON object.`);
  }
  return parsed;
}

function parseGeminiInteractionResponse(raw: unknown): LLMCompletionResponse {
  return parseLlmResponseWithMetadata(raw, parseGeminiMetadata, parseGeminiContent);
}

function parseGeminiMetadata(raw: unknown): LLMResponseMetadata {
  const parsed = geminiInteractionResponseSchema.pick({ id: true, model: true, usage: true }).parse(raw);
  return llmResponseMetadataSchema.parse({
    // Interactions reports thoughts separately from visible output. Cache reads
    // are already in input; internal tool prompts remain a separate category.
    usage: parsed.usage === null ? null : Object.fromEntries(Object.entries({
      promptTokens: parsed.usage.total_input_tokens,
      completionTokens: parsed.usage.total_output_tokens === undefined || parsed.usage.total_thought_tokens === undefined
        ? undefined : parsed.usage.total_output_tokens + parsed.usage.total_thought_tokens,
      totalTokens: parsed.usage.total_tokens,
      cacheReadTokens: parsed.usage.total_cached_tokens,
      reasoningTokens: parsed.usage.total_thought_tokens,
      toolUsePromptTokens: parsed.usage.total_tool_use_tokens,
      providerUsage: parsed.usage,
    }).filter(([, value]) => value !== undefined)),
    ...(parsed.id === undefined ? {} : { responseId: parsed.id }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  });
}

function parseGeminiContent(raw: unknown, metadata: LLMResponseMetadata): LLMCompletionResponse {
  const parsed = geminiInteractionResponseSchema.parse(raw);
  const modelOutputSteps = parsed.steps.filter((step): step is GeminiModelOutputStep => step.type === 'model_output');
  const text = modelOutputSteps
    .flatMap((step) => step.content)
    .filter((content): content is GeminiTextContent => content.type === 'text')
    .map((content) => content.text)
    .join('\n');
  const thoughtSteps = parsed.steps.filter((step): step is GeminiThoughtStep => step.type === 'thought');
  const thinkingBlocks = thoughtSteps.map((step) => {
    const thinking = step.summary
      .filter((content): content is GeminiTextContent => content.type === 'text')
      .map((content) => content.text)
      .join('');
    return { type: 'thinking' as const, thinking, signature: step.signature ?? null };
  });
  const reasoningContent = thinkingBlocks.map((block) => block.thinking).join('');
  const toolCalls = parsed.steps
    .filter((step): step is GeminiFunctionCallStep => step.type === 'function_call')
    .map(fromGeminiFunctionCallStep);

  return llmCompletionResponseSchema.parse({
    message: {
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      reasoning_content: reasoningContent.length > 0 ? reasoningContent : null,
      thinking_blocks: thinkingBlocks,
    },
    ...metadata,
    raw,
  });
}

function fromGeminiFunctionCallStep(step: GeminiFunctionCallStep): MessageToolCall {
  return {
    id: step.id,
    responses_item_id: null,
    name: step.name,
    arguments: JSON.stringify(step.arguments),
    origin: 'completion',
  };
}

function resolveBaseUrl(profile: LLMProfile): string {
  return (profile.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/u, '');
}

function buildHeaders(profile: LLMProfile, apiKey: string): Readonly<Record<string, string>> {
  return {
    'x-goog-api-key': apiKey,
    'content-type': 'application/json',
    ...profile.headers,
  };
}

async function defaultFetch(
  url: string,
  init: { readonly method: 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body: string },
) {
  return globalThis.fetch(url, init);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const geminiTextContentSchema = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const geminiOtherContentSchema = z
  .object({ type: z.string().refine((type) => type !== 'text') })
  .passthrough();
const geminiContentSchema = z.union([geminiTextContentSchema, geminiOtherContentSchema]);
const geminiModelOutputStepSchema = z
  .object({ type: z.literal('model_output'), content: z.array(geminiContentSchema).default([]) })
  .passthrough();
const geminiThoughtStepSchema = z
  .object({
    type: z.literal('thought'),
    signature: z.string().nullable().optional(),
    summary: z.array(geminiContentSchema).default([]),
  })
  .passthrough();
const geminiFunctionCallStepSchema = z
  .object({
    type: z.literal('function_call'),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const knownGeminiStepTypes = new Set(['model_output', 'thought', 'function_call']);
const geminiOtherStepSchema = z
  .object({ type: z.string().refine((type) => !knownGeminiStepTypes.has(type)) })
  .passthrough();
const geminiStepSchema = z.union([
  geminiModelOutputStepSchema,
  geminiThoughtStepSchema,
  geminiFunctionCallStepSchema,
  geminiOtherStepSchema,
]);
const geminiUsageSchema = z
  .object({
    total_input_tokens: z.number().int().min(0).optional(),
    total_output_tokens: z.number().int().min(0).optional(),
    total_tokens: z.number().int().min(0).optional(),
    total_cached_tokens: z.number().int().min(0).optional(),
    total_thought_tokens: z.number().int().min(0).optional(),
    total_tool_use_tokens: z.number().int().min(0).optional(),
  })
  .passthrough();
const geminiInteractionResponseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    steps: z.array(geminiStepSchema).default([]),
    usage: geminiUsageSchema.nullable().default(null),
  })
  .passthrough();

type GeminiTextContent = z.infer<typeof geminiTextContentSchema>;
type GeminiModelOutputStep = z.infer<typeof geminiModelOutputStepSchema>;
type GeminiThoughtStep = z.infer<typeof geminiThoughtStepSchema>;
type GeminiFunctionCallStep = z.infer<typeof geminiFunctionCallStepSchema>;
