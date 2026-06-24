import { z } from 'zod';

import { getLlmApiKey } from '../secrets/index.js';
import type { SecretStore } from '../secrets/index.js';
import { contentToString, messageSchema, type Content, type LLMProfile, type Message } from './index.js';
import { llmCompletionResponseSchema, type FetchLike, type LLMClient, type LLMCompletionResponse } from './openai.js';

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
  const parsedMessages = messages.map((message) => messageSchema.parse(message));
  const system = parsedMessages.filter((message) => message.role === 'system').flatMap((message) => contentToString(message.content));
  const body: Record<string, unknown> = {
    contents: parsedMessages.filter((message) => message.role !== 'system').map(toGeminiContent),
  };
  if (system.length > 0) {
    body.systemInstruction = { parts: system.map((text) => ({ text })) };
  }
  const generationConfig = buildGenerationConfig(profile);
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

function toGeminiContent(message: Message): Record<string, unknown> {
  return {
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.content.map(toGeminiPart),
  };
}

function toGeminiPart(content: Content): Record<string, unknown> {
  if (content.type === 'text') {
    return { text: content.text };
  }
  return { fileData: { fileUri: content.image_urls[0] ?? '' } };
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
  return config;
}

function parseGeminiGenerateContentResponse(raw: unknown): LLMCompletionResponse {
  const parsed = geminiGenerateContentResponseSchema.parse(raw);
  const firstCandidate = parsed.candidates[0];
  if (firstCandidate === undefined) {
    throw new Error('Gemini generateContent returned no candidates.');
  }
  const text = firstCandidate.content.parts
    .flatMap((part) => (part.text === undefined || part.text.length === 0 ? [] : [part.text]))
    .join('\n');
  const promptTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
  const completionTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;
  const totalTokens = parsed.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;

  return llmCompletionResponseSchema.parse({
    message: { role: 'assistant', content: text },
    usage: { promptTokens, completionTokens, totalTokens },
    raw,
  });
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

const geminiPartSchema = z.object({ text: z.string().optional() }).passthrough();

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
