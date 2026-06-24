import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

export enum HookEventType {
  PreToolUse = 'PreToolUse',
  PostToolUse = 'PostToolUse',
  UserPromptSubmit = 'UserPromptSubmit',
  SessionStart = 'SessionStart',
  SessionEnd = 'SessionEnd',
  Stop = 'Stop',
}

export enum HookDecision {
  Allow = 'allow',
  Deny = 'deny',
}

export enum HookType {
  Command = 'command',
  Prompt = 'prompt',
  Agent = 'agent',
}

const hookEventFieldNames = ['pre_tool_use', 'post_tool_use', 'user_prompt_submit', 'session_start', 'session_end', 'stop'] as const;
export type HookEventFieldName = (typeof hookEventFieldNames)[number];

const recordSchema = z.record(z.string(), z.unknown());

export const hookEventSchema = z.object({
  event_type: z.nativeEnum(HookEventType),
  tool_name: z.string().nullable().default(null),
  tool_input: recordSchema.nullable().default(null),
  tool_response: recordSchema.nullable().default(null),
  message: z.string().nullable().default(null),
  session_id: z.string().nullable().default(null),
  working_dir: z.string().nullable().default(null),
  metadata: recordSchema.default({}),
}).strict();

export type HookEvent = z.infer<typeof hookEventSchema>;

export interface HookDefinitionOptions {
  readonly type?: HookType | `${HookType}`;
  readonly name?: string | null;
  readonly command?: string;
  readonly prompt?: string | null;
  readonly system_prompt?: string | null;
  readonly tools?: readonly string[];
  readonly timeout?: number;
  readonly max_iterations?: number;
  readonly async?: boolean;
  readonly async_?: boolean;
}

export class HookDefinition {
  readonly type: HookType;
  readonly name: string | null;
  readonly command: string;
  readonly prompt: string | null;
  readonly system_prompt: string | null;
  readonly tools: string[];
  readonly timeout: number;
  readonly max_iterations: number;
  readonly async_: boolean;

  constructor(options: HookDefinitionOptions) {
    this.type = hookType(options.type ?? HookType.Command);
    this.name = options.name ?? null;
    this.command = options.command ?? '';
    this.prompt = options.prompt ?? null;
    this.system_prompt = options.system_prompt ?? null;
    this.tools = [...(options.tools ?? [])];
    this.timeout = options.timeout ?? 60;
    this.max_iterations = options.max_iterations ?? 3;
    this.async_ = options.async_ ?? options.async ?? false;
    this.validate();
  }

  get displayCommand(): string {
    if (this.command.length > 0) {
      return this.command;
    }
    if (this.name !== null) {
      return `agent-hook:${this.name}`;
    }
    if (this.system_prompt !== null && this.system_prompt.length > 0) {
      return `agent-hook:${this.system_prompt.slice(0, 20)}`;
    }
    return 'agent-hook:agent';
  }

  toJSON(): Record<string, unknown> {
    return { type: this.type, name: this.name, command: this.command, prompt: this.prompt, system_prompt: this.system_prompt, tools: this.tools, timeout: this.timeout, max_iterations: this.max_iterations, async: this.async_ };
  }

  private validate(): void {
    if (this.type === HookType.Command && this.command.length === 0) {
      throw new Error("'command' is required when type is 'command'");
    }
    if (this.type === HookType.Prompt && this.prompt === null) {
      throw new Error("'prompt' is required when type is 'prompt'");
    }
    if (this.type === HookType.Agent && this.command.length > 0) {
      throw new Error("'command' must not be set when type is 'agent'; use 'system_prompt' instead");
    }
    if (this.type === HookType.Agent && this.async_) {
      throw new Error("'async' is not supported for agent hooks");
    }
  }
}

export interface HookMatcherOptions {
  readonly matcher?: string;
  readonly hooks?: readonly (HookDefinition | HookDefinitionOptions)[];
}

export class HookMatcher {
  readonly matcher: string;
  readonly hooks: HookDefinition[];

