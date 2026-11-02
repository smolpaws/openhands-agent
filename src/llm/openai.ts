import { withAttemptDeadline } from './request-deadlines.js';
import { LLMContextBudget, type MetadataFetchLike } from './context-budget.js';
import type { LLMCompletionOptions, LLMTokenCountTool } from './client.js';
import { applyLLMCallContextHeaders, getLLMCallContext, type LLMCallContext } from './call-context.js';
import { replaceCredentialHeader, requestWithRecovery, type LLMRequestOptions } from './request-recovery.js';
import { providerResponseError, mapProviderException } from './exceptions.js';
import { orderCompletedToolResults } from './tool-result-order.js';
import { z } from 'zod';
import { platform, arch } from 'node:os';
import { OpenAISubscriptionAuth, OPENAI_CODEX_MODELS, CODEX_API_ENDPOINT, transformForSubscription } from './auth/index.js';
import { readSubscriptionResponse } from './auth/stream.js';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { llmCompletionResponseSchema, llmResponseMetadataSchema, parseLlmResponseWithMetadata, throwProviderErrorWithMetadata, type FetchLike, type FetchResponseLike, type LLMClient, type LLMCompletionResponse, type LLMResponseMetadata } from './client.js';
import {
  contentToString,
  messageSchema,
  textContent,
  type Content,
  type LLMProfile,
  type Message,
  type MessageToolCall,
} from './index.js';
import { isAnthropicModel, isReasoningModel, normalizeGenerationParamsForModel, resolveOpenAIPromptCacheKey, resolveOpenAIPromptCacheRetention, type PromptCacheMetadata } from './provider-quirks.js';
import { ANTHROPIC_CACHE_CONTROL, prepareAnthropicPromptCaching, finalizeAnthropicCacheBreakpoints } from './anthropic-prompt-cache.js';

export { llmCompletionResponseSchema, llmUsageSchema } from './client.js';
export type { FetchLike, FetchResponseLike, LLMClient, LLMCompletionResponse, LLMUsage } from './client.js';
export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface CreateLlmClientOptions extends LLMRequestOptions {
  readonly fetch?: FetchLike;
  readonly metadataFetch?: MetadataFetchLike;
  readonly subscriptionAuth?: OpenAISubscriptionAuth;
}

export class OpenAIChatClient implements LLMClient {
  readonly profile: LLMProfile;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(profile: LLMProfile, apiKey: string, fetchImpl: FetchLike = defaultFetch, metadataFetch?: MetadataFetchLike, private readonly requestOptions: LLMRequestOptions = {}) {
    this.profile = { ...profile, openAiApiMode: profile.openAiApiMode ?? 'chat_completions' };
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.contextBudget = new LLMContextBudget(profile, { ...(metadataFetch ? { fetch: metadataFetch } : {}), headers: buildHeaders(profile, apiKey) });
  }

  private readonly contextBudget: LLMContextBudget;
  readonly tokenCountAccuracy = 'estimate' as const;
  get effectiveMaxInputTokens(): number | null { return this.contextBudget.effectiveMaxInputTokens; }
  getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null> { return this.contextBudget.getTokenCount(messages, tools); }
  resolveRuntimeMetadata(): Promise<void> { return this.contextBudget.resolveRuntimeMetadata(); }

