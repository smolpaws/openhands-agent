import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { toLLMMessage, observationEventSchema } from '../../event/index.js';
import { DEFAULT_TRUNCATE_NOTICE } from '../../utils/index.js';
import { TerminalExecutor } from '../index.js';
import oracle from '../../../transpile/wire/python-terminal-oracle.json';
import upstream from '../../../transpile/upstream.json';

const LIMIT = 30_000;
const ERROR_HEADER = '[An error occurred during execution.]\n';
const metadata = { prefix: '', suffix: '', working_dir: '/tmp', py_interpreter_path: '/usr/bin/python', exit_code: 0, pid: 123 };
const trailing = '\n[Current working directory: /tmp]\n[Python interpreter: /usr/bin/python]\n[Command finished with exit code 0]';

function projectContent(observation: Record<string, unknown>) {
  const event = observationEventSchema.parse({ tool_name: 'terminal', tool_call_id: 'call', action_id: 'action', observation });
  const restored = observationEventSchema.parse(JSON.parse(JSON.stringify(event)));
  const before = JSON.stringify(restored);
  const message = toLLMMessage(restored);
  expect(JSON.stringify(restored)).toBe(before);
  expect(message).toMatchObject({ role: 'tool', tool_call_id: 'call', name: 'terminal' });
  return message.content;
}

function project(observation: Record<string, unknown>) {
  return projectContent(observation).map((part) => {
    expect(part.type).toBe('text');
    return part.type === 'text' ? part.text : '';
  });
}

