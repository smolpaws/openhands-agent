import { exec } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep, posix } from 'node:path';
import { promisify } from 'node:util';

import { getChangesInRepo, getGitDiff, type GitChange, type GitDiff } from '../git/index.js';

const execAsync = promisify(exec);
type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]> & { readonly timeoutMs?: number };


export type TargetType = 'binary' | 'binary-minimal' | 'source' | 'source-minimal' | 'base-image-minimal' | 'base-image' | 'builder';
export type PlatformType = 'linux/amd64' | 'linux/arm64';
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

export interface WorkspaceCommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timeoutOccurred: boolean;
}

export interface FileOperationResult {
  readonly success: boolean;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly fileSize?: number;
  readonly error?: string;
}

export interface BaseWorkspace {
  readonly workingDir: string;
  executeCommand(command: string, options?: { readonly cwd?: string | null; readonly timeoutSeconds?: number }): Promise<WorkspaceCommandResult>;
  fileUpload(sourcePath: string, destinationPath: string): Promise<FileOperationResult>;
  fileDownload(sourcePath: string, destinationPath: string): Promise<FileOperationResult>;
  gitChanges(path: string): Promise<GitChange[]>;
  gitDiff(path: string): Promise<GitDiff>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export interface LocalWorkspaceOptions {
  readonly workingDir?: string;
  readonly working_dir?: string;
}

export class LocalWorkspace implements BaseWorkspace {
  readonly workingDir: string;

  constructor(options: LocalWorkspaceOptions = {}) {
    this.workingDir = resolve(options.workingDir ?? options.working_dir ?? 'workspace/project');
  }

