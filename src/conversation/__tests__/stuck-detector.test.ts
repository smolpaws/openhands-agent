import { describe, expect, it } from 'vitest';

import { actionEventSchema, messageEventSchema, observationEventSchema } from '../../event/index.js';
import type { ActionEvent, Event } from '../../event/index.js';
import { textContent } from '../../llm/index.js';
import { ConversationState } from '../state.js';
import { StuckDetector } from '../stuck-detector.js';

describe('StuckDetector', () => {
  it('detects repeated identical action-observation loops', () => {
    const events: Event[] = [];
    for (let index = 0; index < 3; index += 1) {
      const action = actionEvent(`action-${index}`, `call-${index}`);
      events.push(action);
      events.push(observationEventSchema.parse({ action_id: action.id, tool_name: action.tool_name, tool_call_id: action.tool_call_id, observation: { text: 'same' } }));
    }

    expect(new StuckDetector(new ConversationState({ events }), { actionObservation: 3 }).isStuck()).toBe(true);
  });

  it('detects agent monologues without user interruption', () => {
    const events = [agentMessage('one'), agentMessage('two'), agentMessage('three')];

    expect(new StuckDetector(new ConversationState({ events }), { monologue: 3 }).isStuck()).toBe(true);
  });

  it('only checks history after the last user message', () => {
    const events = [agentMessage('one'), agentMessage('two'), userMessage('stop'), agentMessage('fresh')];

    expect(new StuckDetector(new ConversationState({ events }), { monologue: 2 }).isStuck()).toBe(false);
  });
});

function actionEvent(id: string, toolCallId: string): ActionEvent {
  return actionEventSchema.parse({
    id,
    tool_name: 'think',
    tool_call_id: toolCallId,
    action: { thought: 'same' },
    tool_call: { id: toolCallId, name: 'think', arguments: '{"thought":"same"}', origin: 'completion' },
  });
}

function agentMessage(text: string): Event {
  return messageEventSchema.parse({ source: 'agent', llm_message: { role: 'assistant', content: [textContent(text)] } });
}

function userMessage(text: string): Event {
  return messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent(text)] } });
}
