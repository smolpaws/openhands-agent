import { z } from 'zod';

import { contentSchema, textContent, type Content } from '../llm/index.js';
import { maybeTruncate } from '../utils/index.js';

// Python terminal/constants.py. This is a character budget, not exec's byte buffer.
export const MAX_CMD_OUTPUT_SIZE = 30_000;

export const terminalMetadataSchema = z.object({
  exit_code: z.number().int().default(-1),
  pid: z.number().int().default(-1),
  username: z.string().nullable().default(null),
  hostname: z.string().nullable().default(null),
  working_dir: z.string().nullable().default(null),
  py_interpreter_path: z.string().nullable().default(null),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
}).strict();

/** Render terminal results at the replay boundary, including pre-cap saved events. */
export function terminalObservationContent(observation: Record<string, unknown>): Content[] | null {
  // Python wire observations store content; older TypeScript observations store text.
  const text = typeof observation.text === 'string' ? observation.text
    : Array.isArray(observation.content) ? z.array(contentSchema).parse(observation.content)
      .map((part) => part.type === 'text' ? part.text : '').join('') : null;
  if (text === null) return null;

  // Older TypeScript observations only carry the top-level exit code.
  const metadata = terminalMetadataSchema.parse(observation.metadata ?? {
    exit_code: typeof observation.exit_code === 'number' ? observation.exit_code : -1,
  });
  let output = `${metadata.prefix}${text}${metadata.suffix}`;
  if (metadata.working_dir) output += `\n[Current working directory: ${metadata.working_dir}]`;
  if (metadata.py_interpreter_path) output += `\n[Python interpreter: ${metadata.py_interpreter_path}]`;
  if (metadata.exit_code !== -1) output += `\n[Command finished with exit code ${metadata.exit_code}]`;

  const content: Content[] = [];
  if (observation.is_error === true) content.push(textContent('[An error occurred during execution.]\n'));
  content.push(textContent(maybeTruncate(output, {
    truncateAfter: MAX_CMD_OUTPUT_SIZE,
    saveDir: typeof observation.full_output_save_dir === 'string' ? observation.full_output_save_dir : null,
    toolPrefix: 'terminal',
  })));
  return content;
}
