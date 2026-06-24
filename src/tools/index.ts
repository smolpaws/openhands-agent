import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep, posix } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { ToolDefinition, toolAnnotationsSchema } from '../tool/index.js';

const execAsync = promisify(exec);

export const baseToolObservationSchema = z.object({ text: z.string(), is_error: z.boolean().default(false) }).strict();

export const terminalActionSchema = z.object({ command: z.string(), is_input: z.boolean().default(false), timeout: z.number().nonnegative().nullable().default(null), reset: z.boolean().default(false) }).strict();
export const terminalObservationSchema = baseToolObservationSchema.extend({ command: z.string().nullable().default(null), exit_code: z.number().nullable().default(null), timeout: z.boolean().default(false) }).strict();
export type TerminalAction = z.infer<typeof terminalActionSchema>;
export type TerminalObservation = z.infer<typeof terminalObservationSchema>;

export class TerminalExecutor {
  readonly workingDir: string;
  constructor(options: { readonly workingDir: string }) { this.workingDir = options.workingDir; }
  async execute(action: TerminalAction): Promise<TerminalObservation> {
    const parsed = terminalActionSchema.parse(action);
    if (parsed.is_input) return { text: 'Interactive input is not supported by this executor.', is_error: true, command: parsed.command, exit_code: null, timeout: false };
    try {
      const { stdout, stderr } = await execAsync(parsed.command, { cwd: this.workingDir, timeout: parsed.timeout === null ? undefined : parsed.timeout * 1000 });
      return { text: `${stdout}${stderr}`, is_error: false, command: parsed.command, exit_code: 0, timeout: false };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { text: `${err.stdout ?? ''}${err.stderr ?? String(error)}`, is_error: true, command: parsed.command, exit_code: typeof err.code === 'number' ? err.code : -1, timeout: err.killed ?? false };
    }
  }
}

