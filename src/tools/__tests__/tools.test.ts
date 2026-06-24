import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileEditorExecutor, GlobExecutor, GrepExecutor, TaskTrackerExecutor, TerminalExecutor, BrowserTool } from '../index.js';

describe('TerminalExecutor', () => {
  it('runs commands in the configured working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-terminal-'));
    try {
      await writeFile(join(root, 'hello.txt'), 'hello');
      const result = await new TerminalExecutor({ workingDir: root }).execute({ command: 'pwd && cat hello.txt' });

      expect(result.exit_code).toBe(0);
      expect(result.text).toContain(root);
      expect(result.text).toContain('hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('FileEditorExecutor', () => {
  it('views, edits, inserts, and undoes edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-editor-'));
    const path = join(root, 'file.txt');
    try {
      const editor = new FileEditorExecutor({ workspaceRoot: root });
      await expect(editor.execute({ command: 'create', path, file_text: 'one\ntwo\n' })).resolves.toMatchObject({ is_error: false, prev_exist: false });
      await expect(editor.execute({ command: 'view', path })).resolves.toMatchObject({ text: expect.stringContaining('1\tone') });
      await expect(editor.execute({ command: 'str_replace', path, old_str: 'two', new_str: 'three' })).resolves.toMatchObject({ is_error: false });
      await expect(editor.execute({ command: 'insert', path, insert_line: 1, new_str: 'inserted' })).resolves.toMatchObject({ is_error: false });
      await expect(readFile(path, 'utf8')).resolves.toBe('one\ninserted\nthree\n');
      await expect(editor.execute({ command: 'undo_edit', path })).resolves.toMatchObject({ is_error: false });
      await expect(readFile(path, 'utf8')).resolves.toBe('one\nthree\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects non-unique replacements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-editor-'));
    const path = join(root, 'file.txt');
    try {
      await writeFile(path, 'same\nsame\n');
      const result = await new FileEditorExecutor({ workspaceRoot: root }).execute({ command: 'str_replace', path, old_str: 'same', new_str: 'new' });
      expect(result.is_error).toBe(true);
      expect(result.text).toContain('multiple');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GlobExecutor and GrepExecutor', () => {
  it('find files and matching text recursively', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-search-'));
    try {
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'one.ts'), 'const needle = 1;\n');
      await writeFile(join(root, 'src', 'two.txt'), 'nothing\n');

      expect((await new GlobExecutor({ workingDir: root }).execute({ pattern: '*.ts' })).files.map((file) => file.endsWith('one.ts'))).toEqual([true]);
      const grep = await new GrepExecutor({ workingDir: root }).execute({ pattern: 'needle', path: root, include: '*.ts' });
      expect(grep.matches).toHaveLength(1);
      expect(grep.matches[0]).toMatchObject({ line: 1, text: 'const needle = 1;' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('TaskTrackerExecutor', () => {
  it('plans, views, and persists tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openhands-tasks-'));
    try {
      const tracker = new TaskTrackerExecutor({ saveDir: root });
      await expect(tracker.execute({ command: 'plan', task_list: [{ title: 'Ship', status: 'in_progress' }] })).resolves.toMatchObject({ task_list: [{ title: 'Ship', status: 'in_progress', notes: '' }] });
      await expect(tracker.execute({ command: 'view' })).resolves.toMatchObject({ text: expect.stringContaining('Ship') });
      await expect(readFile(join(root, 'TASKS.md'), 'utf8')).resolves.toContain('Ship');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('BrowserTool', () => {
  it('creates an injectable browser-backed tool definition', async () => {
    const tool = BrowserTool.create({ adapter: { navigate: async (url) => ({ text: `navigated ${url}`, is_error: false }) } });

    await expect(tool.execute({ command: 'navigate', url: 'https://example.com' })).resolves.toMatchObject({ text: 'navigated https://example.com' });
  });
});
