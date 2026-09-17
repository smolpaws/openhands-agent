import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { actionEventSchema, agentErrorEventSchema, condensationSchema, condensationSummaryEventSchema, messageEventSchema } from '../../event/index.js';
import { EventLog } from '../event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { View } from '../../context/view.js';
import { restoreConversationState } from '../restore.js';
import { conversationExecutionStatus } from '../state.js';

describe('restoreConversationState', () => {
  it('preserves a Python null action paired with an agent error', () => {
    const action = actionEventSchema.parse({
      action: null, tool_name: 'terminal', tool_call_id: 'invalid-call',
      tool_call: { id: 'invalid-call', name: 'terminal', arguments: '{invalid', origin: 'completion' },
    });
    const error = agentErrorEventSchema.parse({ tool_name: 'terminal', tool_call_id: 'invalid-call', error: 'Invalid arguments' });
    const store = new InMemoryFileStore();
    new EventLog(store).append(action);
    expect(new EventLog(store).get(0)).toMatchObject({ action: null });
    const restored = restoreConversationState([action, error]);
    expect(restored.state.events[0]).toMatchObject({ action: null });
    expect(View.fromEvents(restored.state.events).events).toEqual([action, error]);
  });
  it('drops unsupported Python state and action security fields', async () => {
    const restored = restoreConversationState(await fixture('python-conversation-state.json'));

    expect(restored.state.executionStatus).toBe(conversationExecutionStatus.RUNNING);
    expect(restored.state.events).toHaveLength(1);
    expect(restored.droppedStateFields).toEqual(['confirmation_policy', 'secret_registry', 'security_analyzer']);
    expect(restored.droppedEventFields).toEqual([
      { index: 0, fields: ['critic_result', 'security_risk', 'summary', 'tool_call.security_risk'] },
    ]);
    expect(restored.state.events[0]).toMatchObject({
      kind: 'ActionEvent',
      action: { command: 'ls' },
      tool_call: { id: 'call-1', name: 'terminal', arguments: '{"command":"ls"}' },
    });
  });

  it('retains condensation summaries when importing a complete log or a materialized View', () => {
    const old = messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: 'old work' } });
    const current = messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: 'current work' } });
    const condensation = condensationSchema.parse({ forgotten_event_ids: [old.id], summary: 'prior progress', summary_offset: 0 });
    const payload = JSON.parse(JSON.stringify([old, current, condensation], (_key, value: unknown) => value instanceof Set ? [...value] : value)) as unknown;
    const restored = restoreConversationState(payload);
    expect(restored.droppedEventFields.flatMap(event => event.fields)).not.toContain('summary');
    expect(View.fromEvents(restored.state.events).events[0]).toMatchObject({ kind: 'CondensationSummaryEvent', summary: 'prior progress' });
    const materialized = condensationSummaryEventSchema.parse({ summary: 'existing summary' });
    expect(restoreConversationState([materialized]).state.events).toEqual([materialized]);
  });

  it('accepts an event array as a compact restore payload', async () => {
    const restored = restoreConversationState(await fixture('python-event-log.json'));

    expect(restored.state.executionStatus).toBe(conversationExecutionStatus.IDLE);
    expect(restored.state.events[0]).toMatchObject({
      kind: 'MessageEvent',
      llm_message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
  });
});

async function fixture(name: string): Promise<unknown> {
  const url = new URL(`../__fixtures__/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as unknown;
}