// Adapted from Python tests/tools/terminal/test_observation_truncation.py.
describe('terminal observation projection', () => {
  it('uses the canonical pin for the source-derived Python oracle', () => {
    expect(oracle.source.commit).toBe(upstream.commit);
  });

  it.each(oracle.cases)('matches pinned Python rendering: $id', (entry) => {
    const output = project({ text: entry.text.repeat(entry.repeat), metadata: entry.metadata, is_error: entry.is_error });
    expect(output.map((text) => ({ characters: [...text].length, sha256: createHash('sha256').update(text).digest('hex') }))).toEqual(entry.expected);
  });
  it('formats short output with terminal metadata', () => {
    expect(project({ text: 'Short output', command: 'echo test', metadata })).toEqual([`Short output${trailing}`]);
  });

  it('clips oversized restored output, preserving its head, tail and metadata', () => {
    const [text] = project({ text: 'A'.repeat(3_500_000), command: 'echo test', metadata });
    expect(text).toHaveLength(LIMIT);
    expect(text).toContain(DEFAULT_TRUNCATE_NOTICE);
    expect(text!.startsWith('A')).toBe(true);
    expect(text!.endsWith(`A${trailing}`)).toBe(true);
  });

  it('keeps the upstream error header separate from the bounded output', () => {
    const [header, text] = project({ text: 'B'.repeat(LIMIT + 500), command: 'false', is_error: true, metadata: { ...metadata, exit_code: 1 } });
    expect(header).toBe(ERROR_HEADER);
    expect(text).toHaveLength(LIMIT);
    expect(text).toContain(DEFAULT_TRUNCATE_NOTICE);
    expect(text!.endsWith('[Command finished with exit code 1]')).toBe(true);
  });

  it('does not clip formatted output exactly at the limit', () => {
    const output = 'C'.repeat(LIMIT - trailing.length);
    expect(project({ text: output, command: 'echo test', metadata })).toEqual([output + trailing]);
  });

  it('retains metadata prefixes and suffixes', () => {
    const [text] = project({ text: 'D'.repeat(LIMIT + 200), command: 'echo test', metadata: { ...metadata, prefix: '[PREFIX] ', suffix: ' [SUFFIX]' } });
    expect(text).toHaveLength(LIMIT);
    expect(text!.startsWith('[PREFIX] D')).toBe(true);
    expect(text!.endsWith(`D [SUFFIX]${trailing}`)).toBe(true);
  });

  it('counts Python characters and never splits Unicode surrogate pairs', () => {
    const [text] = project({ text: '🙂'.repeat(LIMIT + 1), exit_code: -1 });
    expect([...text!]).toHaveLength(LIMIT);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(text!.startsWith('🙂')).toBe(true);
    expect(text!.endsWith('🙂')).toBe(true);
  });

  it('supports legacy observations and does not repeat the command in the result', () => {
    expect(project({ text: 'done', command: 'echo done', exit_code: 0, timeout: false, is_error: false })).toEqual(['done\n[Command finished with exit code 0]']);
  });

  it('caps Python-shaped terminal content on replay as well', () => {
    const [text] = project({ content: [{ type: 'text', text: 'A'.repeat(LIMIT) }, { type: 'text', text: 'tail' }], metadata });
    expect(text).toHaveLength(LIMIT);
    expect(text).toContain(DEFAULT_TRUNCATE_NOTICE);
    expect(text!.endsWith(`tail${trailing}`)).toBe(true);
  });

  it('caps restored pre-rendered terminal output', () => {
    const [text] = project({ to_llm_content: [{ type: 'text', text: 'A'.repeat(100_000) }] });
    expect(text).toHaveLength(LIMIT);
    expect(text).toContain(DEFAULT_TRUNCATE_NOTICE);
    expect(text!.startsWith('A')).toBe(true);
    expect(text!.endsWith('A')).toBe(true);
  });

  it('shares the pre-rendered text budget across blocks', () => {
    const parts = projectContent({ to_llm_content: [
      { type: 'text', text: 'A'.repeat(20_000), cache_prompt: true },
      { type: 'text', text: 'B'.repeat(20_000), cache_prompt: false },
    ] });
    expect(parts).toHaveLength(2);
    expect(parts.map(part => part.cache_prompt)).toEqual([true, false]);
    const text = parts.map(part => part.type === 'text' ? part.text : '').join('');
    expect(text).toHaveLength(LIMIT);
    expect(text).toContain(DEFAULT_TRUNCATE_NOTICE);
    expect(text.startsWith('A')).toBe(true);
    expect(text.endsWith('B')).toBe(true);
  });

  it('preserves pre-rendered headers, images and Unicode block boundaries', () => {
    const image = { type: 'image', image_urls: ['https://example.test/output.png'], cache_prompt: true };
    const parts = projectContent({ is_error: true, to_llm_content: [
      { type: 'text', text: ERROR_HEADER, cache_prompt: false },
      { type: 'text', text: '🙂'.repeat(20_000), cache_prompt: true },
      image,
      { type: 'text', text: '🐾'.repeat(20_000), cache_prompt: false },
    ] });
    expect(parts.map(part => part.type)).toEqual(['text', 'text', 'image', 'text']);
    expect(parts[0]).toEqual({ type: 'text', text: ERROR_HEADER, cache_prompt: false });
    expect(parts[2]).toEqual(image);
    expect(parts.map(part => part.cache_prompt)).toEqual([false, true, true, false]);
    const body = parts.slice(1).map(part => part.type === 'text' ? part.text : '').join('');
    expect([...body]).toHaveLength(LIMIT);
    expect(body).toContain(DEFAULT_TRUNCATE_NOTICE);
    expect(body.startsWith('🙂')).toBe(true);
    expect(body.endsWith('🐾')).toBe(true);
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it('omits fully clipped middle text blocks while preserving intervening images', () => {
    const image = { type: 'image', image_urls: ['https://example.test/output.png'], cache_prompt: true };
    const parts = projectContent({ to_llm_content: [
      { type: 'text', text: 'A'.repeat(20_000), cache_prompt: false },
      image,
      { type: 'text', text: 'B'.repeat(20_000), cache_prompt: true },
      { type: 'text', text: 'C'.repeat(20_000), cache_prompt: true },
    ] });
    expect(parts.map(part => part.type)).toEqual(['text', 'image', 'text']);
    expect(parts[1]).toEqual(image);
    expect(parts.map(part => part.cache_prompt)).toEqual([false, true, true]);
    const text = parts.map(part => part.type === 'text' ? part.text : '').join('');
    expect(text).toHaveLength(LIMIT);
    expect(text).toContain(DEFAULT_TRUNCATE_NOTICE);
    expect(text).not.toContain('B');
    expect(text.startsWith('A')).toBe(true);
    expect(text.endsWith('C')).toBe(true);
  });

  it('leaves short pre-rendered content unchanged, without formatting it twice', () => {
    const content = [
      { type: 'text', text: ERROR_HEADER, cache_prompt: false },
      { type: 'text', text: 'already formatted', cache_prompt: true },
      { type: 'image', image_urls: ['https://example.test/output.png'], cache_prompt: false },
    ];
    expect(projectContent({ to_llm_content: content, is_error: true, metadata })).toEqual(content);
  });

  it('preserves explicit pre-rendered precedence over raw text and content', () => {
    const explicit = [{ type: 'text', text: 'already formatted', cache_prompt: true }];
    expect(projectContent({ to_llm_content: explicit, text: 'raw text', content: [{ type: 'text', text: 'raw content' }], metadata })).toEqual(explicit);
    expect(projectContent({ to_llm_content: [], text: 'raw text' })).toEqual([]);
  });

  it('does not change the projection of other tools', () => {
    const observation = { text: 'A'.repeat(LIMIT + 1), command: 'view', exit_code: 0 };
    const event = observationEventSchema.parse({ tool_name: 'other_tool', tool_call_id: 'call', action_id: 'action', observation });
    expect(toLLMMessage(event).content[0]).toMatchObject({ type: 'text', text: JSON.stringify(observation) });
  });

  it('saves full formatted output only when an explicit persistence directory is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'terminal-projection-'));
    try {
      const original = 'line\n'.repeat(10_000);
      const [text] = project({ text: original, metadata, full_output_save_dir: dir });
      const file = /saved to (.+?) - you can/u.exec(text!)?.[1];
      expect(file).toBeDefined();
      expect(await readFile(file!, 'utf8')).toBe(original + trailing);
      expect([...text!]).toHaveLength(LIMIT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Adapted from Python test_terminal_session.py output-boundary regressions.
describe('terminal execution output cap', () => {
  it('caps stdout and stderr together, preserving the first stdout and final stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-combined-cap-'));
    try {
      await writeFile(join(root, 'stdout.txt'), 'A'.repeat(20_000));
      await writeFile(join(root, 'stderr.txt'), 'B'.repeat(20_000));
      const result = await new TerminalExecutor({ workingDir: root }).execute({ command: 'cat stdout.txt; cat stderr.txt >&2' });
      expect(result.text).toHaveLength(LIMIT);
      expect(result.text.startsWith('A')).toBe(true);
      expect(result.text.endsWith('B')).toBe(true);
      expect(result.text).toContain(DEFAULT_TRUNCATE_NOTICE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['single-line success', 'A'.repeat(100_000), '', false],
    ['multiline success', 'line\n'.repeat(15_000), '', false],
    ['stderr failure', 'B'.repeat(100_000), ' >&2; exit 3', true],
    ['timeout', 'C'.repeat(100_000), '; sleep 5', true],
    ['Unicode output', '🙂'.repeat(30_001), '', false],
  ])('bounds %s before storing the observation and again before the LLM', async (_name, output, suffix, isError) => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-cap-'));
    try {
      await writeFile(join(root, 'output.txt'), output);
      const result = await new TerminalExecutor({ workingDir: root }).execute({ command: `cat output.txt${suffix}`, timeout: suffix.includes('sleep') ? 0.2 : 0 });
      expect([...result.text]).toHaveLength(LIMIT);
      expect(result.text).toContain(DEFAULT_TRUNCATE_NOTICE);
      expect(result.is_error).toBe(isError);
      expect(result.timeout).toBe(suffix.includes('sleep'));
      expect(result.exit_code).toBe(suffix.includes('sleep') ? -1 : isError ? 3 : 0);
      const projected = project(result);
      const body = projected.at(-1)!;
      expect([...body].length).toBeLessThanOrEqual(LIMIT);
      expect(body).toContain('[Current working directory:');
      if (result.timeout) expect(body).toContain('timed out after 0.2s');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
