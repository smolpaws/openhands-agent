import { z } from 'zod';

import { contentSchema, textContent, type Content } from '../llm/index.js';
import { DEFAULT_TRUNCATE_NOTICE, maybeTruncate } from '../utils/index.js';

// Python terminal/constants.py. This is a character budget, not exec's byte buffer.
export const MAX_CMD_OUTPUT_SIZE = 30_000;
const ERROR_HEADER = '[An error occurred during execution.]\n';

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
  // Host adapters may persist an already-rendered result. Preserve its precedence
  // and block metadata; do not format or persist it a second time.
  if (Array.isArray(observation.to_llm_content)) {
    return clipRenderedContent(z.array(contentSchema).parse(observation.to_llm_content));
  }

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
  if (observation.is_error === true) content.push(textContent(ERROR_HEADER));
  content.push(textContent(maybeTruncate(output, {
    truncateAfter: MAX_CMD_OUTPUT_SIZE,
    saveDir: typeof observation.full_output_save_dir === 'string' ? observation.full_output_save_dir : null,
    toolPrefix: 'terminal',
  })));
  return content;
}

/** Apply one head/tail budget across text blocks without flattening other content. */
function clipRenderedContent(content: Content[]): Content[] {
  const characters = content.map((part, index) =>
    part.type !== 'text' || (index === 0 && part.text === ERROR_HEADER)
      ? null : /[\u{10000}-\u{10FFFF}]/u.test(part.text) ? Array.from(part.text) : part.text);
  const length = characters.reduce((total, part) => total + (part?.length ?? 0), 0);
  if (length <= MAX_CMD_OUTPUT_SIZE) return content;

  const available = MAX_CMD_OUTPUT_SIZE - Array.from(DEFAULT_TRUNCATE_NOTICE).length;
  const headEnd = Math.ceil(available / 2);
  const tailStart = length - Math.floor(available / 2);
  let offset = 0;
  let noticeInserted = false;
  return content.flatMap((part, index): Content[] => {
    const text = characters[index];
    if (part.type !== 'text' || text === null || text === undefined) return [part];
    const start = offset;
    offset += text.length;
    const head = text.slice(0, Math.max(0, headEnd - start));
    let clipped = typeof head === 'string' ? head : head.join('');
    if (!noticeInserted && offset > headEnd) {
      clipped += DEFAULT_TRUNCATE_NOTICE;
      noticeInserted = true;
    }
    const tail = text.slice(Math.max(0, tailStart - start));
    clipped += typeof tail === 'string' ? tail : tail.join('');
    return clipped.length === 0 && text.length > 0 ? [] : [{ ...part, text: clipped }];
  });
}
