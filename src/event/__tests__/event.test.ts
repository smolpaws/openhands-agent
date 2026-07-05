import { describe, expect, it } from 'vitest';

import {
  acpToolCallEventSchema,
  actionEventSchema,
  agentErrorEventSchema,
  condensationSchema,
  eventSchema,
  eventsToMessages,
  hookExecutionEventSchema,
  isAcpPatchEdit,
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

  it('parses ACP tool call events with Python-compatible fields', () => {
    const event = acpToolCallEventSchema.parse({
      tool_call_id: 'tool-1',
      title: 'Edit file',
      status: 'completed',
      tool_kind: 'edit',
      raw_input: { old_string: 'before', new_string: 'after' },
      raw_output: { ok: true },
      content: [{ type: 'diff', path: 'file.ts', oldText: 'before', newText: 'after' }],
      is_error: false,
    });

    expect(event.source).toBe('agent');
    expect(event.tool_kind).toBe('edit');
    expect(event.raw_input).toEqual({ old_string: 'before', new_string: 'after' });
    expect(isAcpPatchEdit(event)).toBe(true);
    expect(acpToolCallEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('detects ACP full-file writes separately from patch edits', () => {
    const writeEvent = acpToolCallEventSchema.parse({
      tool_call_id: 'tool-1',
      title: 'Write file',
      content: [{ type: 'diff', path: 'new.ts', oldText: null, newText: 'created' }],
    });
    const fallbackPatchEvent = acpToolCallEventSchema.parse({
      tool_call_id: 'tool-2',
      title: 'Edit fallback',
      raw_input: { old_string: 'before' },
    });

    expect(isAcpPatchEdit(writeEvent)).toBe(false);
    expect(isAcpPatchEdit(fallbackPatchEvent)).toBe(true);
  });

  it('parses hook execution events with Python-compatible fields', () => {
    const event = hookExecutionEventSchema.parse({
      hook_event_type: 'PreToolUse',
      hook_command: 'check-tool',
      tool_name: 'terminal',
      success: false,
      blocked: true,
      exit_code: 2,
      stdout: 'out',
      stderr: 'err',
      reason: 'blocked by policy',
      additional_context: 'extra context',
      error: null,
      action_id: 'action-1',
      hook_input: { command: 'ls' },
    });

    expect(event.source).toBe('hook');
    expect(event.reason).toBe('blocked by policy');
    expect(hookExecutionEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
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

  it('does not merge user messages with tool calls or names', () => {
    const withToolCalls = eventsToMessages([
      messageEventSchema.parse({
        source: 'user',
        llm_message: {
          role: 'user',
          content: [textContent('Call this tool')],
          tool_calls: [toolCall('call_1', 'search')],
        },
      }),
      messageEventSchema.parse({
        source: 'user',
        llm_message: { role: 'user', content: [textContent('Plain message')] },
      }),
    ]);
    const withName = eventsToMessages([
      messageEventSchema.parse({
        source: 'user',
        llm_message: {
          role: 'user',
          content: [textContent('Named output')],
          name: 'search_results',
        },
      }),
      messageEventSchema.parse({
        source: 'user',
        llm_message: { role: 'user', content: [textContent('Plain message')] },
      }),
    ]);

    expect(withToolCalls).toHaveLength(2);
    expect(withName).toHaveLength(2);
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

  it('rejects non-empty thoughts after the first parallel action in a response', () => {
    expect(() =>
      eventsToMessages([
        actionEventSchema.parse({
          source: 'agent',
          thought: [textContent('First thought')],
          action: { command: 'pwd' },
          tool_name: 'terminal',
          tool_call_id: 'call_1',
          tool_call: toolCall('call_1'),
          llm_response_id: 'response_1',
        }),
        actionEventSchema.parse({
          source: 'agent',
          thought: [textContent('Unexpected second thought')],
          action: { command: 'ls' },
          tool_name: 'terminal',
          tool_call_id: 'call_2',
          tool_call: toolCall('call_2'),
          llm_response_id: 'response_1',
        }),
      ]),
    ).toThrow(/empty thought/u);
  });
});
