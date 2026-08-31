/**
 * EXT-SDK-002 — task-scheduler tools (SmolPaws additive extension).
 *
 * SmolPaws' cross-conversation scheduling tools: `schedule_task`, `list_tasks`,
 * `cancel_task`, `pause_task`, `resume_task`. Each is an ordinary `ToolDefinition`
 * that records intent as an `ActionEvent`; the tools carry no scheduling engine and
 * perform no I/O. A downstream SmolPaws consumer (scheduler + coordinator) reads the
 * action and enqueues or mutates the actual schedule.
 *
 * This is distinct from the upstream-parity `task_tracker` tool (a per-conversation
 * checklist). Same word, different job.
 *
 * See docs/TRANSPILE_CONTRACT.md → Additive extensions. Target-only; not judged by
 * the upstream parity oracle.
 */
import { z } from 'zod';

import { ToolDefinition, toolAnnotationsSchema, type ToolAnnotations } from '../index.js';

export const SCHEDULE_TASK_TOOL_NAME = 'schedule_task';
export const LIST_TASKS_TOOL_NAME = 'list_tasks';
export const CANCEL_TASK_TOOL_NAME = 'cancel_task';
export const PAUSE_TASK_TOOL_NAME = 'pause_task';
export const RESUME_TASK_TOOL_NAME = 'resume_task';

const taskObservationSchema = z
  .object({
    text: z.string(),
    is_error: z.boolean().default(false),
  })
  .strict();

