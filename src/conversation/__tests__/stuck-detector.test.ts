import { describe, expect, it } from 'vitest';

import { actionEventSchema, agentErrorEventSchema, messageEventSchema, observationEventSchema } from '../../event/index.js';
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

  it('does not reset the stuck-detection window for an environment-sourced corrective nudge', () => {
    const events: Event[] = [userMessage('Please keep trying ls')];
    for (let index = 0; index < 4; index += 1) {
      const action = actionEvent(`action-${index}`, `call-${index}`);
      events.push(action);
      events.push(observationEventSchema.parse({
        action_id: action.id,
        tool_name: action.tool_name,
        tool_call_id: action.tool_call_id,
        observation: { text: 'file1.txt\nfile2.txt' },
      }));
    }
    // Framework corrective nudge: user-role content, environment source (upstream #3954).
    events.push(messageEventSchema.parse({
      source: 'environment',
      llm_message: { role: 'user', content: [textContent('Your last response did not include a function call or a message. Please use a tool to proceed with the task.')] },
    }));

    expect(new StuckDetector(new ConversationState({ events })).isStuck()).toBe(true);

    // A real human turn at the same position would have reset the window.
    const withUserNudge = [...events.slice(0, -1), userMessage('keep going')];
    expect(new StuckDetector(new ConversationState({ events: withUserNudge })).isStuck()).toBe(false);
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

describe('StuckDetector action-error nudge', () => {
  function actionErrorPair(index: number): [ActionEvent, Event] {
    const action = actionEventSchema.parse({
      id: `error-action-${index}`,
      tool_name: 'terminal',
      tool_call_id: `call-${index}`,
      action: { command: 'invalid_command' },
      tool_call: { id: `call-${index}`, name: 'terminal', arguments: '{"command":"invalid_command"}', origin: 'completion' },
    });
    const error = agentErrorEventSchema.parse({
      source: 'agent',
      error: "Command 'invalid_command' not found",
      tool_call_id: action.tool_call_id,
      tool_name: action.tool_name,
    });
    return [action, error];
  }

  it('nudges once at the threshold and only goes stuck after one more repeat', () => {
    const events: Event[] = [userMessage('Please run the invalid command')];

    for (let index = 0; index < 2; index += 1) {
      events.push(...actionErrorPair(index));
    }
    let detector = new StuckDetector(new ConversationState({ events }), { actionError: 3 });
    expect(detector.isStuck()).toBe(false);
    expect(detector.getActionErrorNudge()).toBeNull();

    // 3rd pair reaches the threshold: nudge, but not yet stuck.
    events.push(...actionErrorPair(2));
    detector = new StuckDetector(new ConversationState({ events }), { actionError: 3 });
    expect(detector.isStuck()).toBe(false);
    const nudge = detector.getActionErrorNudge();
    expect(nudge).toContain('terminal');
    expect(nudge).toContain("Command 'invalid_command' not found");

    // 4th pair despite the nudge: hard stuck.
    events.push(...actionErrorPair(3));
    detector = new StuckDetector(new ConversationState({ events }), { actionError: 3 });
    expect(detector.isStuck()).toBe(true);
    expect(detector.getActionErrorNudge()).toBeNull();
  });

  it('does not re-nudge the same error event on a frozen streak', () => {
    const events: Event[] = [userMessage('Please run the invalid command')];
    for (let index = 0; index < 3; index += 1) {
      events.push(...actionErrorPair(index));
    }

    const detector = new StuckDetector(new ConversationState({ events }), { actionError: 3 });
    expect(detector.getActionErrorNudge()).not.toBeNull();
    // Same frozen streak: the error event id is unchanged, so no re-nudge.
    expect(detector.getActionErrorNudge()).toBeNull();
  });
});
