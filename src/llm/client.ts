import { z } from 'zod';

import type { ToolDefinition } from '../tool/index.js';
import { messageSchema, type LLMProfile, type Message } from './index.js';

export interface FetchResponseLike {
  readonly body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { readonly method: 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body: string },
) => Promise<FetchResponseLike>;

/** Stored SystemPromptEvent tools and executable tool definitions share a count boundary. */
export type LLMTokenCountTool = ToolDefinition | Readonly<Record<string, unknown>>;

export interface LLMClient {
  readonly profile: LLMProfile;
  /** Profile override first, then known metadata; null means unknown. No I/O in this getter. */
  readonly effectiveMaxInputTokens?: number | null;
  readonly tokenCountAccuracy?: 'estimate' | 'exact';
  /** Local estimates include system text and tools. Unknown modalities return null, never zero. */
  getTokenCount?(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null>;
  /** Resolve route metadata before reading the effective limit; failed discovery stays unknown. */
  resolveRuntimeMetadata?(): Promise<void>;
  complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse>;
}

export const llmUsageSchema = z
  .object({
    promptTokens: z.number().int().min(0).optional(),
    completionTokens: z.number().int().min(0).optional(),
    totalTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheWriteTokens: z.number().int().min(0).optional(),
    cacheMissTokens: z.number().int().min(0).optional(),
    reasoningTokens: z.number().int().min(0).optional(),
    toolUsePromptTokens: z.number().int().min(0).optional(),
    providerUsage: z.record(z.string(), z.unknown()).optional(),
    reportedCost: z.object({ amount: z.number().finite().nonnegative(), currency: z.string().min(1) }).strict().optional(),
  })
  .strict();

export const llmResponseMetadataSchema = z
  .object({
    usage: llmUsageSchema.nullable().default(null),
    responseId: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();

export const llmCompletionResponseSchema = llmResponseMetadataSchema.extend({
  message: messageSchema,
  raw: z.unknown().optional(),
}).strict();

export type LLMUsage = z.infer<typeof llmUsageSchema>;
export type LLMResponseMetadata = z.infer<typeof llmResponseMetadataSchema>;
export type LLMCompletionResponse = z.infer<typeof llmCompletionResponseSchema>;

/** A received provider response can be billable even when its content is invalid. */
export class LLMResponseError extends Error {
  constructor(readonly metadata: LLMResponseMetadata, cause: unknown) {
    super('Provider returned an invalid or incomplete LLM response', { cause });
    this.name = 'LLMResponseError';
  }
}

/** Extract accounting before validating message/tool content; never fabricate a message. */
export function parseLlmResponseWithMetadata(
  raw: unknown,
  parseMetadata: (raw: unknown) => LLMResponseMetadata,
  parseContent: (raw: unknown, metadata: LLMResponseMetadata) => LLMCompletionResponse,
): LLMCompletionResponse {
  const object = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const nativeUsage = object.usage;
  // Invalid counters cannot enter normalized totals. Keep the native usage for
  // diagnosis and mark normalized counts unknown rather than losing the call.
  let metadata: LLMResponseMetadata = {
    usage: typeof nativeUsage === 'object' && nativeUsage !== null && !Array.isArray(nativeUsage)
      ? { providerUsage: nativeUsage as Record<string, unknown> } : null,
    ...(typeof object.id === 'string' ? { responseId: object.id } : {}),
    ...(typeof object.model === 'string' ? { model: object.model } : {}),
  };
  try {
    metadata = parseMetadata(raw);
    return parseContent(raw, metadata);
  } catch (cause) {
    throw new LLMResponseError(metadata, cause);
  }
}


/** Retain available completion metadata on provider failure without an assistant message. */
export function throwProviderErrorWithMetadata(
  body: unknown,
  error: unknown,
  parseMetadata: (raw: unknown) => LLMResponseMetadata,
): never {
  let raw: unknown = body;
  if (typeof body === 'string') {
    try { raw = JSON.parse(body) as unknown; } catch { throw error; }
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && ('usage' in raw || 'id' in raw || 'model' in raw)) {
    try { parseLlmResponseWithMetadata(raw, parseMetadata, () => { throw error; }); }
    catch (failure) {
      if (failure instanceof LLMResponseError) throw new LLMResponseError(failure.metadata, error);
    }
  }
  throw error;
}