  async executeCommand(command: string, options: { readonly cwd?: string | null; readonly timeoutSeconds?: number } = {}): Promise<WorkspaceCommandResult> {
    const cwd = options.cwd === undefined || options.cwd === null ? this.workingDir : this.resolvePath(options.cwd);
    const timeout = (options.timeoutSeconds ?? 30) * 1000;
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout });
      return { command, exitCode: 0, stdout, stderr, timeoutOccurred: false };
    } catch (error) {
      if (isExecError(error)) {
        return {
          command,
          exitCode: typeof error.code === 'number' ? error.code : -1,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? '',
          timeoutOccurred: error.killed === true || error.signal === 'SIGTERM',
        };
      }
      throw error;
    }
  }

  async fileUpload(sourcePath: string, destinationPath: string): Promise<FileOperationResult> {
    return this.copy(sourcePath, destinationPath);
  }

  async fileDownload(sourcePath: string, destinationPath: string): Promise<FileOperationResult> {
    return this.copy(sourcePath, destinationPath);
  }

  async gitChanges(path: string): Promise<GitChange[]> {
    return getChangesInRepo(this.resolvePath(path), 'HEAD');
  }

  async gitDiff(path: string): Promise<GitDiff> {
    return getGitDiff(this.resolvePath(path), 'HEAD');
  }

  async pause(): Promise<void> {
    return Promise.resolve();
  }

  async resume(): Promise<void> {
    return Promise.resolve();
  }

  private async copy(sourcePath: string, destinationPath: string): Promise<FileOperationResult> {
    const source = this.resolvePath(sourcePath);
    const destination = this.resolvePath(destinationPath);
    try {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      const info = await stat(destination);
      return { success: true, sourcePath: source, destinationPath: destination, fileSize: info.size };
    } catch (error) {
      return { success: false, sourcePath: source, destinationPath: destination, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolvePath(path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.workingDir, path);
  }
}

export interface RemoteWorkspaceOptions extends LocalWorkspaceOptions {
  readonly host: string;
  readonly apiKey?: string | null;
  readonly api_key?: string | null;
  readonly readTimeoutSeconds?: number;
  readonly read_timeout?: number;
}

export class RemoteWorkspace implements BaseWorkspace {
  readonly host: string;
  readonly apiKey: string | null;
  readonly workingDir: string;
  readonly readTimeoutSeconds: number;

  constructor(options: RemoteWorkspaceOptions) {
    this.host = options.host.replace(/\/+$/u, '');
    this.apiKey = options.apiKey ?? options.api_key ?? null;
    this.workingDir = remotePath(options.workingDir ?? options.working_dir ?? 'workspace/project');
    this.readTimeoutSeconds = options.readTimeoutSeconds ?? options.read_timeout ?? 600;
  }

  async alive(): Promise<boolean> {
    try {
      const response = await fetch(`${this.host}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getServerInfo(): Promise<Record<string, unknown>> {
    const response = await this.request('/server_info');
    const data = await response.json();
    return isRecord(data) ? data : {};
  }

  async executeCommand(command: string, options: { readonly cwd?: string | null; readonly timeoutSeconds?: number } = {}): Promise<WorkspaceCommandResult> {
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const payload: Record<string, unknown> = { command, timeout: Math.trunc(timeoutSeconds) };
    payload.cwd = options.cwd === undefined || options.cwd === null ? this.workingDir : joinRemotePath(this.workingDir, options.cwd);

    try {
      const start = await this.request('/api/bash/start_bash_command', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
        timeoutMs: (timeoutSeconds + 5) * 1000,
      });
      const started = (await start.json()) as { id?: string };
      if (started.id === undefined) {
        throw new Error('agent-server did not return a bash command id');
      }

      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];
      const seen = new Set<string>();
      let exitCode: number | null = null;
      let lastOrder = -1;
      const deadline = Date.now() + timeoutSeconds * 1000;

      while (Date.now() < deadline) {
        const params = new URLSearchParams({ command_id__eq: started.id, sort_order: 'TIMESTAMP', limit: '100', kind__eq: 'BashOutput' });
        if (lastOrder >= 0) {
          params.set('order__gt', String(lastOrder));
        }
        const response = await this.request(`/api/bash/bash_events/search?${params.toString()}`, { timeoutMs: this.readTimeoutSeconds * 1000 });
        const result = (await response.json()) as { items?: Array<Record<string, unknown>> };
        for (const event of result.items ?? []) {
          if (event.kind !== 'BashOutput') {
            continue;
          }
          if (typeof event.id === 'string') {
            if (seen.has(event.id)) {
              throw new Error(`Duplicate bash event received: ${event.id}`);
            }
            seen.add(event.id);
          }
          if (typeof event.order === 'number' && event.order > lastOrder) {
            lastOrder = event.order;
          }
          if (typeof event.stdout === 'string') {
            stdoutParts.push(event.stdout);
          }
          if (typeof event.stderr === 'string') {
            stderrParts.push(event.stderr);
          }
          if (typeof event.exit_code === 'number') {
            exitCode = event.exit_code;
          }
        }
        if (exitCode !== null) {
          break;
        }
        await delay(100);
      }

      if (exitCode === null) {
        exitCode = -1;
        stderrParts.push(`Command timed out after ${timeoutSeconds} seconds`);
      }
      const stderr = stderrParts.join('');
      return { command, exitCode, stdout: stdoutParts.join(''), stderr, timeoutOccurred: exitCode === -1 && stderr.includes('timed out') };
    } catch (error) {
      return { command, exitCode: -1, stdout: '', stderr: `Remote execution error: ${error instanceof Error ? error.message : String(error)}`, timeoutOccurred: false };
    }
  }

  async fileUpload(sourcePath: string, destinationPath: string): Promise<FileOperationResult> {
    const source = resolve(sourcePath);
    const destination = joinRemotePath(this.workingDir, destinationPath);
    try {
      const content = await readFile(source);
      const form = new FormData();
      form.set('file', new Blob([content]), source.split(/[\\/]/u).at(-1) ?? 'file');
      const params = new URLSearchParams({ path: destination });
      const response = await this.request(`/api/file/upload?${params.toString()}`, { method: 'POST', body: form, timeoutMs: 60_000 });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const result: FileOperationResult = { success: data.success !== false, sourcePath: source, destinationPath: destination, fileSize: typeof data.file_size === 'number' ? data.file_size : content.length };
      if (typeof data.error === 'string') {
        return { ...result, error: data.error };
      }
      return result;
    } catch (error) {
      return { success: false, sourcePath: source, destinationPath: destination, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async fileDownload(sourcePath: string, destinationPath: string): Promise<FileOperationResult> {
    const source = joinRemotePath(this.workingDir, sourcePath);
    const destination = resolve(destinationPath);
    try {
      const params = new URLSearchParams({ path: source });
      const response = await this.request(`/api/file/download?${params.toString()}`, { timeoutMs: 60_000 });
      const content = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
      return { success: true, sourcePath: source, destinationPath: destination, fileSize: content.length };
    } catch (error) {
      return { success: false, sourcePath: source, destinationPath: destination, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async gitChanges(path: string): Promise<GitChange[]> {
    const params = new URLSearchParams({ path: joinRemotePath(this.workingDir, path), ref: 'HEAD' });
    const response = await this.request(`/api/git/changes?${params.toString()}`, { timeoutMs: 60_000 });
    return ((await response.json()) as GitChange[]).sort((left, right) => left.path.localeCompare(right.path));
  }

  async gitDiff(path: string): Promise<GitDiff> {
    const params = new URLSearchParams({ path: joinRemotePath(this.workingDir, path), ref: 'HEAD' });
    const response = await this.request(`/api/git/diff?${params.toString()}`, { timeoutMs: 60_000 });
    return (await response.json()) as GitDiff;
  }

  async pause(): Promise<void> {
    return Promise.resolve();
  }

  async resume(): Promise<void> {
    return Promise.resolve();
  }

  private async request(path: string, init: FetchRequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.apiKey !== null) {
      headers.set('X-Session-API-Key', this.apiKey);
    }
    const response = await fetch(path.startsWith('http') ? path : `${this.host}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? this.readTimeoutSeconds * 1000),
    });
    if (!response.ok) {
      throw new Error(`agent-server request failed: ${response.status} ${response.statusText} ${await response.text().catch(() => '')}`.trim());
    }
    return response;
  }
}