const mutatingAnnotations: ToolAnnotations = toolAnnotationsSchema.parse({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

// ---- schedule_task ---------------------------------------------------------

export const scheduleTaskActionSchema = z
  .object({
    prompt: z.string().min(1).describe('What the agent should do when the task runs.'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z
      .string()
      .min(1)
      .describe('The cron expression, interval milliseconds, or once timestamp.'),
    context_mode: z
      .enum(['group', 'isolated'])
      .optional()
      .describe('"group" keeps the current conversation context; "isolated" starts fresh.'),
    target_group: z.string().optional().describe('Optional target scope id for control scopes.'),
  })
  .strict();

export type ScheduleTaskAction = z.infer<typeof scheduleTaskActionSchema>;

const SCHEDULE_TASK_DESCRIPTION = `Schedule a recurring or one-time task.

CONTEXT MODE:
- "group" keeps the current conversation context and memory
- "isolated" starts from a fresh session

SCHEDULE VALUE FORMAT:
- cron: "0 9 * * *"
- interval: milliseconds like "300000"
- once: local timestamp like "2026-02-01T15:30:00" (without Z)`;

/**
 * Lightweight, dependency-free validity check for a schedule value. Full cron parsing is left to the
 * downstream scheduler; this only catches obvious mistakes so the model gets fast feedback.
 * Returns an error string, or null when the value looks acceptable.
 */
export function checkScheduleValue(action: Pick<ScheduleTaskAction, 'schedule_type' | 'schedule_value'>): string | null {
  if (action.schedule_type === 'interval') {
    const ms = Number.parseInt(action.schedule_value, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      return `Invalid interval: "${action.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`;
    }
    return null;
  }
  if (action.schedule_type === 'once') {
    const when = new Date(action.schedule_value);
    if (Number.isNaN(when.getTime())) {
      return `Invalid timestamp: "${action.schedule_value}". Use ISO 8601 like "2026-02-01T15:30:00".`;
    }
    return null;
  }
  // cron: field-count sanity only (5 or 6 fields). The scheduler validates the full expression.
  const fields = action.schedule_value.trim().split(/\s+/u);
  if (fields.length < 5 || fields.length > 6) {
    return `Invalid cron: "${action.schedule_value}". Use 5 fields like "0 9 * * *" (daily 9am).`;
  }
  return null;
}

export class ScheduleTaskTool {
  static readonly className = 'ScheduleTaskTool';

  static create(): ToolDefinition<typeof scheduleTaskActionSchema, typeof taskObservationSchema> {
    return new ToolDefinition({
      name: SCHEDULE_TASK_TOOL_NAME,
      description: SCHEDULE_TASK_DESCRIPTION,
      inputSchema: scheduleTaskActionSchema,
      outputSchema: taskObservationSchema,
      annotations: toolAnnotationsSchema.parse({ ...mutatingAnnotations, title: 'schedule_task' }),
      executor: (action) => {
        const problem = checkScheduleValue(action);
        if (problem !== null) {
          return { text: problem, is_error: true };
        }
        return {
          text: `Task scheduled: ${action.schedule_type} - ${action.schedule_value}`,
          is_error: false,
        };
      },
    });
  }
}

// ---- list_tasks ------------------------------------------------------------

export const listTasksActionSchema = z.object({}).strict();

export class ListTasksTool {
  static readonly className = 'ListTasksTool';

  static create(): ToolDefinition<typeof listTasksActionSchema, typeof taskObservationSchema> {
    return new ToolDefinition({
      name: LIST_TASKS_TOOL_NAME,
      description:
        'List scheduled tasks visible to the current scope. Control scopes can see all tasks; other scopes see only their own tasks.',
      inputSchema: listTasksActionSchema,
      outputSchema: taskObservationSchema,
      annotations: toolAnnotationsSchema.parse({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        title: 'list_tasks',
      }),
      // The action is the request; the downstream scheduler answers with the actual task list.
      executor: () => ({ text: 'Listing scheduled tasks.', is_error: false }),
    });
  }
}

// ---- pause / resume / cancel ----------------------------------------------

export const taskMutationActionSchema = z
  .object({
    task_id: z.string().min(1).describe('The task id.'),
  })
  .strict();

export type TaskMutationAction = z.infer<typeof taskMutationActionSchema>;

type TaskMutationKind = typeof CANCEL_TASK_TOOL_NAME | typeof PAUSE_TASK_TOOL_NAME | typeof RESUME_TASK_TOOL_NAME;

function createTaskMutationTool(
  name: TaskMutationKind,
  description: string,
  acknowledgement: string,
): ToolDefinition<typeof taskMutationActionSchema, typeof taskObservationSchema> {
  return new ToolDefinition({
    name,
    description,
    inputSchema: taskMutationActionSchema,
    outputSchema: taskObservationSchema,
    annotations: toolAnnotationsSchema.parse({ ...mutatingAnnotations, title: name }),
    executor: (action) => ({ text: `Task ${action.task_id} ${acknowledgement}.`, is_error: false }),
  });
}

export class PauseTaskTool {
  static readonly className = 'PauseTaskTool';
  static create(): ToolDefinition<typeof taskMutationActionSchema, typeof taskObservationSchema> {
    return createTaskMutationTool(PAUSE_TASK_TOOL_NAME, 'Pause a scheduled task. It will not run until resumed.', 'pause requested');
  }
}

export class ResumeTaskTool {
  static readonly className = 'ResumeTaskTool';
  static create(): ToolDefinition<typeof taskMutationActionSchema, typeof taskObservationSchema> {
    return createTaskMutationTool(RESUME_TASK_TOOL_NAME, 'Resume a paused task.', 'resume requested');
  }
}

export class CancelTaskTool {
  static readonly className = 'CancelTaskTool';
  static create(): ToolDefinition<typeof taskMutationActionSchema, typeof taskObservationSchema> {
    return createTaskMutationTool(CANCEL_TASK_TOOL_NAME, 'Cancel and delete a scheduled task.', 'cancellation requested');
  }
}

/** All five task-scheduler tool factories, in a stable order. */
export const TASK_SCHEDULER_TOOL_FACTORIES = {
  ScheduleTaskTool: () => ScheduleTaskTool.create(),
  ListTasksTool: () => ListTasksTool.create(),
  PauseTaskTool: () => PauseTaskTool.create(),
  ResumeTaskTool: () => ResumeTaskTool.create(),
  CancelTaskTool: () => CancelTaskTool.create(),
} as const;
