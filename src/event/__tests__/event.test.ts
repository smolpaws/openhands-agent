import { describe, expect, it } from 'vitest';

import {
  actionEventSchema,
  agentErrorEventSchema,
  condensationSchema,
  eventSchema,
  eventsToMessages,
  messageEventSchema,
  streamingDeltaEventSchema,
  systemPromptEventSchema,
  type LLMConvertibleEvent,
} from '../index.js';
import { textContent, type MessageToolCall } from '../../llm/index.js';

describe('event serialization', () => {
  it('round-trips a system prompt event', () => {
    const event = systemPromptEventSchema.parse({
      source: 'agent',
      system_prompt: textContent('You are a helpful assistant'),
      tools: [],
    });

    const roundTripped = systemPromptEventSchema.parse(JSON.parse(JSON.stringify(event)));

    expect(roundTripped).toEqual(event);
    expect(roundTripped.kind).toBe('SystemPromptEvent');
  });

  it('round-trips a message event through the event union', () => {
    const event = messageEventSchema.parse({
      source: 'user',
      llm_message: {
        role: 'user',
        content: [textContent('Hello There!')],
      },
    });

    const loaded = eventSchema.parse(JSON.parse(JSON.stringify(event)));

    expect(loaded).toEqual(event);
  });

  it('rejects extra fields on events', () => {
    expect(() =>
      systemPromptEventSchema.parse({
        source: 'agent',
        id: 'test-id',
        timestamp: '2023-01-01T00:00:00',
        system_prompt: { type: 'text', text: 'Test' },
        tools: [],
        extra_field: 'should_not_be_allowed',
      }),
    ).toThrow();
  });

  it('parses transient streaming deltas', () => {
    const event = streamingDeltaEventSchema.parse({ content: 'hel', reasoning_content: 'why' });

    expect(event.source).toBe('agent');
    expect(event.content).toBe('hel');
    expect(event.reasoning_content).toBe('why');
  });

  it('coerces condensation forgotten ids from old list format into a Set', () => {
    const event = condensationSchema.parse({
      summary: 'summary',
      forgotten_event_ids: ['id1', 'id2'],
      llm_response_id: 'resp_1',
    });

    expect(event.forgotten_event_ids).toBeInstanceOf(Set);
    expect([...event.forgotten_event_ids].sort()).toEqual(['id1', 'id2']);
  });

  it('serializes action and agent error events', () => {
    const toolCall: MessageToolCall = {
      id: 'call_123',
      name: 'terminal',
      arguments: '{"command":"ls"}',
      origin: 'completion',
    };
    const action = actionEventSchema.parse({
      source: 'agent',
      thought: [textContent('I need to list files')],
      action: { command: 'ls' },
      tool_name: 'terminal',
      tool_call_id: 'call_123',
      tool_call: toolCall,
      llm_response_id: 'response_1',
    });
    const error = agentErrorEventSchema.parse({
      error: 'Something went wrong',
      tool_call_id: 'call_123',
      tool_name: 'terminal',
    });

    expect(actionEventSchema.parse(JSON.parse(JSON.stringify(action)))).toEqual(action);
    expect(agentErrorEventSchema.parse(JSON.parse(JSON.stringify(error)))).toEqual(error);
  });
});

describe('eventsToMessages', () => {
  const toolCall = (id: string, name = 'terminal'): MessageToolCall => ({
    id,
    name,
    arguments: '{}',
    origin: 'completion',
  });

  it('returns an empty message list for no events', () => {
    expect(eventsToMessages([])).toEqual([]);
  });

  it('merges consecutive plain user messages', () => {
    const events: LLMConvertibleEvent[] = [
      messageEventSchema.parse({
        source: 'user',
        llm_message: { role: 'user', content: [textContent('Implement the feature')] },
      }),
      messageEventSchema.parse({
        source: 'user',
        llm_message: { role: 'user', content: [textContent('Relevant project context')] },
      }),
      messageEventSchema.parse({
        source: 'agent',
        llm_message: { role: 'assistant', content: [textContent("I'll take a look.")] },
      }),
    ];

    const messages = eventsToMessages(events);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.content).toEqual([
      textContent('Implement the feature'),
      textContent('Relevant project context'),
    ]);
  });

  it('does not merge user messages with tool metadata', () => {
    const messages = eventsToMessages([
      messageEventSchema.parse({
        source: 'user',
        llm_message: {
          role: 'user',
          content: [textContent('Tool output')],
          tool_call_id: 'call_abc',
        },
      }),
      messageEventSchema.parse({
        source: 'user',
        llm_message: { role: 'user', content: [textContent('Additional context')] },
      }),
    ]);

    expect(messages).toHaveLength(2);
  });

  it('combines parallel action events from one LLM response', () => {
    const events: LLMConvertibleEvent[] = [
      actionEventSchema.parse({
        source: 'agent',
        thought: [textContent('I need to inspect two things')],
        action: { command: 'pwd' },
        tool_name: 'terminal',
        tool_call_id: 'call_1',
        tool_call: toolCall('call_1'),
        llm_response_id: 'response_1',
      }),
      actionEventSchema.parse({
        source: 'agent',
        thought: [],
        action: { command: 'ls' },
        tool_name: 'terminal',
        tool_call_id: 'call_2',
        tool_call: toolCall('call_2'),
        llm_response_id: 'response_1',
      }),
    ];

    const messages = eventsToMessages(events);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toEqual([textContent('I need to inspect two things')]);
    expect(messages[0]?.tool_calls?.map((call) => call.id)).toEqual(['call_1', 'call_2']);
  });
});
