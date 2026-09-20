import { z } from 'zod';

import { textContent, textContentSchema } from '../llm/index.js';
import { ToolDefinition } from './index.js';

export const condenseActionSchema = z.object({
  message_to_future_self: z.string().max(16384).optional().describe(
    'Optional message to your future self, preserved exactly. Maximum 16,384 UTF-16 code units.',
  ),
}).strict();

export const condenseObservationSchema = z.object({
  kind: z.literal('CondenseObservation').default('CondenseObservation'),
  content: z.array(textContentSchema).default([]),
  is_error: z.boolean().default(false),
  request_id: z.string().nullable().default(null),
  message_to_future_self: z.string().nullable().default(null),
}).strict();

export type CondenseAction = z.infer<typeof condenseActionSchema>;
export type CondenseObservation = z.infer<typeof condenseObservationSchema>;

export interface CondenseExecutionContext {
  /** Persist the request; the agent applies the reset after the tool result is durable. */
  requestCondensation(action: CondenseAction): CondenseObservation | Promise<CondenseObservation>;
}

/** Opt-in tool; the agent-reset runtime supplies its execution context. */
export class CondenseTool {
  static readonly className = 'CondenseTool';

  static create(): ToolDefinition<typeof condenseActionSchema, typeof condenseObservationSchema> {
    return new ToolDefinition({
      name: 'condense',
      description: 'Request a fresh active context while retaining your message to your future self. '
        + 'You decide when to condense. Save any durable notes you want to recover with your existing tools first; '
        + 'this tool does not write memory files. Make this the only tool call in your response. '
        + 'message_to_future_self is optional and may contain up to 16,384 UTF-16 code units. '
        + 'The agent runtime applies the reset after this tool result is saved.',
      inputSchema: condenseActionSchema,
      outputSchema: condenseObservationSchema,
      meta: { smolpaws_agent_condense: true },
      usable: true,
      executor: (action, context) => {
        if (!isCondenseExecutionContext(context)) {
          return condenseObservationSchema.parse({
            content: [textContent('Cannot request context condensation without an active agent-reset context.')],
            is_error: true,
            message_to_future_self: action.message_to_future_self ?? null,
          });
        }
        return context.requestCondensation(action);
      },
    });
  }
}

function isCondenseExecutionContext(context: unknown): context is CondenseExecutionContext {
  return typeof context === 'object' && context !== null && !Array.isArray(context)
    && 'requestCondensation' in context && typeof context.requestCondensation === 'function';
}