export interface WorkspaceOptions extends LocalWorkspaceOptions {
  readonly host?: string | null;
  readonly apiKey?: string | null;
  readonly api_key?: string | null;
  readonly readTimeoutSeconds?: number;
  readonly read_timeout?: number;
}

export function workspace(options: WorkspaceOptions = {}): BaseWorkspace {
  if (options.host !== undefined && options.host !== null && options.host.length > 0) {
    return new RemoteWorkspace({ ...options, host: options.host });
  }
  return new LocalWorkspace(options);
}

export interface RepoSourceOptions {
  readonly url: string;
  readonly ref?: string | null;
  readonly provider?: GitProvider | null;
}

export class RepoSource {
  readonly url: string;
  readonly ref: string | null;
  readonly provider: GitProvider | null;

  constructor(options: string | RepoSourceOptions) {
    const source = typeof options === 'string' ? { url: options } : options;
    this.url = validateUrl(source.url);
    this.ref = source.ref ?? null;
    this.provider = source.provider ?? null;
    if (isShortUrlFormat(this.url) && this.provider === null) {
      throw new Error(`Short URL format '${this.url}' requires explicit provider field`);
    }
  }

  getProvider(): GitProvider {
    if (this.provider !== null) {
      return this.provider;
    }
    const detected = detectProviderFromUrl(this.url);
    if (detected !== null) {
      return detected;
    }
    throw new Error(`Cannot determine provider for URL: ${this.url}`);
  }

  getTokenName(): string {
    return providerTokenNames[this.getProvider()];
  }
}

export interface RepoMapping {
  readonly url: string;
  readonly dirName: string;
  readonly localPath: string;
  readonly ref?: string | null;
}

