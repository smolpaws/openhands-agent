import { describe, expect, it } from 'vitest';

import { actionEventSchema, observationEventSchema, userRejectObservationSchema } from '../../event/index.js';
import { textContent } from '../../llm/index.js';
import type { ActionEvent, Event } from '../../event/index.js';
import { ConversationState, PendingActionsQueue, actionEventsFromMessage, cancellationToken } from '../state.js';

describe('ConversationState pending action tracking', () => {
  it('returns executable actions without matching observations in chronological order', () => {
    const first = actionEvent('action-1', 'call-1');
    const observed = actionEvent('action-2', 'call-2');
    const rejected = actionEvent('action-3', 'call-3');
    const errored = actionEvent('action-4', 'call-4');
    const last = actionEvent('action-5', 'call-5');
    const events: Event[] = [
      first,
      observed,
      observationEventSchema.parse({ action_id: observed.id, tool_name: observed.tool_name, tool_call_id: observed.tool_call_id, observation: { ok: true } }),
      rejected,
      userRejectObservationSchema.parse({ action_id: rejected.id, tool_name: rejected.tool_name, tool_call_id: rejected.tool_call_id, rejection_reason: 'no' }),
      errored,
      { kind: 'AgentErrorEvent', source: 'agent', tool_name: errored.tool_name, tool_call_id: errored.tool_call_id, error: 'boom' },
      last,
    ];

    expect(ConversationState.getUnmatchedActions(events).map((event) => event.id)).toEqual([first.id, last.id]);
  });

  it('rejects pending actions by appending user rejection observations', () => {
    const state = new ConversationState({ events: [actionEvent('action-1', 'call-1'), actionEvent('action-2', 'call-2')] });

    const rejections = state.rejectPendingActions('not now');

    expect(rejections).toHaveLength(2);
    expect(rejections.map((event) => event.kind)).toEqual(['UserRejectObservation', 'UserRejectObservation']);
    expect(ConversationState.getUnmatchedActions(state.events)).toHaveLength(0);
    expect(rejections[0]?.rejection_reason).toBe('not now');
  });

  it('emits agent errors for orphaned actions after interruption', () => {
    const state = new ConversationState({ events: [actionEvent('action-1', 'call-1')] });

    const errors = state.emitOrphanedActionErrors('paused');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'AgentErrorEvent', tool_call_id: 'call-1', error: 'paused' });
    expect(ConversationState.getUnmatchedActions(state.events)).toHaveLength(0);
  });
});

describe('PendingActionsQueue', () => {
  it('queues multi-tool actions and drains them FIFO', () => {
    const queue = new PendingActionsQueue([actionEvent('action-1', 'call-1'), actionEvent('action-2', 'call-2')]);

    expect(queue.pending.map((event) => event.id)).toEqual(['action-1', 'action-2']);
    expect(queue.drain(1).map((event) => event.id)).toEqual(['action-1']);
    expect(queue.drain().map((event) => event.id)).toEqual(['action-2']);
    expect(queue.pending).toHaveLength(0);
  });


  it('supports cancellation of queued actions without running them', () => {
    const queue = new PendingActionsQueue([actionEvent('action-1', 'call-1'), actionEvent('action-2', 'call-2')]);
    const token = cancellationToken();
    token.cancel();

    const errors = queue.cancelPending(token);

    expect(errors.map((event) => event.tool_call_id)).toEqual(['call-1', 'call-2']);
    expect(errors.every((event) => event.error === 'Tool call cancelled by interrupt.')).toBe(true);
    expect(queue.pending).toHaveLength(0);
  });
});

describe('actionEventsFromMessage', () => {
  it('converts multiple assistant tool calls into queued ActionEvents', () => {
    const actions = actionEventsFromMessage(
      {
        role: 'assistant',
        content: [textContent('thinking')],
        tool_calls: [
          { id: 'call-1', name: 'think', arguments: '{"thought":"one"}', origin: 'completion' },
          { id: 'call-2', name: 'finish', arguments: '{"message":"done"}', origin: 'completion' },
        ],
        tool_call_id: null,
        name: null,
        reasoning_content: null,
        thinking_blocks: [],
        responses_reasoning_item: null,
      },
      'response-1',
    );
    const queue = new PendingActionsQueue(actions);

    expect(actions.map((action) => action.tool_name)).toEqual(['think', 'finish']);
    expect(actions.map((action) => action.tool_call_id)).toEqual(['call-1', 'call-2']);
    expect(actions[0]?.action).toEqual({ thought: 'one' });
    expect(actions[1]?.llm_response_id).toBe('response-1');
    expect(queue.drain().map((action) => action.tool_call.id)).toEqual(['call-1', 'call-2']);
  });
});


function actionEvent(id: string, toolCallId: string): ActionEvent {
  return actionEventSchema.parse({
    id,
    tool_name: 'think',
    tool_call_id: toolCallId,
    action: { thought: 'hello' },
    tool_call: { id: toolCallId, name: 'think', arguments: '{"thought":"hello"}', origin: 'completion' },
  });
}