  constructor(options: HookMatcherOptions = {}) {
    this.matcher = options.matcher ?? '*';
    this.hooks = [...(options.hooks ?? [])].map((hook) => hook instanceof HookDefinition ? hook : new HookDefinition(hook));
  }

  matches(toolName: string | null | undefined): boolean {
    if (this.matcher === '*' || this.matcher === '') {
      return true;
    }
    if (toolName === null || toolName === undefined) {
      return false;
    }
    if (this.matcher.startsWith('/') && this.matcher.endsWith('/') && this.matcher.length > 2) {
      return safeFullMatch(this.matcher.slice(1, -1), toolName) ?? false;
    }
    if (hasRegexMetacharacter(this.matcher)) {
      const matched = safeFullMatch(this.matcher, toolName);
      if (matched !== null) {
        return matched;
      }
    }
    return this.matcher === toolName;
  }

  toJSON(): Record<string, unknown> {
    return { matcher: this.matcher, hooks: this.hooks.map((hook) => hook.toJSON()) };
  }
}

export type HookConfigInput = Partial<Record<HookEventFieldName | HookEventType, readonly HookMatcherOptions[]>> & { readonly hooks?: Record<string, readonly HookMatcherOptions[]> };

export class HookConfig {
  readonly pre_tool_use: HookMatcher[];
  readonly post_tool_use: HookMatcher[];
  readonly user_prompt_submit: HookMatcher[];
  readonly session_start: HookMatcher[];
  readonly session_end: HookMatcher[];
  readonly stop: HookMatcher[];

  constructor(input: HookConfigInput = {}) {
    const normalized = normalizeHookConfigInput(input);
    this.pre_tool_use = matchersFor(normalized.pre_tool_use);
    this.post_tool_use = matchersFor(normalized.post_tool_use);
    this.user_prompt_submit = matchersFor(normalized.user_prompt_submit);
    this.session_start = matchersFor(normalized.session_start);
    this.session_end = matchersFor(normalized.session_end);
    this.stop = matchersFor(normalized.stop);
  }

  static fromObject(input: HookConfigInput): HookConfig {
    return new HookConfig(input);
  }

  static async load(options: { readonly path?: string | null; readonly workingDir?: string | null } = {}): Promise<HookConfig> {
    let path = options.path ?? null;
    if (path === null) {
      const base = options.workingDir ?? process.cwd();
      for (const candidate of [join(base, '.openhands', 'hooks.json'), join(homedir(), '.openhands', 'hooks.json')]) {
        if (await existsFile(candidate)) {
          path = candidate;
          break;
        }
      }
    }
    if (path === null || !(await existsFile(path))) {
      return new HookConfig();
    }
    return new HookConfig(JSON.parse(await readFile(path, 'utf8')) as HookConfigInput);
  }

  isEmpty(): boolean {
    return hookEventFieldNames.every((field) => this[field].length === 0);
  }

  getHooksForEvent(eventType: HookEventType, toolName?: string | null): HookDefinition[] {
    return this.matchersForEvent(eventType).flatMap((matcher) => matcher.matches(toolName) ? matcher.hooks : []);
  }

  hasHooksForEvent(eventType: HookEventType): boolean {
    return this.matchersForEvent(eventType).length > 0;
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.toJSON(), null, 2));
  }

  toJSON(): Record<HookEventFieldName, unknown> {
    return Object.fromEntries(hookEventFieldNames.map((field) => [field, this[field].map((matcher) => matcher.toJSON())])) as Record<HookEventFieldName, unknown>;
  }

  static merge(configs: readonly HookConfig[]): HookConfig | null {
    if (configs.length === 0) {
      return null;
    }
    const merged = new HookConfig(Object.fromEntries(hookEventFieldNames.map((field) => [field, configs.flatMap((config) => config[field])])));
    return merged.isEmpty() ? null : merged;
  }

  private matchersForEvent(eventType: HookEventType): HookMatcher[] {
    return this[eventTypeToFieldName(eventType)];
  }
}

