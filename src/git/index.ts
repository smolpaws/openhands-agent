import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep, posix } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const GIT_EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MAX_FILE_SIZE_FOR_GIT_DIFF = 1024 * 1024;

export enum GitChangeStatus {
  MOVED = 'MOVED',
  ADDED = 'ADDED',
  DELETED = 'DELETED',
  UPDATED = 'UPDATED',
}

export interface GitChange {
  readonly status: `${GitChangeStatus}`;
  readonly path: string;
}

export interface GitDiff {
  readonly modified: string | null;
  readonly original: string | null;
}

export class GitError extends Error {}

export class GitRepositoryError extends GitError {
  constructor(message: string, readonly command: string | null = null, readonly exitCode: number | null = null) {
    super(message);
  }
}

export class GitCommandError extends GitError {
  constructor(message: string, readonly command: readonly string[], readonly exitCode: number, readonly stderr = '') {
    super(message);
  }
}

export class GitPathError extends GitError {}

export async function runGitCommand(args: readonly string[], options: { readonly cwd?: string | null; readonly timeoutSeconds?: number } = {}): Promise<string> {
  const redactedArgs = args.map(redactUrlCredentials);
  try {
    const { stdout } = await execFileAsync(args[0] ?? 'git', args.slice(1), { cwd: options.cwd ?? undefined, timeout: (options.timeoutSeconds ?? 30) * 1000 });
    return stdout.trim();
  } catch (error) {
    if (isExecError(error)) {
      throw new GitCommandError(`Git command failed: ${redactedArgs.join(' ')}`, redactedArgs, typeof error.code === 'number' ? error.code : -1, redactUrlCredentialsInText(error.stderr ?? '').trim());
    }
    throw error;
  }
}

export async function validateGitRepository(repoDir: string): Promise<string> {
  const repoPath = resolve(repoDir);
  const info = await stat(repoPath).catch(() => null);
  if (info === null) {
    throw new GitRepositoryError(`Directory does not exist: ${repoPath}`);
  }
  if (!info.isDirectory()) {
    throw new GitRepositoryError(`Path is not a directory: ${repoPath}`);
  }
  try {
    await runGitCommand(['git', 'rev-parse', '--git-dir'], { cwd: repoPath });
  } catch (error) {
    throw new GitRepositoryError(`Not a git repository: ${repoPath}`, 'git rev-parse --git-dir', error instanceof GitCommandError ? error.exitCode : null);
  }
  return repoPath;
}

export async function getValidRef(repoDir: string, override?: string | null): Promise<string> {
  if (override !== undefined && override !== null) {
    try {
      return await runGitCommand(['git', '--no-pager', 'rev-parse', '--verify', `${override}^{commit}`], { cwd: repoDir });
    } catch (error) {
      if (override === 'HEAD') {
        return GIT_EMPTY_TREE_HASH;
      }
      throw error;
    }
  }
  if (!(await repoHasCommits(repoDir))) {
    return GIT_EMPTY_TREE_HASH;
  }
  return GIT_EMPTY_TREE_HASH;
}

