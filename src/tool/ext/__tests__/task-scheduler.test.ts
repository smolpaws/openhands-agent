import { describe, expect, it } from 'vitest';

import { actionEventsFromMessage } from '../../../conversation/index.js';
import { textContent } from '../../../llm/index.js';
import {
  CancelTaskTool,
  ListTasksTool,
  PauseTaskTool,
  ResumeTaskTool,
  ScheduleTaskTool,
  TASK_SCHEDULER_TOOL_FACTORIES,
  checkScheduleValue,
  scheduleTaskActionSchema,
  taskMutationActionSchema,
} from '../task-scheduler.js';

function assistantToolCall(name: string, args: Record<string, unknown>) {
  return {
    role: 'assistant' as const,
    content: [textContent('')],
    tool_calls: [{ id: 'call-1', name, arguments: JSON.stringify(args), origin: 'completion' as const }],
    tool_call_id: null,
    name: null,
    reasoning_content: null,
    thinking_blocks: [],
    responses_reasoning_item: null,
  };
}

describe('task-scheduler tools', () => {
  it('exposes the five scheduling tools with the expected names', () => {
    expect(Object.values(TASK_SCHEDULER_TOOL_FACTORIES).map((make) => make().name)).toEqual([
      'schedule_task',
      'list_tasks',
      'pause_task',
      'resume_task',
      'cancel_task',
    ]);
  });

  it('schedule_task requires prompt, schedule_type, and schedule_value', () => {
    expect(() => scheduleTaskActionSchema.parse({ schedule_type: 'cron', schedule_value: '0 9 * * *' })).toThrow();
    expect(() => scheduleTaskActionSchema.parse({ prompt: 'x', schedule_type: 'daily', schedule_value: 'v' })).toThrow();
    expect(scheduleTaskActionSchema.parse({ prompt: 'ping', schedule_type: 'once', schedule_value: '2026-02-01T15:30:00' })).toMatchObject({
      prompt: 'ping',
      schedule_type: 'once',
    });
  });

  it('checkScheduleValue accepts valid values and rejects malformed ones', () => {
    expect(checkScheduleValue({ schedule_type: 'interval', schedule_value: '300000' })).toBeNull();
    expect(checkScheduleValue({ schedule_type: 'interval', schedule_value: '0' })).toContain('Invalid interval');
    expect(checkScheduleValue({ schedule_type: 'once', schedule_value: '2026-02-01T15:30:00' })).toBeNull();
    expect(checkScheduleValue({ schedule_type: 'once', schedule_value: 'not-a-date' })).toContain('Invalid timestamp');
    expect(checkScheduleValue({ schedule_type: 'cron', schedule_value: '0 9 * * *' })).toBeNull();
    expect(checkScheduleValue({ schedule_type: 'cron', schedule_value: '0 9 *' })).toContain('Invalid cron');
  });

  it('schedule_task executor reports an error for a bad schedule without throwing', () => {
    const tool = ScheduleTaskTool.create();
    const bad = tool.executor?.({ prompt: 'p', schedule_type: 'interval', schedule_value: 'nope' }, undefined);
    expect(bad).toMatchObject({ is_error: true });
    const ok = tool.executor?.({ prompt: 'p', schedule_type: 'interval', schedule_value: '300000' }, undefined);
    expect(ok).toMatchObject({ is_error: false });
  });

  it('mutation tools require a non-empty task_id', () => {
    expect(() => taskMutationActionSchema.parse({})).toThrow();
    expect(() => taskMutationActionSchema.parse({ task_id: '' })).toThrow();
    expect(taskMutationActionSchema.parse({ task_id: 't1' })).toEqual({ task_id: 't1' });
    for (const tool of [PauseTaskTool.create(), ResumeTaskTool.create(), CancelTaskTool.create()]) {
      const observation = tool.executor?.({ task_id: 't1' }, undefined);
      expect(observation).toMatchObject({ is_error: false });
      expect((observation as { text: string }).text).toContain('t1');
    }
  });

  it('list_tasks takes no arguments and records the request', () => {
    const tool = ListTasksTool.create();
    expect(tool.executor?.({}, undefined)).toMatchObject({ is_error: false });
  });

  it('produces ActionEvents the downstream scheduler can read', () => {
    const [schedule] = actionEventsFromMessage(
      assistantToolCall('schedule_task', { prompt: 'daily report', schedule_type: 'cron', schedule_value: '0 9 * * *', context_mode: 'group' }),
      'resp-1',
    );
    expect(schedule).toMatchObject({
      kind: 'ActionEvent',
      tool_name: 'schedule_task',
      action: { prompt: 'daily report', schedule_type: 'cron', schedule_value: '0 9 * * *', context_mode: 'group' },
    });

    const [cancel] = actionEventsFromMessage(assistantToolCall('cancel_task', { task_id: 'abc' }), 'resp-2');
    expect(cancel).toMatchObject({ kind: 'ActionEvent', tool_name: 'cancel_task', action: { task_id: 'abc' } });
  });
});