  async complete(messages: readonly Message[], tools?: readonly ToolDefinition[], options?: LLMCompletionOptions): Promise<LLMCompletionResponse> {
    const context = getLLMCallContext(options?.callContext);
    await this.contextBudget.resolvePromptCacheMetadata();
    const body = buildChatCompletionsBody(this.profile, messages, tools, context, this.contextBudget.promptCacheMetadata);
    const serializedBody = JSON.stringify(body);
    const raw = await requestWithRecovery(this.apiKey, this.requestOptions, (key, refreshed) => withAttemptDeadline(this.profile, async deadline => {
      const headers = buildHeaders(this.profile, key);
      const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/chat/completions`, {
        method: 'POST',
        headers: applyLLMCallContextHeaders(refreshed ? replaceCredentialHeader(headers, 'authorization', `Bearer ${key}`) : headers, context),
        body: serializedBody,
        signal: deadline.signal,
      }).catch(error => { throw mapProviderException(error); });
      if (!response.ok) {
        const text = await deadline.collect(() => response.text());
        throwProviderErrorWithMetadata(text, providerResponseError('OpenAI-compatible', response.status, text), raw => parseChatCompletionsMetadata(raw, this.profile));
      }
      return deadline.collect(() => response.json());
    }), this.profile.authType === 'api_key');

    return parseChatCompletionsResponse(raw, this.profile);
  }
}

export class OpenAIResponsesClient implements LLMClient {
  readonly profile: LLMProfile;
  constructor(
    profile: LLMProfile,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly subscriptionAuth?: OpenAISubscriptionAuth,
    metadataFetch?: MetadataFetchLike,
    private readonly requestOptions: LLMRequestOptions = {},
  ) {
    this.profile = { ...profile, openAiApiMode: profile.openAiApiMode ?? 'responses' };
    this.contextBudget = new LLMContextBudget(this.profile, { ...(metadataFetch ? { fetch: metadataFetch } : {}), headers: buildHeaders(this.profile, apiKey) });
  }

  private readonly contextBudget: LLMContextBudget;
  readonly tokenCountAccuracy = 'estimate' as const;
  get effectiveMaxInputTokens(): number | null { return this.contextBudget.effectiveMaxInputTokens; }
  getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null> { return this.contextBudget.getTokenCount(messages, tools); }
  resolveRuntimeMetadata(): Promise<void> { return this.contextBudget.resolveRuntimeMetadata(); }

  async complete(messages: readonly Message[], tools?: readonly ToolDefinition[], options?: LLMCompletionOptions): Promise<LLMCompletionResponse> {
    const context = getLLMCallContext(options?.callContext);
    let apiKey = this.apiKey;
    const headers = Object.fromEntries(Object.entries(this.profile.headers).filter(([name]) => !this.subscriptionAuth || !['authorization', 'chatgpt-account-id'].includes(name.toLowerCase())));
    if (this.subscriptionAuth) {
      const credentials = await this.subscriptionAuth.refreshIfNeeded();
      if (!credentials) throw new Error('OpenAI subscription login is required');
      apiKey = credentials.access_token;
      const accountId = await this.subscriptionAuth.extractChatGPTAccountId(credentials);
      Object.assign(headers, { originator: 'codex_cli_rs', 'OpenAI-Beta': 'responses=experimental', 'User-Agent': `openhands-sdk (${platform()}; ${arch()})` });
      if (accountId) headers['chatgpt-account-id'] = accountId;
    }
    await this.contextBudget.resolvePromptCacheMetadata();
    const serializedBody = JSON.stringify(buildOpenAIResponsesBody(this.profile, messages, tools, context, this.contextBudget.promptCacheMetadata));
    const raw = await requestWithRecovery(apiKey, this.requestOptions, (key, refreshed) => withAttemptDeadline(this.profile, async deadline => {
      const requestHeaders = buildHeaders({ ...this.profile, headers }, key);
      const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/responses`, {
        method: 'POST',
        headers: applyResponsesCallContextHeaders(refreshed ? replaceCredentialHeader(requestHeaders, 'authorization', `Bearer ${key}`) : requestHeaders, context, this.profile.authType === 'subscription'),
        body: serializedBody,
        signal: deadline.signal,
      }).catch(error => { throw mapProviderException(error); });
      if (!response.ok) {
        const text = await deadline.collect(() => response.text());
        throwProviderErrorWithMetadata(text, providerResponseError(this.subscriptionAuth ? 'OpenAI subscription' : 'OpenAI Responses', response.status, text), parseOpenAIResponsesMetadata);
      }
      return deadline.collect(async () => {
        let terminalResponse: unknown;
        try {
          return this.subscriptionAuth
            ? await readSubscriptionResponse(response, received => { terminalResponse = received; }, deadline)
            : await response.json();
        } catch (error) {
          if (terminalResponse !== undefined) throwProviderErrorWithMetadata(terminalResponse, error, parseOpenAIResponsesMetadata);
          throw error;
        }
      });
    }), !this.subscriptionAuth && this.profile.authType === 'api_key');
    return parseOpenAIResponsesResponse(raw);
  }
}

