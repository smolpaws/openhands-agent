import { describe, expect, it } from 'vitest';

import { observationEventSchema } from '../../event/index.js';
import { textContent } from '../../llm/index.js';
import { ConversationState } from '../../conversation/index.js';
import { classifyResponse, dispatchLlmResponse } from '../response-dispatch.js';

describe('classifyResponse', () => {
  it('classifies tool calls before visible content', () => {
    expect(
      classifyResponse({
        role: 'assistant',
        content: [textContent('I will call a tool')],
        tool_calls: [{ id: 'call-1', name: 'think', arguments: '{"thought":"hi"}', origin: 'completion' }],
        tool_call_id: null,
        name: null,
        reasoning_content: null,
        thinking_blocks: [],
        responses_reasoning_item: null,
      }),
    ).toBe('tool_calls');
  });

  it('classifies content, reasoning-only, and empty messages', () => {
    expect(classifyResponse(baseMessage({ content: [textContent('hello')] }))).toBe('content');
    expect(classifyResponse(baseMessage({ reasoning_content: 'hidden thought' }))).toBe('reasoning_only');
    expect(classifyResponse(baseMessage())).toBe('empty');
  });
});

describe('dispatchLlmResponse', () => {
  it('queues and executes tool calls without a confirmation gate', async () => {
    const state = new ConversationState();

    await dispatchLlmResponse(
      {
        message: {
          ...baseMessage({ content: [textContent('thinking')] }),
          tool_calls: [
            { id: 'call-1', name: 'think', arguments: '{"thought":"one"}', origin: 'completion' },
            { id: 'call-2', name: 'think', arguments: '{"thought":"two"}', origin: 'completion' },
          ],
        },
        usage: null,
      },
      state,
      async (action) => [
        observationEventSchema.parse({ action_id: action.id, tool_name: action.tool_name, tool_call_id: action.tool_call_id, observation: { ok: true } }),
      ],
      { llmResponseId: 'response-1', maxConcurrency: 2 },
    );

    expect(state.events.map((event) => event.kind)).toEqual(['ActionEvent', 'ActionEvent', 'ObservationEvent', 'ObservationEvent']);
    expect(ConversationState.getUnmatchedActions(state.events)).toHaveLength(0);
  });

  it('appends visible assistant content and finishes the turn', async () => {
    const state = new ConversationState();

    await dispatchLlmResponse({ message: baseMessage({ content: [textContent('hello')] }), usage: null }, state, async () => []);

    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ kind: 'MessageEvent', source: 'agent' });
    expect(state.executionStatus).toBe('finished');
  });

  it('nudges an empty response as a user-role environment MessageEvent without finishing', async () => {
    const state = new ConversationState();

    await dispatchLlmResponse({ message: baseMessage(), usage: null }, state, async () => []);

    expect(state.events.map((event) => event.kind)).toEqual(['MessageEvent', 'MessageEvent']);
    expect(state.events[0]).toMatchObject({ kind: 'MessageEvent', source: 'agent' });
    expect(state.events[1]).toMatchObject({
      kind: 'MessageEvent',
      source: 'environment',
      llm_message: { role: 'user' },
    });
    expect(state.executionStatus).not.toBe('finished');
  });

  it('nudges a reasoning-only response without finishing', async () => {
    const state = new ConversationState();

    await dispatchLlmResponse({ message: baseMessage({ reasoning_content: 'thought' }), usage: null }, state, async () => []);

    expect(state.events.map((event) => event.kind)).toEqual(['MessageEvent', 'MessageEvent']);
    expect(state.events[0]).toMatchObject({ kind: 'MessageEvent', source: 'agent' });
    expect(state.events[1]).toMatchObject({ kind: 'MessageEvent', source: 'environment', llm_message: { role: 'user' } });
    expect(state.executionStatus).not.toBe('finished');
  });

  it('does not nudge visible content responses', async () => {
    const contentState = new ConversationState();

    await dispatchLlmResponse({ message: baseMessage({ content: [textContent('hi')] }), usage: null }, contentState, async () => []);

    expect(contentState.events.some((event) => event.kind === 'MessageEvent' && event.source === 'environment')).toBe(false);
  });

  it('masks registered secret values in the durable agent MessageEvent text', async () => {
    const state = new ConversationState();
    const mask = (text: string) => text.replaceAll('supersecret', '<secret-hidden>');

    await dispatchLlmResponse(
      { message: baseMessage({ content: [textContent('the value is supersecret now')] }), usage: null },
      state,
      async () => [],
      { maskSecretsInOutput: mask },
    );

    const event = state.events[0];
    expect(event).toMatchObject({ kind: 'MessageEvent', source: 'agent' });
    expect((event as { llm_message: { content: { text: string }[] } }).llm_message.content[0]?.text).toBe(
      'the value is <secret-hidden> now',
    );
  });

  it('masks reasoning_content and leaves signed thinking blocks untouched', async () => {
    const state = new ConversationState();
    const mask = (text: string) => text.replaceAll('supersecret', '<secret-hidden>');

    await dispatchLlmResponse(
      {
        message: baseMessage({
          reasoning_content: 'the value is supersecret now',
          thinking_blocks: [{ type: 'thinking', thinking: 'supersecret in signed payload', signature: 'sig' }],
        }),
        usage: null,
      },
      state,
      async () => [],
      { maskSecretsInOutput: mask },
    );

    const event = state.events[0] as { llm_message: { reasoning_content: string; thinking_blocks: { thinking: string }[] } };
    expect(event.llm_message.reasoning_content).toBe('the value is <secret-hidden> now');
    expect(event.llm_message.thinking_blocks[0]?.thinking).toBe('supersecret in signed payload');
  });

  it('leaves the message unchanged when no mask is provided', async () => {
    const state = new ConversationState();

    await dispatchLlmResponse({ message: baseMessage({ content: [textContent('nothing to hide')] }), usage: null }, state, async () => []);

    const event = state.events[0] as { llm_message: { content: { text: string }[] } };
    expect(event.llm_message.content[0]?.text).toBe('nothing to hide');
  });
});

function baseMessage(overrides = {}) {
  return {
    role: 'assistant',
    content: [],
    tool_calls: null,
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
    ...overrides,
  };
}
