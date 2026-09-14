/** EXT-SDK-001: outbound file intent. The host owns validation, spooling and delivery. */
import { z } from 'zod';
import { ToolDefinition, toolAnnotationsSchema } from '../index.js';
import { sendMessageObservationSchema } from './send-message.js';

export const sendMediaActionSchema = z.object({
  path: z.string().min(1).describe('Path to a file in this conversation workspace.'),
  media_type: z.enum(['image', 'video', 'audio', 'document']),
  caption: z.string().optional(),
  mime_type: z.string().optional(),
  voice_note: z.boolean().optional().describe('Send OGG/Opus audio as a voice note where supported.'),
}).strict();

export class SendMediaTool {
  static readonly className = 'SendMediaTool';
  static create(): ToolDefinition<typeof sendMediaActionSchema, typeof sendMessageObservationSchema> {
    return new ToolDefinition({
      name: 'send_media', description: 'Send a file to the current ingress thread without ending the turn. The host validates and queues delivery.',
      inputSchema: sendMediaActionSchema, outputSchema: sendMessageObservationSchema,
      annotations: toolAnnotationsSchema.parse({ title: 'send_media', readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
      executor: () => ({ text: 'Media delivery requested.', is_error: false }),
    });
  }
}