export class HookResult {
  readonly success: boolean;
  readonly blocked: boolean;
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly decision: HookDecision | null;
  readonly reason: string | null;
  readonly additionalContext: string | null;
  readonly error: string | null;
  readonly asyncStarted: boolean;

  constructor(options: { readonly success?: boolean; readonly blocked?: boolean; readonly exit_code?: number; readonly stdout?: string; readonly stderr?: string; readonly decision?: HookDecision | null; readonly reason?: string | null; readonly additionalContext?: string | null; readonly error?: string | null; readonly asyncStarted?: boolean } = {}) {
    this.success = options.success ?? true;
    this.blocked = options.blocked ?? false;
    this.exit_code = options.exit_code ?? 0;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.decision = options.decision ?? null;
    this.reason = options.reason ?? null;
    this.additionalContext = options.additionalContext ?? null;
    this.error = options.error ?? null;
    this.asyncStarted = options.asyncStarted ?? false;
  }

  get shouldContinue(): boolean {
    return !this.blocked && this.decision !== HookDecision.Deny;
  }
}

export class AsyncProcessManager {
  private readonly processes: { readonly process: ChildProcess; readonly startedAt: number; readonly timeoutMs: number }[] = [];

  addProcess(process: ChildProcess, timeoutSeconds: number): void {
    this.processes.push({ process, startedAt: Date.now(), timeoutMs: timeoutSeconds * 1000 });
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (let index = this.processes.length - 1; index >= 0; index -= 1) {
      const tracked = this.processes[index];
      if (tracked === undefined) {
        continue;
      }
      if (tracked.process.exitCode !== null || tracked.process.killed) {
        this.processes.splice(index, 1);
      } else if (now - tracked.startedAt > tracked.timeoutMs) {
        tracked.process.kill('SIGTERM');
        this.processes.splice(index, 1);
      }
    }
  }

  cleanupAll(): void {
    for (const tracked of this.processes) {
      if (tracked.process.exitCode === null && !tracked.process.killed) {
        tracked.process.kill('SIGTERM');
      }
    }
    this.processes.length = 0;
  }
}

export class HookExecutor {
  readonly workingDir: string;
  readonly asyncProcessManager: AsyncProcessManager;

  constructor(options: { readonly workingDir?: string | null; readonly asyncProcessManager?: AsyncProcessManager | null } = {}) {
    this.workingDir = options.workingDir ?? process.cwd();
    this.asyncProcessManager = options.asyncProcessManager ?? new AsyncProcessManager();
  }

  async execute(hook: HookDefinition, event: HookEvent, env?: Record<string, string>): Promise<HookResult> {
    if (hook.type !== HookType.Command) {
      return new HookResult({ success: false, decision: HookDecision.Allow, reason: `${hook.type} hooks are not implemented`, error: `${hook.type} hooks are not implemented` });
    }
    this.asyncProcessManager.cleanupExpired();
    const hookEnv = { ...process.env, OPENHANDS_PROJECT_DIR: this.workingDir, OPENHANDS_SESSION_ID: event.session_id ?? '', OPENHANDS_EVENT_TYPE: event.event_type, ...(event.tool_name === null ? {} : { OPENHANDS_TOOL_NAME: event.tool_name }), ...env };
    const eventJson = JSON.stringify(event);
    if (hook.async_) {
      return this.executeAsyncCommand(hook, eventJson, hookEnv);
    }
    return this.executeCommand(hook, eventJson, hookEnv);
  }

