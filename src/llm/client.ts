import { z } from 'zod';

import { messageSchema, type LLMProfile, type Message } from './index.js';

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
