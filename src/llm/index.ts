import { z } from 'zod';

import { resolveLlmApiKeyRef } from '../secrets/index.js';
import type { SecretRef, SecretStore } from '../secrets/index.js';

export const LLM_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const llmProfileIdSchema = z.string().regex(LLM_PROFILE_ID_PATTERN);
export const llmProviderIdSchema = z.string().min(1).regex(/^[A-Za-z0-9._-]+$/u);

export const openAiApiModeSchema = z.union([z.literal('chat_completions'), z.literal('responses')]);
export const reasoningEffortSchema = z.union([z.literal('low'), z.literal('medium'), z.literal('high')]);
export const reasoningSummarySchema = z.union([z.literal('auto'), z.literal('concise'), z.literal('detailed')]);
export const promptCacheRetentionSchema = z.union([z.literal('24h'), z.literal('disabled')]);

export const llmProfileSchema = z
  .object({
    profileId: llmProfileIdSchema,
    providerId: llmProviderIdSchema,
    model: z.string().min(1),
    baseUrl: z.string().url().nullable().default(null),
    openAiApiMode: openAiApiModeSchema.default('chat_completions'),
    temperature: z.number().min(0).nullable().default(null),
    topP: z.number().min(0).max(1).nullable().default(null),
    topK: z.number().int().positive().nullable().default(null),
    maxInputTokens: z.number().int().positive().nullable().default(null),
    maxOutputTokens: z.number().int().positive().nullable().default(null),
    timeoutSeconds: z.number().positive().nullable().default(null),
    reasoningEffort: reasoningEffortSchema.nullable().default(null),
    reasoningSummary: reasoningSummarySchema.nullable().default(null),
    promptCacheRetention: promptCacheRetentionSchema.nullable().default(null),
    promptCacheKey: z.string().min(1).nullable().default(null),
    headers: z.record(z.string(), z.string()).default({}),
    useProfileKeyOverride: z.boolean().default(false),
  })
  .strict();

export type LLMProfile = z.infer<typeof llmProfileSchema>;
export type OpenAiApiMode = z.infer<typeof openAiApiModeSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ReasoningSummary = z.infer<typeof reasoningSummarySchema>;
export type PromptCacheRetention = z.infer<typeof promptCacheRetentionSchema>;

export function resolveLlmProfileApiKeyRef(profile: LLMProfile, store: SecretStore): Promise<SecretRef | null> {
  return resolveLlmApiKeyRef(
    {
      providerId: profile.providerId,
      profileId: profile.profileId,
      useProfileKeyOverride: profile.useProfileKeyOverride,
    },
    store,
  );
}

export const thinkingBlockSchema = z
  .object({
    type: z.literal('thinking').default('thinking'),
    thinking: z.string(),
    signature: z.string().nullable().default(null),
  })
  .strict();

export const redactedThinkingBlockSchema = z
  .object({
    type: z.literal('redacted_thinking').default('redacted_thinking'),
    data: z.string(),
  })
  .strict();

export const reasoningItemSchema = z
  .object({
    id: z.string().nullable().default(null),
    summary: z.array(z.string()).default([]),
    content: z.array(z.string()).nullable().default(null),
    encrypted_content: z.string().nullable().default(null),
    status: z.string().nullable().default(null),
  })
  .strict();

const baseContentSchema = z.object({
  cache_prompt: z.boolean().default(false),
  enable_truncation: z.boolean().optional(),
});

export const textContentSchema = baseContentSchema
  .extend({
    type: z.literal('text').default('text'),
    text: z.string(),
  })
  .strict()
  .transform(({ cache_prompt, type, text }) => ({ cache_prompt, type, text }));

export const imageContentSchema = baseContentSchema
  .extend({
    type: z.literal('image').default('image'),
    image_urls: z.array(z.string()),
  })
  .strict()
  .transform(({ cache_prompt, type, image_urls }) => ({ cache_prompt, type, image_urls }));

export const contentSchema = z.union([textContentSchema, imageContentSchema]);

export const messageToolCallSchema = z
  .object({
    id: z.string(),
    responses_item_id: z.string().nullable().default(null),
    name: z.string(),
    arguments: z.string(),
    origin: z.union([z.literal('completion'), z.literal('responses')]),
  })
  .strict();

const rawMessageSchema = z
  .object({
    role: z.union([z.literal('user'), z.literal('system'), z.literal('assistant'), z.literal('tool')]),
    content: z
      .union([z.string(), z.array(contentSchema), z.null()])
      .default([])
      .transform((content) => {
        if (content === null) {
          return [];
        }
        if (typeof content === 'string') {
          return [textContent(content)];
        }
        return content;
      }),
    tool_calls: z.array(messageToolCallSchema).nullable().default(null),
    tool_call_id: z.string().nullable().default(null),
    name: z.string().nullable().default(null),
    cache_enabled: z.boolean().optional(),
    vision_enabled: z.boolean().optional(),
    function_calling_enabled: z.boolean().optional(),
    force_string_serializer: z.boolean().optional(),
    send_reasoning_content: z.boolean().optional(),
    reasoning_content: z.string().nullable().default(null),
    thinking_blocks: z.array(z.union([thinkingBlockSchema, redactedThinkingBlockSchema])).default([]),
    responses_reasoning_item: reasoningItemSchema.nullable().default(null),
  })
  .strict();

export const messageSchema = rawMessageSchema.transform((message) => ({
  role: message.role,
  content: message.content,
  tool_calls: message.tool_calls,
  tool_call_id: message.tool_call_id,
  name: message.name,
  reasoning_content: message.reasoning_content,
  thinking_blocks: message.thinking_blocks,
  responses_reasoning_item: message.responses_reasoning_item,
}));

export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof redactedThinkingBlockSchema>;
export type ReasoningItem = z.infer<typeof reasoningItemSchema>;
export type TextContent = z.infer<typeof textContentSchema>;
export type ImageContent = z.infer<typeof imageContentSchema>;
export type Content = z.infer<typeof contentSchema>;
export type MessageToolCall = z.infer<typeof messageToolCallSchema>;
export type Message = z.infer<typeof messageSchema>;

export function textContent(text: string, cachePrompt = false): TextContent {
  return textContentSchema.parse({ text, cache_prompt: cachePrompt });
}

export function imageContent(imageUrls: readonly string[], cachePrompt = false): ImageContent {
  return imageContentSchema.parse({ image_urls: [...imageUrls], cache_prompt: cachePrompt });
}

export function reduceTextContent(message: Message): string {
  return message.content
    .filter((item): item is TextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}


export function contentToString(content: readonly Content[]): string[] {
  return content.map((item) => (item.type === 'text' ? item.text : `[Image: ${item.image_urls.length} URLs]`));
}