export async function getChangesInRepo(repoDir: string, ref?: string | null): Promise<GitChange[]> {
  const repo = await validateGitRepository(repoDir);
  const base = await getValidRef(repo, ref);
  const output = await runGitCommand(['git', '--no-pager', 'diff', '--name-status', base], { cwd: repo });
  const changes: GitChange[] = [];
  for (const line of output.split(/\r?\n/u).filter((entry) => entry.trim().length > 0)) {
    const parts = line.split(/\s+/u);
    const status = parts[0] ?? '';
    if (status.startsWith('R') && parts.length === 3) {
      changes.push({ status: GitChangeStatus.DELETED, path: toPosixPath(parts[1] ?? '') }, { status: GitChangeStatus.ADDED, path: toPosixPath(parts[2] ?? '') });
    } else if (status.startsWith('C') && parts.length === 3) {
      changes.push({ status: GitChangeStatus.ADDED, path: toPosixPath(parts[2] ?? '') });
    } else if (parts.length === 2) {
      changes.push({ status: mapGitStatus(status), path: toPosixPath(parts[1] ?? '') });
    } else {
      throw new GitCommandError(`Unexpected git diff output format: ${line}`, ['git', 'diff', '--name-status'], 0, 'Invalid output format');
    }
  }
  const untracked = await runGitCommand(['git', '--no-pager', 'ls-files', '--others', '--exclude-standard'], { cwd: repo }).catch(() => '');
  for (const path of untracked.split(/\r?\n/u).filter((entry) => entry.trim().length > 0)) {
    changes.push({ status: GitChangeStatus.ADDED, path: toPosixPath(path.trim()) });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function getClosestGitRepo(path: string): Promise<string | null> {
  let current = resolve(path);
  if ((await stat(current).catch(() => null))?.isFile()) {
    current = dirname(current);
  }
  while (true) {
    if (await exists(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function getGitDiff(filePath: string, ref?: string | null): Promise<GitDiff> {
  const path = resolve(filePath);
  const info = await stat(path).catch(() => null);
  if (info === null) {
    throw new GitPathError(`File does not exist: ${path}`);
  }
  if (info.size > MAX_FILE_SIZE_FOR_GIT_DIFF) {
    throw new GitPathError(`File too large for git diff: ${info.size} bytes (max: ${MAX_FILE_SIZE_FOR_GIT_DIFF} bytes)`);
  }
  const repo = await getClosestGitRepo(path);
  if (repo === null) {
    throw new GitRepositoryError(`File is not in a git repository: ${path}`);
  }
  const validRepo = await validateGitRepository(repo);
  const base = await getValidRef(validRepo, ref);
  const relative = toPosixPath(path.slice(validRepo.length + 1));
  const original = await runGitCommand(['git', 'show', `${base}:${relative}`], { cwd: validRepo }).catch(() => '');
  const modified = (await readFile(path, 'utf8')).split(/\r?\n/u).join('\n').replace(/\n$/u, '');
  return { modified, original };
}

export function isGitUrl(source: string): boolean {
  return source.startsWith('https://') || source.startsWith('http://') || source.startsWith('git://') || source.startsWith('file://') || /^[\w.-]+@[\w.-]+:/u.test(source);
}

export function normalizeGitUrl(url: string): string {
  if ((url.startsWith('https://') || url.startsWith('http://')) && !url.endsWith('.git')) {
    return `${url.replace(/\/+$/u, '')}.git`;
  }
  return url;
}

export function extractRepoName(source: string): string {
  let name = source;
  for (const prefix of ['github:', 'https://', 'http://', 'git://', 'file://']) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  if (name.includes('@') && name.includes(':') && !(name.split(':')[0] ?? '').includes('/')) {
    name = name.split(':', 2)[1] ?? name;
  }
  name = (name.replace(/\/+$/u, '').replace(/\.git$/u, '').split('/').at(-1) ?? '').replace(/[^a-zA-Z0-9_-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
  return (name || 'repo').slice(0, 32);
}

function mapGitStatus(status: string): `${GitChangeStatus}` {
  if (status === 'M' || status === '*' || status === 'U') {
    return GitChangeStatus.UPDATED;
  }
  if (status === 'A' || status === '??') {
    return GitChangeStatus.ADDED;
  }
  if (status === 'D') {
    return GitChangeStatus.DELETED;
  }
  throw new GitCommandError(`Unexpected git status: ${status}`, ['git', 'diff', '--name-status'], 0, `Unexpected status code: ${status}`);
}

async function repoHasCommits(repoDir: string): Promise<boolean> {
  try {
    return (await runGitCommand(['git', '--no-pager', 'rev-list', '--count', '--all'], { cwd: repoDir })) !== '0';
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join(posix.sep);
}

function redactUrlCredentials(value: string): string {
  return value.replace(/(https?:\/\/)[^/@\s]+@/giu, '$1<redacted>@');
}

function redactUrlCredentialsInText(value: string): string {
  return value.split(/\s+/u).map(redactUrlCredentials).join(' ');
}

function isExecError(error: unknown): error is { code?: number | string; stderr?: string } {
  return typeof error === 'object' && error !== null && 'stderr' in error;
}
