import { describe, expect, it } from 'vitest';

import { imageContent, messageSchema, reduceTextContent, textContent, textContentSchema, type Message } from '../index.js';

describe('reduceTextContent', () => {
  it('joins text content with newlines and ignores images', () => {
    const message: Message = {
      role: 'user',
      content: [textContent('first'), imageContent(['data:image/png;base64,abc']), textContent('second')],
      tool_calls: null,
      tool_call_id: null,
      name: null,
      reasoning_content: null,
      thinking_blocks: [],
      responses_reasoning_item: null,
    };

    expect(reduceTextContent(message)).toBe('first\nsecond');
  });

  it('returns an empty string when message content has no text parts', () => {
    const message = messageFromContent([imageContent(['https://example.com/cat.png'])]);

    expect(reduceTextContent(message)).toBe('');
  });
});

describe('message backward compatibility', () => {
  it('loads current, string, and null content forms', () => {
    expect(messageSchema.parse({ role: 'user', content: null }).content).toEqual([]);
    expect(messageSchema.parse({ role: 'user', content: 'hello' }).content).toEqual([textContent('hello')]);
    expect(messageSchema.parse({ role: 'assistant', content: [{ type: 'text', text: 'current', cache_prompt: false }] }).content)
      .toEqual([textContent('current')]);
  });

  it('accepts and drops known deprecated TextContent fields', () => {
    expect(
      textContentSchema.parse({
        type: 'text',
        text: 'old format',
        cache_prompt: false,
        enable_truncation: true,
      }),
    ).toEqual(textContent('old format'));
  });

  it('accepts and drops known deprecated Message serialization controls', () => {
    const message = messageSchema.parse({
      role: 'assistant',
      content: [{ type: 'text', text: 'old message', cache_prompt: false, enable_truncation: true }],
      cache_enabled: true,
      vision_enabled: false,
      function_calling_enabled: true,
      force_string_serializer: false,
      send_reasoning_content: false,
      tool_calls: null,
      tool_call_id: null,
      name: null,
      reasoning_content: null,
      thinking_blocks: [],
      responses_reasoning_item: null,
    });

    expect(message.content).toEqual([textContent('old message')]);
    expect(JSON.stringify(message)).not.toMatch(/cache_enabled|vision_enabled|function_calling_enabled|force_string_serializer|send_reasoning_content|enable_truncation/u);
  });

  it('still rejects unknown fields outside known compatibility shims', () => {
    expect(() => textContentSchema.parse({ type: 'text', text: 'bad', extra: true })).toThrow();
    expect(() => messageSchema.parse({ role: 'user', content: 'bad', extra: true })).toThrow();
  });
});

function messageFromContent(content: Message['content']): Message {
  return {
    role: 'assistant',
    content,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}
