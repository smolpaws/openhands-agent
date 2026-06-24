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

  it('appends visible assistant content as a MessageEvent', async () => {
    const state = new ConversationState();

    await dispatchLlmResponse({ message: baseMessage({ content: [textContent('hello')] }), usage: null }, state, async () => []);

    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ kind: 'MessageEvent', source: 'agent' });
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