  async executeAll(hooks: readonly HookDefinition[], event: HookEvent, env?: Record<string, string>, stopOnBlock = true): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const hook of hooks) {
      const result = await this.execute(hook, event, env);
      results.push(result);
      if (stopOnBlock && result.blocked) {
        break;
      }
    }
    return results;
  }

  private executeAsyncCommand(hook: HookDefinition, eventJson: string, env: Record<string, string | undefined>): HookResult {
    try {
      const child = spawn(hook.command, { shell: true, cwd: this.workingDir, env, stdio: ['pipe', 'ignore', 'ignore'], detached: process.platform !== 'win32' });
      child.stdin.write(eventJson);
      child.stdin.end();
      this.asyncProcessManager.addProcess(child, hook.timeout);
      return new HookResult({ success: true, exit_code: 0, asyncStarted: true });
    } catch (error) {
      return new HookResult({ success: false, exit_code: -1, error: `Failed to start async hook: ${String(error)}` });
    }
  }

  private executeCommand(hook: HookDefinition, eventJson: string, env: Record<string, string | undefined>): Promise<HookResult> {
    return new Promise((resolve) => {
      const child = spawn(hook.command, { shell: true, cwd: this.workingDir, env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        resolve(new HookResult({ success: false, exit_code: -1, error: `Hook timed out after ${hook.timeout} seconds` }));
      }, hook.timeout * 1000);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        clearTimeout(timeout);
        resolve(new HookResult({ success: false, exit_code: -1, error: `Hook execution failed: ${error.message}` }));
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve(parseCommandResult(code ?? -1, Buffer.concat(stdout).toString('utf8'), Buffer.concat(stderr).toString('utf8')));
      });
      child.stdin.write(eventJson);
      child.stdin.end();
    });
  }
}

export class HookManager {
  readonly config: HookConfig;
  readonly executor: HookExecutor;
  readonly sessionId: string | null;
  readonly workingDir: string | null;

  constructor(options: { readonly config?: HookConfig | null; readonly workingDir?: string | null; readonly sessionId?: string | null; readonly executor?: HookExecutor | null } = {}) {
    this.config = options.config ?? new HookConfig();
    this.workingDir = options.workingDir ?? null;
    this.sessionId = options.sessionId ?? null;
    this.executor = options.executor ?? new HookExecutor({ workingDir: this.workingDir });
  }

  async runPreToolUse(toolName: string, toolInput: Record<string, unknown>): Promise<{ shouldContinue: boolean; results: HookResult[] }> {
    const results = await this.executor.executeAll(this.config.getHooksForEvent(HookEventType.PreToolUse, toolName), this.event(HookEventType.PreToolUse, { tool_name: toolName, tool_input: toolInput }), undefined, true);
    return { shouldContinue: results.every((result) => result.shouldContinue), results };
  }

  async runPostToolUse(toolName: string, toolInput: Record<string, unknown>, toolResponse: Record<string, unknown>): Promise<HookResult[]> {
    return this.executor.executeAll(this.config.getHooksForEvent(HookEventType.PostToolUse, toolName), this.event(HookEventType.PostToolUse, { tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }), undefined, false);
  }

  async runUserPromptSubmit(message: string): Promise<{ shouldContinue: boolean; additionalContext: string | null; results: HookResult[] }> {
    const results = await this.executor.executeAll(this.config.getHooksForEvent(HookEventType.UserPromptSubmit), this.event(HookEventType.UserPromptSubmit, { message }), undefined, true);
    const context = results.map((result) => result.additionalContext).filter((value): value is string => value !== null && value.length > 0).join('\n');
    return { shouldContinue: results.every((result) => result.shouldContinue), additionalContext: context.length > 0 ? context : null, results };
  }

  async runStop(reason?: string | null): Promise<{ shouldStop: boolean; results: HookResult[] }> {
    const results = await this.executor.executeAll(this.config.getHooksForEvent(HookEventType.Stop), this.event(HookEventType.Stop, { metadata: reason ? { reason } : {} }), undefined, true);
    return { shouldStop: results.every((result) => result.shouldContinue), results };
  }

  hasHooks(eventType: HookEventType): boolean {
    return this.config.hasHooksForEvent(eventType);
  }

  getBlockingReason(results: readonly HookResult[]): string | null {
    for (const result of results) {
      if (result.blocked) {
        return result.reason ?? (result.stderr.trim().length > 0 ? result.stderr.trim() : 'Blocked by hook');
      }
    }
    return null;
  }

