import { z } from 'zod';

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

export function contentToString(content: readonly Content[]): string[] {
  return content.map((item) => (item.type === 'text' ? item.text : `[Image: ${item.image_urls.length} URLs]`));
}