function applyResponsesCallContextHeaders(headers: Readonly<Record<string, string>>, context: LLMCallContext, subscription: boolean): Readonly<Record<string, string>> {
  const contextualHeaders = applyLLMCallContextHeaders(headers, context);
  if (!subscription || !context.sessionId) return contextualHeaders;
  // Codex cache affinity needs conversation identity as well as the body cache key.
  // Replace configured variants without changing the saved profile or a shared client.
  return {
    ...Object.fromEntries(Object.entries(contextualHeaders).filter(([name]) => !['session-id', 'thread-id'].includes(name.toLowerCase()))),
    'session-id': context.sessionId,
    'thread-id': context.sessionId,
  };
}

export async function createOpenAIChatClientFromProfile(
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
  return new OpenAIChatClient(profile, apiKey, options.fetch ?? defaultFetch, options.metadataFetch, options);
}

export async function createOpenAIResponsesClientFromProfile(
  profile: LLMProfile,
  store: SecretStore,
  options: CreateLlmClientOptions = {},
): Promise<OpenAIResponsesClient> {
  if (profile.authType === 'subscription') {
    if (profile.providerId !== 'openai' || (profile.subscriptionVendor !== null && profile.subscriptionVendor !== 'openai')) throw new Error('Unsupported subscription vendor');
    const model = profile.model.replace(/^openai\//u, '');
    if (!OPENAI_CODEX_MODELS.includes(model)) throw new Error(`Model '${model}' is not supported for subscription access`);
    const auth = options.subscriptionAuth ?? new OpenAISubscriptionAuth();
    if (!await auth.refreshIfNeeded()) throw new Error('OpenAI subscription login is required');
    const runtimeProfile: LLMProfile = { ...profile, model, baseUrl: CODEX_API_ENDPOINT.slice(0, -'/responses'.length), openAiApiMode: 'responses', temperature: null, maxOutputTokens: null, subscriptionVendor: 'openai' };
    return new OpenAIResponsesClient(runtimeProfile, '', options.fetch ?? defaultFetch, auth, options.metadataFetch, options);
  }
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
  return new OpenAIResponsesClient(profile, apiKey, options.fetch ?? defaultFetch, undefined, options.metadataFetch, options);
}

function applyOpenAIPromptCacheOptions(body: Record<string, unknown>, profile: LLMProfile, context?: LLMCallContext, metadata?: PromptCacheMetadata): void {
  const retention = resolveOpenAIPromptCacheRetention(profile);
  if (retention !== undefined) {
    body.prompt_cache_retention = retention;
  }

  const cacheKey = resolveOpenAIPromptCacheKey(profile, context?.promptCacheKey, metadata);
  if (cacheKey !== undefined) {
    body.prompt_cache_key = cacheKey;
  }
}

export function buildChatCompletionsBody(
  profile: LLMProfile,
  messages: readonly Message[],
  tools: readonly ToolDefinition[] = [],
  context?: LLMCallContext,
  metadata?: PromptCacheMetadata,
): Record<string, unknown> {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const sendReasoningContent = isReasoningModel(normalizedProfile);
  // DeepSeek tool requests require this field on every historical assistant turn, including
  // turns from non-thinking/foreign models. An empty value records absence, not invented thought.
  const requireReasoningContent = tools.length > 0 && sendReasoningContent && normalizedProfile.model.toLowerCase().includes('deepseek');
  const history = messages.map((message) => messageSchema.parse(message)).map((message) =>
    requireReasoningContent && message.role === 'assistant' && message.reasoning_content === null
      ? { ...message, reasoning_content: '' } : message);
  const body: Record<string, unknown> = {
    model: wireModelName(normalizedProfile),
    messages: prepareAnthropicPromptCaching(normalizedProfile, orderCompletedToolResults(history)).map((message) => toOpenAIChatMessage(message, sendReasoningContent)),
  };
  if (tools.length > 0) {
    body.tools = tools.map(toOpenAIChatTool);
  }
  if (normalizedProfile.temperature !== null) {
    body.temperature = normalizedProfile.temperature;
  }
  if (normalizedProfile.topP !== null) {
    body.top_p = normalizedProfile.topP;
  }
  if (normalizedProfile.maxOutputTokens !== null) {
    body.max_completion_tokens = normalizedProfile.maxOutputTokens;
  }
  if (normalizedProfile.reasoningEffort !== null) {
    body.reasoning_effort = normalizedProfile.reasoningEffort;
  }
  applyOpenAIPromptCacheOptions(body, normalizedProfile, context, metadata);
  if (normalizedProfile.verbosity !== undefined) body.verbosity = normalizedProfile.verbosity;
  finalizeAnthropicCacheBreakpoints(normalizedProfile, body);
  return body;
}

export function buildOpenAIResponsesBody(
  profile: LLMProfile,
  messages: readonly Message[],
  tools: readonly ToolDefinition[] = [],
  context?: LLMCallContext,
  metadata?: PromptCacheMetadata,
): Record<string, unknown> {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = orderCompletedToolResults(messages.map((message) => messageSchema.parse(message)));
  const instructions = parsedMessages.filter((message) => message.role === 'system').flatMap((message) => contentToString(message.content));
  const body: Record<string, unknown> = {
    model: wireModelName(normalizedProfile),
    input: parsedMessages.filter((message) => message.role !== 'system').flatMap(toOpenAIResponsesInputItems),
    include: ['reasoning.encrypted_content'],
    store: false,
  };
  if (instructions.length > 0) {
    body.instructions = instructions.join('\n');
  }
  if (tools.length > 0) {
    body.tools = tools.map((tool) => tool.toResponsesTool());
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
  if (normalizedProfile.verbosity !== undefined) body.text = { verbosity: normalizedProfile.verbosity };
  if (profile.authType === 'subscription') {
    const [subscriptionInstructions, input] = transformForSubscription(instructions, (body.input as Record<string, unknown>[]).filter(item => item.type !== 'reasoning'));
    body.instructions = subscriptionInstructions;
    body.input = input;
    body.stream = true;
    delete body.temperature;
    delete body.max_output_tokens;
    delete body.include;
    // Subscription Responses accepts explicit effort/summary; retain the selected profile options.
  }
  applyOpenAIPromptCacheOptions(body, normalizedProfile, context, metadata);
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
    // Item IDs are provider-issued fc_* identifiers, distinct from call_id.
    // Foreign Chat/Anthropic history has no Responses item ID; omit this optional field.
    ...(toolCall.responses_item_id === null ? {} : { id: toolCall.responses_item_id }),
    call_id: callId,
    name: toolCall.name,
    arguments: toolCall.arguments,
  };
}

function normalizeResponsesCallId(value: string): string {
  return value.startsWith('call_') ? value : `call_${value.replace(/[^a-zA-Z0-9_-]/gu, '_')}`;
}

function toOpenAIChatTool(tool: ToolDefinition): Record<string, unknown> {
  const responsesTool = tool.toResponsesTool();
  return {
    type: 'function',
    function: {
      name: responsesTool.name,
      description: responsesTool.description,
      parameters: responsesTool.parameters,
      strict: responsesTool.strict,
    },
  };
}

function toOpenAIChatMessage(message: Message, sendReasoningContent = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: message.role,
    content: serializeContent(message.content, message.role !== 'tool'),
  };
  if (message.role === 'tool' && message.content.some(content => content.cache_prompt)) {
    out.cache_control = ANTHROPIC_CACHE_CONTROL;
  }
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
  // Thinking/reasoning models (e.g. DeepSeek dual-mode, Kimi thinking) require the
  // prior assistant turn's reasoning to be echoed back, or the provider 400s. Only
  // assistant messages carry reasoning; only send it when the model reasons.
  if (sendReasoningContent && message.role === 'assistant') {
    if (message.reasoning_content !== null) {
      out.reasoning_content = message.reasoning_content;
    }
    if (message.thinking_blocks.length > 0) {
      out.thinking_blocks = message.thinking_blocks;
    }
  }
  return out;
}

