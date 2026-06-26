import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { restoreConversationState } from '../restore.js';
import { conversationExecutionStatus } from '../state.js';

describe('restoreConversationState', () => {
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

