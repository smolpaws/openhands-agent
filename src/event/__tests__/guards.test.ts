import { describe, expect, it } from 'vitest';

import { isConversationStateUpdateEvent, isMessageEvent } from '../index.js';

describe('event type guards', () => {
  it('identifies MessageEvent by event kind only', () => {
    expect(isMessageEvent({ kind: 'MessageEvent', llm_message: { role: 'user', content: 'hello' } })).toBe(true);
    expect(isMessageEvent({ kind: 'ConversationStateUpdateEvent', key: 'status', value: 'idle' })).toBe(false);
    expect(isMessageEvent({ llm_message: { role: 'user', content: 'hello' } })).toBe(false);
    expect(isMessageEvent(null)).toBe(false);
  });

  it('identifies ConversationStateUpdateEvent by event kind only', () => {
    expect(isConversationStateUpdateEvent({ kind: 'ConversationStateUpdateEvent' })).toBe(true);
    expect(isConversationStateUpdateEvent({ kind: 'MessageEvent', llm_message: { role: 'user', content: 'hello' } })).toBe(false);
    expect(isConversationStateUpdateEvent({ key: 'status', value: 'idle' })).toBe(false);
  });
});