function serializeContent(content: readonly Content[], includeCacheControl = false): string | readonly Record<string, unknown>[] {
  if (content.every((item) => item.type === 'text') && !(includeCacheControl && content.some(item => item.cache_prompt))) {
    return contentToString(content).join('\n');
  }
  return content.flatMap((item) => {
    const blocks: Record<string, unknown>[] = item.type === 'text'
      ? [{ type: 'text', text: item.text }]
      : item.image_urls.map(url => ({ type: 'image_url', image_url: { url } }));
    const last = blocks.at(-1);
    if (last && includeCacheControl && item.cache_prompt) last.cache_control = ANTHROPIC_CACHE_CONTROL;
    return blocks;
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

function parseChatCompletionsResponse(raw: unknown, profile: LLMProfile): LLMCompletionResponse {
  return parseLlmResponseWithMetadata(raw, value => parseChatCompletionsMetadata(value, profile), parseChatCompletionsContent);
}

function parseChatCompletionsMetadata(raw: unknown, profile: LLMProfile): LLMResponseMetadata {
  const parsed = openAIChatCompletionResponseSchema.pick({ id: true, model: true, usage: true }).parse(raw);
  const usage = parsed.usage;
  const isOpenRouter = profile.providerId === 'openrouter' || new URL(resolveBaseUrl(profile)).hostname === 'openrouter.ai';
  const isAnthropic = isAnthropicModel(profile);
  return llmResponseMetadataSchema.parse({
    // Input/output totals already include their cache/reasoning breakdowns.
    // DeepSeek's two cached-token fields are aliases, not separate usage.
    usage: usage === null ? null : Object.fromEntries(Object.entries({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cacheReadTokens: usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens
        ?? (isAnthropic ? usage.cache_read_input_tokens ?? undefined : undefined),
      cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens
        ?? (isAnthropic ? usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens ?? undefined : undefined),
      cacheMissTokens: usage.prompt_cache_miss_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      reportedCost: isOpenRouter && typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
        ? { amount: usage.cost, currency: 'credits' } : undefined,
      providerUsage: usage,
    }).filter(([, value]) => value !== undefined)),
    ...(parsed.id === undefined ? {} : { responseId: parsed.id }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  });
}

function parseChatCompletionsContent(raw: unknown, metadata: LLMResponseMetadata): LLMCompletionResponse {
  const parsed = openAIChatCompletionResponseSchema.parse(raw);
  const firstChoice = parsed.choices[0];
  if (firstChoice === undefined) {
    throw new Error('OpenAI-compatible completion returned no choices.');
  }

  const message = messageSchema.parse({
    role: firstChoice.message.role,
    content: firstChoice.message.content,
    tool_calls: firstChoice.message.tool_calls?.map(fromOpenAIChatToolCall) ?? null,
    // Preserve the model's reasoning so it can be threaded back on the next turn
    // for reasoning models that require it (see isReasoningModel / toOpenAIChatMessage).
    reasoning_content: firstChoice.message.reasoning_content,
  });

  return llmCompletionResponseSchema.parse({
    message,
    ...metadata,
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
  if (typeof raw === 'object' && raw !== null) {
    const response = raw as Record<string, unknown>;
    if (response.status === 'failed' || response.status === 'incomplete' || response.error)
      throwProviderErrorWithMetadata(raw, providerResponseError('OpenAI Responses', 200, response.error ?? response.incomplete_details), parseOpenAIResponsesMetadata);
  }
  return parseLlmResponseWithMetadata(raw, parseOpenAIResponsesMetadata, parseOpenAIResponsesContent);
}

function parseOpenAIResponsesMetadata(raw: unknown): LLMResponseMetadata {
  const parsed = openAIResponsesResponseSchema.pick({ id: true, model: true, usage: true }).parse(raw);
  return llmResponseMetadataSchema.parse({
    usage: parsed.usage === null ? null : Object.fromEntries(Object.entries({
      promptTokens: parsed.usage.input_tokens,
      completionTokens: parsed.usage.output_tokens,
      totalTokens: parsed.usage.total_tokens,
      cacheReadTokens: parsed.usage.input_tokens_details?.cached_tokens,
      cacheWriteTokens: parsed.usage.input_tokens_details?.cache_write_tokens,
      reasoningTokens: parsed.usage.output_tokens_details?.reasoning_tokens,
      providerUsage: parsed.usage,
    }).filter(([, value]) => value !== undefined)),
    ...(parsed.id === undefined ? {} : { responseId: parsed.id }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  });
}

function parseOpenAIResponsesContent(raw: unknown, metadata: LLMResponseMetadata): LLMCompletionResponse {
  const parsed = openAIResponsesResponseSchema.parse(raw);
  const text = parsed.output
    .filter((item): item is OpenAIResponsesMessageItem => item.type === 'message')
    .flatMap((item) => item.content)
    .filter((content): content is OpenAIResponsesOutputText => content.type === 'output_text')
    .map((content) => content.text)
    .join('\n').trim();
  const reasoningItem = parsed.output.filter((item): item is OpenAIResponsesReasoningItem => item.type === 'reasoning').at(-1) ?? null;
  const toolCalls = parsed.output
    .filter((item): item is OpenAIResponsesFunctionCallItem => item.type === 'function_call')
    .map(fromOpenAIResponsesFunctionCall);

  return llmCompletionResponseSchema.parse({
    message: {
      role: 'assistant',
      content: text ? [textContent(text)] : [],
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      responses_reasoning_item: reasoningItem === null ? null : {
        id: reasoningItem.id,
        summary: normalizeResponsesReasoningSummary(reasoningItem.summary),
        content: normalizeResponsesReasoningContent(reasoningItem.content),
        encrypted_content: reasoningItem.encrypted_content ?? null,
        status: reasoningItem.status ?? null,
      },
    },
    ...metadata,
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
  return summary.map((item) => item.text);
}

function normalizeResponsesReasoningContent(content: readonly OpenAIResponsesReasoningContentItem[] | null): string[] | null {
  if (content === null) {
    return null;
  }
  const values = content.map((item) => item.text);
  return values.length > 0 ? values : null;
}


function resolveBaseUrl(profile: LLMProfile): string {
  const baseUrl = profile.baseUrl ?? defaultBaseUrlForProvider(profile.providerId);
  return baseUrl.replace(/\/+$/u, '');
}

function defaultBaseUrlForProvider(providerId: string): string {
  if (providerId.toLowerCase() === 'digitalocean') return 'https://inference.do-ai.run/v1';
  if (providerId === 'openrouter') {
    return DEFAULT_OPENROUTER_BASE_URL;
  }
  return DEFAULT_OPENAI_BASE_URL;
}

function wireModelName(profile: LLMProfile): string {
  return profile.providerId.toLowerCase() === 'digitalocean' ? profile.model.replace(/^digitalocean\//u, '') : profile.model;
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

// Providers add fields we don't consume on tool calls — e.g. DeepSeek returns a
// streaming-style `index` on each non-stream tool_call. Upstream Python routes
// through LiteLLM, which normalizes these away; this transpilation talks to
// providers directly, so we tolerate unknown keys here instead of rejecting the
// whole response. We strip (not passthrough): unknown keys are accepted and
// dropped, so nothing extra rides on the typed object. The untouched response is
// still preserved as `raw` by parseChatCompletionsResponse.
const openAIChatToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function').default('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

type OpenAIChatToolCall = z.infer<typeof openAIChatToolCallSchema>;

const openAIChatCompletionResponseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    choices: z.array(
      z
        .object({
          message: z
            .object({
              role: z.union([z.literal('assistant'), z.literal('tool'), z.literal('user'), z.literal('system')]),
              content: z.string().nullable().default(null),
              tool_calls: z.array(openAIChatToolCallSchema).optional(),
              reasoning_content: z.string().nullable().default(null),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().min(0).optional(),
        completion_tokens: z.number().int().min(0).optional(),
        total_tokens: z.number().int().min(0).optional(),
        prompt_cache_hit_tokens: z.number().int().min(0).optional(),
        prompt_cache_miss_tokens: z.number().int().min(0).optional(),
        cache_read_input_tokens: z.number().int().min(0).nullish(),
        cache_creation_input_tokens: z.number().int().min(0).nullish(),
        prompt_tokens_details: z.object({
          cached_tokens: z.number().int().min(0).optional(),
          cache_write_tokens: z.number().int().min(0).optional(),
          cache_creation_tokens: z.number().int().min(0).nullish(),
        }).passthrough().nullish(),
        completion_tokens_details: z.object({
          reasoning_tokens: z.number().int().min(0).optional(),
        }).passthrough().nullish(),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();

const openAIResponsesOutputTextSchema = z.object({ type: z.literal('output_text'), text: z.string() }).passthrough();
const openAIResponsesContentItemSchema = openAIResponsesOutputTextSchema;
const openAIResponsesMessageItemSchema = z
  .object({
    type: z.literal('message'),
    content: z.array(openAIResponsesContentItemSchema).default([]),
  })
  .passthrough();
const openAIResponsesReasoningSummaryItemSchema = z
  .object({
    text: z.string().default(''),
  })
  .passthrough();
const openAIResponsesReasoningContentItemSchema = z
  .object({
    text: z.string().default(''),
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
    name: z.string().default(''),
    arguments: z.string().default(''),
  })
  .passthrough();
const openAIResponsesOutputItemSchema = z.union([
  openAIResponsesMessageItemSchema,
  openAIResponsesReasoningItemSchema,
  openAIResponsesFunctionCallItemSchema,
]);

/** Python's typed projection ignores unused kinds but still validates fields it consumes. */
function normalizeResponsesOutput(value: unknown): unknown {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return value;
  return value.flatMap<unknown>((item: unknown) => {
    if (!isRecord(item)) return [];
    if (item.type === 'message') {
      const parts: unknown = item.content ?? [];
      const content = Array.isArray(parts) ? parts.filter((part: unknown) => isRecord(part) && part.type === 'output_text' && pythonTruthy(part.text)) : parts;
      return [{ ...item, content }];
    }
    if (item.type === 'function_call') {
      const callId = z.string().nullish().parse(item.call_id);
      return [{ ...item,
        call_id: callId || (pythonTruthy(item.id) ? item.id : ''),
        id: pythonTruthy(item.id) ? pythonItemId(item.id) : null,
      }];
    }
    if (item.type === 'reasoning') return [{ ...item, summary: item.summary ?? [], content: item.content ?? null }];
    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pythonTruthy(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.length > 0;
  return !isRecord(value) || Object.keys(value).length > 0;
}

function pythonItemId(value: unknown): string {
  // Generic JSON Responses items may carry a numeric ID while call_id is a string.
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value) || isRecord(value)) return pythonJsonRepr(value);
  return z.string().parse(value);
}

function pythonJsonRepr(value: unknown): string {
  if (typeof value === 'string') {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + Array.from(value, character => {
      if (character === '\\' || character === quote) return `\\${character}`;
      if (character === '\n') return '\\n';
      if (character === '\r') return '\\r';
      if (character === '\t') return '\\t';
      if (character.charCodeAt(0) < 32 || character === '\x7f') return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
      return character;
    }).join('') + quote;
  }
  if (Array.isArray(value)) return `[${value.map(pythonJsonRepr).join(', ')}]`;
  if (isRecord(value)) return `{${Object.entries(value).map(([key, item]) => `${pythonJsonRepr(key)}: ${pythonJsonRepr(item)}`).join(', ')}}`;
  return pythonItemId(value);
}

type OpenAIResponsesOutputText = z.infer<typeof openAIResponsesOutputTextSchema>;
type OpenAIResponsesMessageItem = z.infer<typeof openAIResponsesMessageItemSchema>;
type OpenAIResponsesReasoningItem = z.infer<typeof openAIResponsesReasoningItemSchema>;
type OpenAIResponsesReasoningSummaryItem = z.infer<typeof openAIResponsesReasoningSummaryItemSchema>;
type OpenAIResponsesReasoningContentItem = z.infer<typeof openAIResponsesReasoningContentItemSchema>;
type OpenAIResponsesFunctionCallItem = z.infer<typeof openAIResponsesFunctionCallItemSchema>;

const openAIResponsesResponseSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    output: z.preprocess(normalizeResponsesOutput, z.array(openAIResponsesOutputItemSchema)),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).optional(),
        output_tokens: z.number().int().min(0).optional(),
        total_tokens: z.number().int().min(0).optional(),
        input_tokens_details: z.object({
          cached_tokens: z.number().int().min(0).optional(),
          cache_write_tokens: z.number().int().min(0).optional(),
        }).passthrough().nullish(),
        output_tokens_details: z.object({
          reasoning_tokens: z.number().int().min(0).optional(),
        }).passthrough().nullish(),
      })
      .passthrough()
      .nullable()
      .default(null),
  })
  .passthrough();
