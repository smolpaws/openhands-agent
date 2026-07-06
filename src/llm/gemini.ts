import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import { llmCompletionResponseSchema, type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { contentToString, messageSchema, type Content, type LLMProfile, type Message, type MessageToolCall } from './index.js';
import { normalizeGenerationParamsForModel, toGeminiThinkingLevel } from './provider-quirks.js';

export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface CreateGeminiClientOptions {
  readonly fetch?: FetchLike;
}

export class GeminiClient implements LLMClient {
  readonly profile: LLMProfile;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(profile: LLMProfile, apiKey: string, fetchImpl: FetchLike = defaultFetch) {
    this.profile = profile;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async complete(messages: readonly Message[]): Promise<LLMCompletionResponse> {
    const response = await this.fetchImpl(`${resolveBaseUrl(this.profile)}/models/${encodeURIComponent(this.profile.model)}:generateContent`, {
      method: 'POST',
      headers: buildHeaders(this.profile, this.apiKey),
      body: JSON.stringify(buildGeminiGenerateContentBody(this.profile, messages)),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini generateContent failed with HTTP ${response.status}: ${text}`);
    }

    return parseGeminiGenerateContentResponse(await response.json());
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
  return new GeminiClient(profile, apiKey, options.fetch ?? defaultFetch);
}

export function buildGeminiGenerateContentBody(profile: LLMProfile, messages: readonly Message[]): Record<string, unknown> {
  const normalizedProfile = normalizeGenerationParamsForModel(profile);
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const system = parsedMessages.filter((message) => message.role === 'system').flatMap((message) => contentToString(message.content));
  const body: Record<string, unknown> = {
    contents: parsedMessages.filter((message) => message.role !== 'system').map(toGeminiContent),
  };
  if (system.length > 0) {
    body.systemInstruction = { parts: system.map((text) => ({ text })) };
  }
  const generationConfig = buildGenerationConfig(normalizedProfile);
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

function toGeminiContent(message: Message): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'user',
      parts: [{ functionResponse: { name: message.name ?? 'unknown_tool', response: { content: contentToString(message.content).join('\n') } } }],
    };
  }
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(message),
  };
}

function toGeminiParts(message: Message): readonly Record<string, unknown>[] {
  const signature = firstThinkingSignature(message);
  const parts = message.content.flatMap((content) => {
    if (content.type === 'text' && content.text.length === 0) {
      return [];
    }
    return [toGeminiPart(content, signature)];
  });
  if (message.tool_calls !== null) {
    parts.push(...message.tool_calls.map((toolCall, index) => toGeminiFunctionCallPart(toolCall, index === 0 ? signature : null)));
  }
  return parts;
}

function toGeminiPart(content: Content, thoughtSignature: string | null): Record<string, unknown> {
  if (content.type === 'text') {
    const part: Record<string, unknown> = { text: content.text };
    if (thoughtSignature !== null) {
      part.thoughtSignature = thoughtSignature;
    }
    return part;
  }
  return { fileData: { fileUri: content.image_urls[0] ?? '' } };
}

function toGeminiFunctionCallPart(toolCall: MessageToolCall, thoughtSignature: string | null): Record<string, unknown> {
  const part: Record<string, unknown> = { functionCall: { name: toolCall.name, args: parseToolArguments(toolCall.arguments) } };
  if (thoughtSignature !== null) {
    part.thoughtSignature = thoughtSignature;
  }
  return part;
}

function buildGenerationConfig(profile: LLMProfile): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (profile.temperature !== null) {
    config.temperature = profile.temperature;
  }
  if (profile.topP !== null) {
    config.topP = profile.topP;
  }
  if (profile.topK !== null) {
    config.topK = profile.topK;
  }
  if (profile.maxOutputTokens !== null) {
    config.maxOutputTokens = profile.maxOutputTokens;
  }
  const thinkingLevel = toGeminiThinkingLevel(profile.reasoningEffort);
  if (thinkingLevel !== undefined) {
    config.thinkingConfig = { thinkingLevel, includeThoughts: true };
  }
  return config;
}

function parseGeminiGenerateContentResponse(raw: unknown): LLMCompletionResponse {
  const parsed = geminiGenerateContentResponseSchema.parse(raw);
  const firstCandidate = parsed.candidates[0];
  if (firstCandidate === undefined) {
    throw new Error('Gemini generateContent returned no candidates.');
  }
  const parts = firstCandidate.content.parts;
  const text = parts
    .flatMap((part) => (part.text === undefined || part.text.length === 0 || part.thought === true ? [] : [part.text]))
    .join('\n');
  const reasoningContent = parts
    .flatMap((part) => (part.text === undefined || part.text.length === 0 || part.thought !== true ? [] : [part.text]))
    .join('');
  const thoughtSignature = parts.find((part) => part.thoughtSignature !== undefined)?.thoughtSignature ?? null;
  const toolCalls = parts
    .flatMap((part, index) => (part.functionCall === undefined ? [] : [fromGeminiFunctionCall(part.functionCall, index)]));
  const promptTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;
  const totalTokens = parsed.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;

  return llmCompletionResponseSchema.parse({
    message: {
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      reasoning_content: reasoningContent.length > 0 ? reasoningContent : null,
      thinking_blocks: thoughtSignature === null
        ? []
        : [{ type: 'thinking', thinking: reasoningContent, signature: thoughtSignature }],
    },
    usage: { promptTokens, completionTokens, totalTokens },
    raw,
  });
}

function firstThinkingSignature(message: Message): string | null {
  return message.thinking_blocks.find(
    (block): block is Extract<Message['thinking_blocks'][number], { type: 'thinking' }> => block.type === 'thinking' && block.signature !== null,
  )?.signature ?? null;
}

function parseToolArguments(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

function fromGeminiFunctionCall(functionCall: GeminiFunctionCall, index: number): MessageToolCall {
  return {
    id: `gemini_call_${index}`,
    responses_item_id: null,
    name: functionCall.name,
    arguments: JSON.stringify(functionCall.args ?? {}),
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

const geminiFunctionCallSchema = z
  .object({ name: z.string(), args: z.unknown().optional() })
  .passthrough();
const geminiPartSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: geminiFunctionCallSchema.optional(),
  })
  .passthrough();

type GeminiFunctionCall = z.infer<typeof geminiFunctionCallSchema>;

const geminiGenerateContentResponseSchema = z
  .object({
    candidates: z.array(
      z
        .object({
          content: z
            .object({
              role: z.string().default('model'),
              parts: z.array(geminiPartSchema).default([]),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().int().min(0).optional(),
        candidatesTokenCount: z.number().int().min(0).optional(),
        totalTokenCount: z.number().int().min(0).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
