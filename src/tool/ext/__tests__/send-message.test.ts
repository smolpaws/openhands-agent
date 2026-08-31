import { describe, expect, it } from 'vitest';

import { actionEventsFromMessage } from '../../../conversation/index.js';
import { textContent } from '../../../llm/index.js';
import { SEND_MESSAGE_TOOL_NAME, SendMessageTool, sendMessageActionSchema } from '../send-message.js';

function assistantSendMessage(text: string) {
  return {
    role: 'assistant' as const,
    content: [textContent('')],
    tool_calls: [{ id: 'call-1', name: SEND_MESSAGE_TOOL_NAME, arguments: JSON.stringify({ text }), origin: 'completion' as const }],
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}

describe('SendMessageTool', () => {
  it('exposes a send_message tool with a required text field', () => {
    const tool = SendMessageTool.create();
    expect(tool.name).toBe('send_message');
    expect(() => sendMessageActionSchema.parse({})).toThrow();
    expect(() => sendMessageActionSchema.parse({ text: '' })).toThrow();
    expect(sendMessageActionSchema.parse({ text: 'hi' })).toEqual({ text: 'hi' });
  });

  it('records intent only — the executor performs no delivery and returns a fixed confirmation', () => {
    const tool = SendMessageTool.create();
    const observation = tool.executor?.({ text: 'working on it' }, undefined);
    expect(observation).toMatchObject({ is_error: false });
    // Fixed confirmation; it must not echo the message text back (token waste).
    expect((observation as { text: string }).text).toBe('Message queued for delivery to the current thread.');
    expect((observation as { text: string }).text).not.toContain('working on it');
  });

  it('produces an ActionEvent that the coordinator send_message extractor can read', () => {
    // The durable outbound signal is the ActionEvent, not the executor return value.
    const [action] = actionEventsFromMessage(assistantSendMessage('ping the channel'), 'resp-1');
    expect(action).toMatchObject({
      kind: 'ActionEvent',
      tool_name: 'send_message',
      action: { text: 'ping the channel' },
    });
  });
});
