import { describe, expect, it } from 'vitest';

import { actionEventSchema, observationEventSchema } from '../../event/index.js';
import type { ActionEvent } from '../../event/index.js';
import { cancellationToken } from '../state.js';
import { ParallelToolExecutor } from '../parallel-executor.js';

describe('ParallelToolExecutor', () => {
  it('executes batches concurrently while preserving input order', async () => {
    const executor = new ParallelToolExecutor({ maxConcurrency: 2 });
    const started: string[] = [];

    const results = await executor.executeBatch(
      [actionEvent('action-1', 'call-1'), actionEvent('action-2', 'call-2')],
      async (action) => {
        started.push(action.id);
        await sleep(action.id === 'action-1' ? 20 : 1);
        return [observationEventSchema.parse({ action_id: action.id, tool_name: action.tool_name, tool_call_id: action.tool_call_id, observation: { id: action.id } })];
      },
    );

    expect(started).toEqual(['action-1', 'action-2']);
    expect(results.map((events) => events[0]?.kind)).toEqual(['ObservationEvent', 'ObservationEvent']);
    expect(results.map((events) => events[0]?.tool_call_id)).toEqual(['call-1', 'call-2']);
  });

  it('converts thrown tool errors into agent error events', async () => {
    const executor = new ParallelToolExecutor();

    const results = await executor.executeBatch([actionEvent('action-1', 'call-1')], async () => {
      throw new Error('boom');
    });

    expect(results[0]?.[0]).toMatchObject({ kind: 'AgentErrorEvent', tool_call_id: 'call-1', error: "Error executing tool 'think': boom" });
  });

  it('skips actions when cancellation is signalled before execution', async () => {
    const token = cancellationToken();
    token.cancel();
    const executor = new ParallelToolExecutor();

    const results = await executor.executeBatch([actionEvent('action-1', 'call-1')], async () => [], { cancelToken: token });

    expect(results[0]?.[0]).toMatchObject({ kind: 'AgentErrorEvent', tool_call_id: 'call-1', error: 'Tool call cancelled by interrupt.' });
  });
});

function actionEvent(id: string, toolCallId: string): ActionEvent {
  return actionEventSchema.parse({
    id,
    tool_name: 'think',
    tool_call_id: toolCallId,
    action: { thought: id },
    tool_call: { id: toolCallId, name: 'think', arguments: '{"thought":"hello"}', origin: 'completion' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