export class TerminalTool {
  static create(options: { readonly workingDir: string }): ToolDefinition<typeof terminalActionSchema, typeof terminalObservationSchema> {
    const executor = new TerminalExecutor(options);
    return new ToolDefinition({ name: 'terminal', description: 'Execute a shell command in the project workspace.', inputSchema: terminalActionSchema, outputSchema: terminalObservationSchema, annotations: toolAnnotationsSchema.parse({ title: 'terminal', openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
}

export type FileEditorCommand = 'view' | 'create' | 'str_replace' | 'insert' | 'undo_edit';
export const fileEditorActionSchema = z.object({ command: z.enum(['view', 'create', 'str_replace', 'insert', 'undo_edit']), path: z.string(), file_text: z.string().nullable().default(null), old_str: z.string().nullable().default(null), new_str: z.string().nullable().default(null), insert_line: z.number().int().nonnegative().nullable().default(null), view_range: z.array(z.number().int()).nullable().default(null) }).strict();
export const fileEditorObservationSchema = baseToolObservationSchema.extend({ command: z.enum(['view', 'create', 'str_replace', 'insert', 'undo_edit']), path: z.string().nullable().default(null), prev_exist: z.boolean().default(true), old_content: z.string().nullable().default(null), new_content: z.string().nullable().default(null) }).strict();
export type FileEditorAction = z.infer<typeof fileEditorActionSchema>;
export type FileEditorObservation = z.infer<typeof fileEditorObservationSchema>;

export class FileEditorExecutor {
  private readonly history = new Map<string, string[]>();
  readonly workspaceRoot: string | null;
  constructor(options: { readonly workspaceRoot?: string | null } = {}) { this.workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : null; }
  async execute(action: FileEditorAction): Promise<FileEditorObservation> {
    const parsed = fileEditorActionSchema.parse(action);
    const path = this.resolvePath(parsed.path);
    try {
      if (parsed.command === 'view') return await this.view(path, parsed);
      if (parsed.command === 'create') return await this.create(path, parsed);
      if (parsed.command === 'str_replace') return await this.strReplace(path, parsed);
      if (parsed.command === 'insert') return await this.insert(path, parsed);
      return await this.undo(path, parsed);
    } catch (error) {
      return this.observation({ text: error instanceof Error ? error.message : String(error), is_error: true, command: parsed.command, path });
    }
  }
  private resolvePath(path: string): string {
    const resolved = resolve(path);
    if (this.workspaceRoot !== null && !(resolved === this.workspaceRoot || resolved.startsWith(`${this.workspaceRoot}${sep}`))) throw new Error(`Path escapes workspace: ${path}`);
    return resolved;
  }
  private async view(path: string, action: FileEditorAction): Promise<FileEditorObservation> {
    const info = await stat(path);
    if (info.isDirectory()) return this.observation({ text: (await listDirectory(path)).join('\n'), is_error: false, command: action.command, path });
    const numbered = numberLines(await readFile(path, 'utf8'), action.view_range);
    return this.observation({ text: numbered, is_error: false, command: action.command, path });
  }
  private async create(path: string, action: FileEditorAction): Promise<FileEditorObservation> {
    if (action.file_text === null) throw new Error('file_text is required for create');
    if (await exists(path)) throw new Error(`File already exists: ${path}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, action.file_text);
    return this.observation({ text: `File created: ${path}`, is_error: false, command: action.command, path, prev_exist: false, new_content: action.file_text });
  }
  private async strReplace(path: string, action: FileEditorAction): Promise<FileEditorObservation> {
    if (action.old_str === null) throw new Error('old_str is required for str_replace');
    const oldContent = await readFile(path, 'utf8');
    const count = oldContent.split(action.old_str).length - 1;
    if (count === 0) throw new Error('old_str was not found in the file');
    if (count > 1) throw new Error('old_str appears multiple times; provide a unique match');
    this.pushHistory(path, oldContent);
    const newContent = oldContent.replace(action.old_str, action.new_str ?? '');
    await writeFile(path, newContent);
    return this.observation({ text: `Edited ${path}`, is_error: false, command: action.command, path, old_content: oldContent, new_content: newContent });
  }
  private async insert(path: string, action: FileEditorAction): Promise<FileEditorObservation> {
    if (action.insert_line === null || action.new_str === null) throw new Error('insert_line and new_str are required for insert');
    const oldContent = await readFile(path, 'utf8');
    this.pushHistory(path, oldContent);
    const lines = oldContent.split('\n');
    lines.splice(action.insert_line, 0, action.new_str);
    const newContent = normalizeTrailingNewline(lines.join('\n'), oldContent);
    await writeFile(path, newContent);
    return this.observation({ text: `Inserted text into ${path}`, is_error: false, command: action.command, path, old_content: oldContent, new_content: newContent });
  }
  private async undo(path: string, action: FileEditorAction): Promise<FileEditorObservation> {
    const stack = this.history.get(path) ?? [];
    const previous = stack.pop();
    if (previous === undefined) throw new Error(`No edit history for ${path}`);
    const oldContent = await readFile(path, 'utf8').catch(() => '');
    await writeFile(path, previous);
    return this.observation({ text: `Undid last edit for ${path}`, is_error: false, command: action.command, path, old_content: oldContent, new_content: previous });
  }
  private observation(partial: Omit<Partial<FileEditorObservation>, 'text' | 'command'> & Pick<FileEditorObservation, 'text' | 'command'>): FileEditorObservation {
    return fileEditorObservationSchema.parse({ path: null, prev_exist: true, old_content: null, new_content: null, ...partial });
  }
  private pushHistory(path: string, content: string): void { this.history.set(path, [...(this.history.get(path) ?? []), content]); }
}

export class FileEditorTool {
  static create(options: { readonly workspaceRoot?: string | null } = {}): ToolDefinition<typeof fileEditorActionSchema, typeof fileEditorObservationSchema> {
    const executor = new FileEditorExecutor(options);
    return new ToolDefinition({ name: 'file_editor', description: 'View and edit text files with create, replace, insert, and undo operations.', inputSchema: fileEditorActionSchema, outputSchema: fileEditorObservationSchema, annotations: toolAnnotationsSchema.parse({ title: 'file_editor', destructiveHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
}

export const globActionSchema = z.object({ pattern: z.string(), path: z.string().nullable().default(null) }).strict();
export const globObservationSchema = baseToolObservationSchema.extend({ files: z.array(z.string()).default([]), pattern: z.string(), search_path: z.string(), truncated: z.boolean().default(false) }).strict();
export type GlobAction = z.infer<typeof globActionSchema>;
export type GlobObservation = z.infer<typeof globObservationSchema>;

export class GlobExecutor {
  readonly workingDir: string;
  constructor(options: { readonly workingDir: string }) { this.workingDir = resolve(options.workingDir); }
  async execute(action: GlobAction): Promise<GlobObservation> {
    const parsed = globActionSchema.parse(action);
    const searchPath = resolve(parsed.path ?? this.workingDir);
    const files = (await walkFiles(searchPath)).filter((file) => globMatch(parsed.pattern, file.slice(searchPath.length + 1))).slice(0, 100);
    const text = files.length === 0 ? `No files found matching pattern '${parsed.pattern}' in directory '${searchPath}'` : `Found ${files.length} file(s) matching pattern '${parsed.pattern}' in '${searchPath}':\n${files.join('\n')}`;
    return { text, is_error: false, files, pattern: parsed.pattern, search_path: searchPath, truncated: files.length >= 100 };
  }
}

export class GlobTool {
  static create(options: { readonly workingDir: string }): ToolDefinition<typeof globActionSchema, typeof globObservationSchema> {
    const executor = new GlobExecutor(options);
    return new ToolDefinition({ name: 'glob', description: 'Find files by glob pattern recursively.', inputSchema: globActionSchema, outputSchema: globObservationSchema, annotations: toolAnnotationsSchema.parse({ title: 'glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
}

export const grepActionSchema = z.object({ pattern: z.string(), path: z.string().nullable().default(null), include: z.string().nullable().default(null), max_results: z.number().int().positive().default(100) }).strict();
export const grepMatchSchema = z.object({ file: z.string(), line: z.number(), text: z.string() }).strict();
export const grepObservationSchema = baseToolObservationSchema.extend({ matches: z.array(grepMatchSchema), pattern: z.string(), search_path: z.string(), truncated: z.boolean().default(false) }).strict();
export type GrepAction = z.infer<typeof grepActionSchema>;
export type GrepObservation = z.infer<typeof grepObservationSchema>;

export class GrepExecutor {
  readonly workingDir: string;
  constructor(options: { readonly workingDir: string }) { this.workingDir = resolve(options.workingDir); }
  async execute(action: GrepAction): Promise<GrepObservation> {
    const parsed = grepActionSchema.parse(action);
    const searchPath = resolve(parsed.path ?? this.workingDir);
    const regex = new RegExp(parsed.pattern, 'u');
    const matches: z.infer<typeof grepMatchSchema>[] = [];
    for (const file of await walkFiles(searchPath)) {
      const rel = file.slice(searchPath.length + 1);
      if (parsed.include !== null && !globMatch(parsed.include, rel)) continue;
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) continue;
      text.split(/\r?\n/u).forEach((lineText, index) => {
        if (matches.length < parsed.max_results && regex.test(lineText)) matches.push({ file, line: index + 1, text: lineText });
      });
    }
    return { text: matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n') || `No matches for '${parsed.pattern}'`, is_error: false, matches, pattern: parsed.pattern, search_path: searchPath, truncated: matches.length >= parsed.max_results };
  }
}

export class GrepTool {
  static create(options: { readonly workingDir: string }): ToolDefinition<typeof grepActionSchema, typeof grepObservationSchema> {
    const executor = new GrepExecutor(options);
    return new ToolDefinition({ name: 'grep', description: 'Search file contents recursively.', inputSchema: grepActionSchema, outputSchema: grepObservationSchema, annotations: toolAnnotationsSchema.parse({ title: 'grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
}

export const taskItemSchema = z.object({ title: z.string(), notes: z.string().default(''), status: z.enum(['todo', 'in_progress', 'done']).default('todo') }).strict();
export const taskTrackerActionSchema = z.object({ command: z.enum(['view', 'plan']).default('view'), task_list: z.array(taskItemSchema).default([]) }).strict();
export const taskTrackerObservationSchema = baseToolObservationSchema.extend({ command: z.enum(['view', 'plan']), task_list: z.array(taskItemSchema).default([]) }).strict();
export type TaskItem = z.infer<typeof taskItemSchema>;
export type TaskTrackerAction = z.infer<typeof taskTrackerActionSchema>;
export type TaskTrackerObservation = z.infer<typeof taskTrackerObservationSchema>;

export class TaskTrackerExecutor {
  private taskList: TaskItem[] = [];
  readonly saveDir: string | null;
  constructor(options: { readonly saveDir?: string | null } = {}) { this.saveDir = options.saveDir ?? null; }
  async execute(action: TaskTrackerAction): Promise<TaskTrackerObservation> {
    const parsed = taskTrackerActionSchema.parse(action);
    if (parsed.command === 'plan') {
      this.taskList = parsed.task_list;
      if (this.saveDir !== null) await this.saveTasks();
      return { text: `Task list has been updated with ${this.taskList.length} item(s).`, is_error: false, command: 'plan', task_list: this.taskList };
    }
    return { text: this.taskList.length === 0 ? 'No task list found. Use the "plan" command to create one.' : formatTasks(this.taskList), is_error: false, command: 'view', task_list: this.taskList };
  }
  private async saveTasks(): Promise<void> { if (this.saveDir === null) return; await mkdir(this.saveDir, { recursive: true }); await writeFile(join(this.saveDir, 'TASKS.md'), formatTasks(this.taskList)); }
}

export class TaskTrackerTool {
  static create(options: { readonly saveDir?: string | null } = {}): ToolDefinition<typeof taskTrackerActionSchema, typeof taskTrackerObservationSchema> {
    const executor = new TaskTrackerExecutor(options);
    return new ToolDefinition({ name: 'task_tracker', description: 'View or update a structured task list.', inputSchema: taskTrackerActionSchema, outputSchema: taskTrackerObservationSchema, annotations: toolAnnotationsSchema.parse({ title: 'task_tracker', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }), executor: (action) => executor.execute(action) });
  }
}

export const browserActionSchema = z.object({ command: z.enum(['navigate', 'get_state', 'click', 'type', 'scroll', 'back']), url: z.string().nullable().default(null), index: z.number().int().nullable().default(null), text: z.string().nullable().default(null), direction: z.enum(['up', 'down']).default('down') }).strict();
export const browserObservationSchema = baseToolObservationSchema;
export interface BrowserAdapter { navigate?(url: string): Promise<z.infer<typeof browserObservationSchema>>; getState?(): Promise<z.infer<typeof browserObservationSchema>>; click?(index: number): Promise<z.infer<typeof browserObservationSchema>>; type?(index: number, text: string): Promise<z.infer<typeof browserObservationSchema>>; scroll?(direction: 'up' | 'down'): Promise<z.infer<typeof browserObservationSchema>>; back?(): Promise<z.infer<typeof browserObservationSchema>>; }

export class BrowserTool {
  static create(options: { readonly adapter: BrowserAdapter }): ToolDefinition<typeof browserActionSchema, typeof browserObservationSchema> {
    return new ToolDefinition({ name: 'browser', description: 'Interact with a browser through an injected adapter.', inputSchema: browserActionSchema, outputSchema: browserObservationSchema, annotations: toolAnnotationsSchema.parse({ title: 'browser', destructiveHint: false, openWorldHint: true }), executor: async (action) => executeBrowserAction(options.adapter, action) });
  }
}

async function executeBrowserAction(adapter: BrowserAdapter, action: z.infer<typeof browserActionSchema>): Promise<z.infer<typeof browserObservationSchema>> {
  if (action.command === 'navigate' && action.url !== null && adapter.navigate) return adapter.navigate(action.url);
  if (action.command === 'get_state' && adapter.getState) return adapter.getState();
  if (action.command === 'click' && action.index !== null && adapter.click) return adapter.click(action.index);
  if (action.command === 'type' && action.index !== null && action.text !== null && adapter.type) return adapter.type(action.index, action.text);
  if (action.command === 'scroll' && adapter.scroll) return adapter.scroll(action.direction);
  if (action.command === 'back' && adapter.back) return adapter.back();
  return { text: `Browser adapter does not support command '${action.command}' or required arguments are missing.`, is_error: true };
}

async function exists(path: string): Promise<boolean> { return stat(path).then(() => true).catch(() => false); }
async function listDirectory(path: string): Promise<string[]> { const entries = await readdir(path, { withFileTypes: true }); return entries.filter((entry) => !entry.name.startsWith('.')).map((entry) => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}`).sort(); }
function numberLines(content: string, range: readonly number[] | null): string { const lines = content.replace(/\n$/u, '').split('\n'); const start = range?.[0] ?? 1; const end = range?.[1] === -1 ? lines.length : range?.[1] ?? lines.length; return lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n'); }
function normalizeTrailingNewline(content: string, oldContent: string): string { return oldContent.endsWith('\n') && !content.endsWith('\n') ? `${content}\n` : content; }
async function walkFiles(root: string): Promise<string[]> { const result: string[] = []; async function walk(dir: string): Promise<void> { for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) { if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue; const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if (entry.isFile()) result.push(path); } } await walk(root); return result.sort(); }
function globMatch(pattern: string, relativePath: string): boolean { const normalized = relativePath.split(sep).join(posix.sep); const escaped = pattern.split(/[\\/]/u).map((part) => part.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')).join('/'); return new RegExp(`(^|/)${escaped}$`, 'u').test(normalized); }
function formatTasks(tasks: readonly TaskItem[]): string { return `# Task List\n\n${tasks.map((task, index) => `${index + 1}. [${task.status}] ${task.title}${task.notes ? `\n   Notes: ${task.notes}` : ''}`).join('\n')}`; }

