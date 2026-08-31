/**
 * EXT-SDK-001 — outbound message tool (SmolPaws additive extension).
 *
 * This tool has no upstream counterpart. It lets the agent emit a mid-turn outbound
 * message as an ordinary `ActionEvent`; it records intent only and performs no delivery.
 * Delivery is owned by the SmolPaws coordinator, which projects the action into its
 * durable outbox. The tool does not end the turn — the agent keeps working after it.
 *
 * See docs/TRANSPILE_CONTRACT.md → Additive extensions. This file is target-only and is
 * not judged by the upstream parity oracle.
 */
import { z } from 'zod';

import { ToolDefinition, toolAnnotationsSchema } from '../index.js';

export const SEND_MESSAGE_TOOL_NAME = 'send_message';

export const sendMessageActionSchema = z
  .object({
    text: z.string().min(1).describe('The message text to send to the current thread.'),
  })
  .strict();

export const sendMessageObservationSchema = z
  .object({
    text: z.string(),
    is_error: z.boolean().default(false),
  })
  .strict();

export type SendMessageAction = z.infer<typeof sendMessageActionSchema>;
export type SendMessageObservation = z.infer<typeof sendMessageObservationSchema>;

const SEND_MESSAGE_DESCRIPTION = `Send a message to the current ingress thread.

Use this to say something to the user mid-task without ending your turn — for example a
short progress update, or an intermediate answer while you keep working. You can call it
more than once in a turn. To end the turn, use \`finish\` or reply with a plain message.

The message is queued for delivery to whatever channel started this conversation.`;

export class SendMessageTool {
  static readonly className = 'SendMessageTool';

  static create(): ToolDefinition<typeof sendMessageActionSchema, typeof sendMessageObservationSchema> {
    return new ToolDefinition({
      name: SEND_MESSAGE_TOOL_NAME,
      description: SEND_MESSAGE_DESCRIPTION,
      inputSchema: sendMessageActionSchema,
      outputSchema: sendMessageObservationSchema,
      annotations: toolAnnotationsSchema.parse({
        title: 'send_message',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      }),
      // Record intent only. The ActionEvent on the EventLog is the durable outbound signal;
      // the SmolPaws coordinator's extractor turns it into one delivery. No I/O happens here.
      // The observation is a fixed confirmation — it does not echo the message text back
      // (the model already has it, and echoing just burns tokens).
      executor: () => ({
        text: 'Message queued for delivery to the current thread.',
        is_error: false,
      }),
    });
  }
}