  cleanupAsyncProcesses(): void {
    this.executor.asyncProcessManager.cleanupAll();
  }

  private event(event_type: HookEventType, overrides: Partial<HookEvent> = {}): HookEvent {
    return hookEventSchema.parse({ event_type, session_id: this.sessionId, working_dir: this.workingDir, ...overrides });
  }
}

function parseCommandResult(exitCode: number, stdout: string, stderr: string): HookResult {
  const parsed = parseHookStdout(stdout);
  return new HookResult({
    success: exitCode === 0,
    blocked: exitCode === 2 || parsed.blocked,
    exit_code: exitCode,
    stdout,
    stderr,
    decision: parsed.decision,
    reason: parsed.reason,
    additionalContext: parsed.additionalContext,
  });
}

function parseHookStdout(stdout: string): { decision: HookDecision | null; reason: string | null; additionalContext: string | null; blocked: boolean } {
  if (stdout.trim().length === 0) {
    return { decision: null, reason: null, additionalContext: null, blocked: false };
  }
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed)) {
      return { decision: null, reason: null, additionalContext: null, blocked: false };
    }
    const decision = parsed.decision === HookDecision.Allow ? HookDecision.Allow : parsed.decision === HookDecision.Deny ? HookDecision.Deny : null;
    return {
      decision,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      additionalContext: typeof parsed.additionalContext === 'string' ? parsed.additionalContext : null,
      blocked: decision === HookDecision.Deny || parsed.continue === false,
    };
  } catch {
    return { decision: null, reason: null, additionalContext: null, blocked: false };
  }
}

function normalizeHookConfigInput(input: HookConfigInput): Partial<Record<HookEventFieldName, readonly HookMatcherOptions[]>> {
  const raw = input.hooks === undefined ? input : input.hooks;
  const normalized: Partial<Record<HookEventFieldName, readonly HookMatcherOptions[]>> = {};
  const seen = new Set<HookEventFieldName>();
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'hooks') {
      continue;
    }
    const field = hookKeyToFieldName(key);
    if (seen.has(field)) {
      throw new Error(`Duplicate hook event: both '${key}' and its snake_case equivalent '${field}' were provided`);
    }
    seen.add(field);
    normalized[field] = value as readonly HookMatcherOptions[];
  }
  return normalized;
}

function hookKeyToFieldName(key: string): HookEventFieldName {
  const candidate = key.includes('_') ? key : pascalToSnake(key);
  if ((hookEventFieldNames as readonly string[]).includes(candidate)) {
    return candidate as HookEventFieldName;
  }
  throw new Error(`Unknown event type '${key}'. Valid types: ${hookEventFieldNames.join(', ')}`);
}

function eventTypeToFieldName(eventType: HookEventType): HookEventFieldName {
  return hookKeyToFieldName(eventType);
}

function pascalToSnake(name: string): string {
  let output = '';
  for (const character of name) {
    const code = character.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    output += isUpper && output.length > 0 ? `_${character.toLowerCase()}` : character.toLowerCase();
  }
  return output;
}

function matchersFor(input: readonly HookMatcherOptions[] | undefined): HookMatcher[] {
  return [...(input ?? [])].map((matcher) => matcher instanceof HookMatcher ? matcher : new HookMatcher(matcher));
}

function hookType(value: HookType | `${HookType}`): HookType {
  if (value === HookType.Command || value === HookType.Prompt || value === HookType.Agent) {
    return value as HookType;
  }
  throw new Error(`Unknown hook type: ${String(value)}`);
}

function hasRegexMetacharacter(value: string): boolean {
  for (const character of value) {
    if ('|.*+?[]()^$'.includes(character)) {
      return true;
    }
  }
  return false;
}

function safeFullMatch(pattern: string, value: string): boolean | null {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(value);
  } catch {
    return null;
  }
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}






