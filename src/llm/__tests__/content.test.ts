import { describe, expect, it } from 'vitest';

import { imageContent, reduceTextContent, textContent, type Message } from '../index.js';

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
