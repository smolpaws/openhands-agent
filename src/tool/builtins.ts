import { z } from 'zod';

import { ToolDefinition, toolAnnotationsSchema, type ToolAnnotations } from './index.js';

export const baseObservationSchema = z
  .object({
    text: z.string(),
    is_error: z.boolean().default(false),
  })
  .strict();

export const finishActionSchema = z
  .object({
    message: z.string().describe('Final message to send to the user.'),
  })
  .strict();

export const thinkActionSchema = z
  .object({
    thought: z.string().describe('The thought to log.'),
  })
  .strict();

export type BaseObservation = z.infer<typeof baseObservationSchema>;
export type FinishAction = z.infer<typeof finishActionSchema>;
export type ThinkAction = z.infer<typeof thinkActionSchema>;

const safeBuiltinAnnotations: ToolAnnotations = toolAnnotationsSchema.parse({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const FINISH_DESCRIPTION = `Signals the completion of the current task or conversation.

Use this tool when:
- You have successfully completed the user's requested task
- You cannot proceed further due to technical limitations or missing information

The message should include:
- A clear summary of actions taken and their results
- Any next steps for the user
- Explanation if you're unable to complete the task
- Any follow-up questions if more information is needed
`;

export class FinishTool {
  static readonly className = 'FinishTool';

  static create(): ToolDefinition<typeof finishActionSchema, typeof baseObservationSchema> {
    return new ToolDefinition({
      name: 'finish',
      description: FINISH_DESCRIPTION,
      inputSchema: finishActionSchema,
      outputSchema: baseObservationSchema,
      annotations: toolAnnotationsSchema.parse({ ...safeBuiltinAnnotations, title: 'finish' }),
      executor: (action) => ({ text: action.message, is_error: false }),
    });
  }
}

const THINK_DESCRIPTION = `Use the tool to think about something. It will not obtain new information or make any changes to the repository, but just log the thought. Use it when complex reasoning or brainstorming is needed.

Common use cases:
1. When exploring a repository and discovering the source of a bug, call this tool to brainstorm several unique ways of fixing the bug, and assess which change(s) are likely to be simplest and most effective.
2. After receiving test results, use this tool to brainstorm ways to fix failing tests.
3. When planning a complex refactoring, use this tool to outline different approaches and their tradeoffs.
4. When designing a new feature, use this tool to think through architecture decisions and implementation details.
5. When debugging a complex issue, use this tool to organize your thoughts and hypotheses.

The tool simply logs your thought process for better transparency and does not execute any code or make changes.`;

export class ThinkTool {
  static readonly className = 'ThinkTool';

  static create(): ToolDefinition<typeof thinkActionSchema, typeof baseObservationSchema> {
    return new ToolDefinition({
      name: 'think',
      description: THINK_DESCRIPTION,
      inputSchema: thinkActionSchema,
      outputSchema: baseObservationSchema,
      annotations: safeBuiltinAnnotations,
      executor: () => ({ text: 'Your thought has been logged.', is_error: false }),
    });
  }
}

export type BuiltInToolFactory = () => ToolDefinition;

export const BUILT_IN_TOOLS = [() => FinishTool.create(), () => ThinkTool.create()] satisfies readonly BuiltInToolFactory[];

export const BUILT_IN_TOOL_FACTORIES = {
  FinishTool: () => FinishTool.create(),
  ThinkTool: () => ThinkTool.create(),
} satisfies Readonly<Record<string, BuiltInToolFactory>>;
