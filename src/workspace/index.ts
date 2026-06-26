import { exec } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import { getChangesInRepo, getGitDiff, type GitChange, type GitDiff } from '../git/index.js';

const execAsync = promisify(exec);

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

export interface WorkspaceOptions extends LocalWorkspaceOptions {
  readonly host?: string | null;
}

export function workspace(options: WorkspaceOptions = {}): BaseWorkspace {
  if (options.host !== undefined && options.host !== null && options.host.length > 0) {
    throw new Error('Remote workspace is not implemented in the TypeScript package yet');
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