export interface CloneResult {
  readonly successCount: number;
  readonly failedRepos: readonly string[];
  readonly repoMappings: Readonly<Record<string, RepoMapping>>;
}

const providerTokenNames: Record<GitProvider, string> = {
  github: 'github_token',
  gitlab: 'gitlab_token',
  bitbucket: 'bitbucket_token',
};

const providerHosts: Record<GitProvider, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

const providerTokenFormat: Record<GitProvider, (token: string) => string> = {
  github: (token) => `${token}@`,
  gitlab: (token) => `oauth2:${token}@`,
  bitbucket: (token) => `x-token-auth:${token}@`,
};

export function buildCloneUrl(url: string, provider: GitProvider, token: string | null = null): string {
  const host = providerHosts[provider];
  const auth = token === null ? '' : providerTokenFormat[provider](token);
  if (isShortUrlFormat(url)) {
    return `https://${auth}${host}/${url}.git`;
  }
  if (token === null) {
    return url;
  }
  const parsed = new URL(url);
  if (parsed.protocol === 'https:' && parsed.host.toLowerCase() === host) {
    parsed.username = auth.endsWith('@') ? auth.slice(0, -1) : auth;
    return parsed.toString();
  }
  return url;
}

export function getReposContext(repoMappings: Readonly<Record<string, RepoMapping>>): string {
  const entries = Object.entries(repoMappings);
  if (entries.length === 0) {
    return '';
  }
  const lines = ['## Cloned Repositories', '', 'The following repositories have been cloned to your workspace:', ''];
  for (const [url, mapping] of entries) {
    const ref = mapping.ref === undefined || mapping.ref === null ? '' : ` (ref: ${mapping.ref})`;
    lines.push(`- \`${mapping.url || url}\`${ref} → \`${mapping.localPath}/\``);
  }
  lines.push('');
  return lines.join('\n');
}

function validateUrl(value: string): string {
  if (/^[\w-]+\/[\w.-]+$/u.test(value)) {
    return value;
  }
  const normalized = value.startsWith('http://') ? `https://${value.slice(7)}` : value;
  if (normalized.startsWith('https://') || normalized.startsWith('git@') || normalized.startsWith('file://')) {
    return normalized;
  }
  throw new Error("URL must be 'owner/repo' format or a valid git URL (https://, git@, or file://)");
}

function isShortUrlFormat(url: string): boolean {
  return !url.includes('://') && !url.startsWith('git@');
}

function detectProviderFromUrl(url: string): GitProvider | null {
  if (url.startsWith('git@')) {
    const host = url.split('@')[1]?.split(':')[0]?.toLowerCase();
    return providerFromHost(host ?? '');
  }
  try {
    return providerFromHost(new URL(url).host.toLowerCase());
  } catch {
    return null;
  }
}

function providerFromHost(host: string): GitProvider | null {
  for (const [provider, providerHost] of Object.entries(providerHosts) as [GitProvider, string][]) {
    if (host === providerHost) {
      return provider;
    }
  }
  return null;
}

function remotePath(path: string): string {
  return path.split(sep).join(posix.sep);
}

function joinRemotePath(base: string, path: string): string {
  const pathStr = remotePath(path);
  if (pathStr.startsWith('/') || /^[a-zA-Z]:\//u.test(pathStr)) {
    return pathStr;
  }
  const baseStr = remotePath(base);
  const prefix = baseStr.startsWith('/') ? '/' : '';
  const parts = [...baseStr.split('/'), ...pathStr.split('/')].filter((part) => part.length > 0 && part !== '.');
  return `${prefix}${parts.join('/')}`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ExecError {
  readonly code?: number | string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly killed?: boolean;
  readonly signal?: string | null;
}

function isExecError(error: unknown): error is ExecError {
  return typeof error === 'object' && error !== null && ('stdout' in error || 'stderr' in error || 'code' in error);
}
