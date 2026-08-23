import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep, posix } from 'node:path';
import { promisify } from 'node:util';

import { redactUrlParams, redactUrlCredentialsInText as redactUrlCredentialsInTextUtil } from '../utils/index.js';

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

export interface GitCommit {
  readonly sha: string;
  readonly short_sha: string;
  readonly subject: string;
  readonly author: string;
  readonly timestamp: string;
}

export interface GitCommitsPage {
  readonly commits: readonly GitCommit[];
  readonly has_more: boolean;
}

export interface GitRepositoryMetadata {
  readonly repo_remote?: string;
  readonly head_commit?: string;
  readonly branch?: string;
}

export type GitRefPurpose = 'export' | 'display';

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

export async function getValidRef(repoDir: string, override?: string | null, purpose: GitRefPurpose = 'export'): Promise<string> {
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
  if (purpose === 'display') {
    return getDisplayBaseRef(repoDir);
  }
  return GIT_EMPTY_TREE_HASH;
}

export async function getDisplayBaseRef(repoDir: string): Promise<string> {
  const head = await revParse(repoDir, 'HEAD');
  const currentBranch = await getCurrentBranch(repoDir);

  if (currentBranch !== null) {
    const upstreamSha = await revParse(repoDir, `origin/${currentBranch}`);
    if (upstreamSha !== null) {
      if (upstreamSha === head && !(await hasTrackedChanges(repoDir))) {
        // origin/<branch> points at HEAD with a clean tree: comparing a
        // fully-pushed branch against its own upstream would render an empty
        // diff and hide the branch's work.
      } else {
        return upstreamSha;
      }
    }
  }

  const defaultBranch = await getRemoteDefaultBranch(repoDir);
  if (defaultBranch !== null) {
    const forkPoint = await mergeBase(repoDir, 'HEAD', `origin/${defaultBranch}`);
    if (forkPoint !== null) {
      return forkPoint;
    }
    const defaultSha = await revParse(repoDir, `origin/${defaultBranch}`);
    if (defaultSha !== null) {
      return defaultSha;
    }
  } else {
    for (const localDefault of ['main', 'master']) {
      const localDefaultSha = await revParse(repoDir, localDefault);
      if (localDefaultSha === null) {
        continue;
      }
      if (localDefault === currentBranch) {
        break;
      }
      const base = await mergeBase(repoDir, 'HEAD', localDefault);
      if (base !== null && base === localDefaultSha) {
        return base;
      }
      break;
    }
  }

  if (head !== null) {
    return head;
  }
  return GIT_EMPTY_TREE_HASH;
}

async function revParse(repoDir: string, ref: string): Promise<string | null> {
  try {
    const result = await runGitCommand(['git', '--no-pager', 'rev-parse', '--verify', ref], { cwd: repoDir });
    return result || null;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return null;
    }
    throw error;
  }
}

async function mergeBase(repoDir: string, refA: string, refB: string): Promise<string | null> {
  try {
    const result = await runGitCommand(['git', '--no-pager', 'merge-base', refA, refB], { cwd: repoDir });
    return result || null;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return null;
    }
    throw error;
  }
}

async function getCurrentBranch(repoDir: string): Promise<string | null> {
  try {
    const branch = await runGitCommand(['git', '--no-pager', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir });
    if (branch && branch !== 'HEAD') {
      return branch;
    }
  } catch (error) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
  }
  return null;
}

async function getRemoteDefaultBranch(repoDir: string): Promise<string | null> {
  try {
    const symref = await runGitCommand(['git', '--no-pager', 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: repoDir });
    if (symref.startsWith('origin/') && symref.length > 'origin/'.length) {
      return symref.slice('origin/'.length);
    }
  } catch (error) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
  }

  try {
    const remoteInfo = await runGitCommand(['git', '--no-pager', 'remote', 'show', 'origin'], { cwd: repoDir });
    for (const line of remoteInfo.split(/\r?\n/u)) {
      if (line.includes('HEAD branch:')) {
        const defaultBranch = line.split(':').at(-1)?.trim() ?? '';
        if (defaultBranch && defaultBranch !== '(unknown)') {
          return defaultBranch;
        }
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
  }
  return null;
}

async function hasTrackedChanges(repoDir: string): Promise<boolean> {
  try {
    const status = await runGitCommand(['git', '--no-pager', 'status', '--porcelain', '--untracked-files=no'], { cwd: repoDir });
    return status.trim().length > 0;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return true;
    }
    throw error;
  }
}

export async function getGitRepositoryMetadata(repoDir: string): Promise<GitRepositoryMetadata> {
  const metadata: { repo_remote?: string; head_commit?: string; branch?: string } = {};
  const remote = await runGitProbe(['remote', 'get-url', 'origin'], repoDir);
  if (remote !== null) {
    metadata.repo_remote = redactUrlParams(redactUrlCredentialsInTextUtil(remote));
  }

  const headAndBranch = await runGitProbe(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], repoDir);
  if (headAndBranch !== null) {
    const lines = headAndBranch.split(/\r?\n/u);
    if (lines.length === 2) {
      const head = lines[0] ?? '';
      const branch = lines[1] ?? '';
      metadata.head_commit = head;
      metadata.branch = branch === 'HEAD' ? 'DETACHED' : branch;
    }
  }
  return metadata;
}

async function runGitProbe(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const result = await runGitCommand(['git', '--no-pager', ...args], { cwd, timeoutSeconds: 30 });
    return result === '' ? null : result;
  } catch (error) {
    if (error instanceof GitCommandError) {
      return null;
    }
    throw error;
  }
}

export async function getChangesInRepo(repoDir: string, ref?: string | null): Promise<GitChange[]> {
  const repo = await validateGitRepository(repoDir);
  const base = await getValidRef(repo, ref, 'display');
  const output = await runGitCommand(['git', '--no-pager', 'diff', '--name-status', base], { cwd: repo });
  const changes = parseNameStatus(output.split(/\r?\n/u).filter((entry) => entry.trim().length > 0));
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
  const base = await getValidRef(validRepo, ref, 'display');
  const relative = toPosixPath(path.slice(validRepo.length + 1));
  const original = await runGitCommand(['git', 'show', `${base}:${relative}`], { cwd: validRepo }).catch(() => '');
  const modified = (await readFile(path, 'utf8')).split(/\r?\n/u).join('\n').replace(/\n$/u, '');
  return { modified, original };
}

const DEFAULT_COMMIT_LIMIT = 50;
const LOG_FORMAT = '%H\x1f%h\x1f%an\x1f%aI\x1f%s';

export async function getGitCommits(repoPath: string, limit = DEFAULT_COMMIT_LIMIT): Promise<GitCommitsPage> {
  const validatedRepo = await validateGitRepository(repoPath);

  const head = await revParse(validatedRepo, 'HEAD');
  if (head === null) {
    return { commits: [], has_more: false };
  }

  let output: string;
  try {
    output = await runGitCommand(
      ['git', '--no-pager', 'log', '--no-show-signature', `--format=${LOG_FORMAT}`, '-n', String(limit + 1), head],
      { cwd: validatedRepo },
    );
  } catch (error) {
    if (error instanceof GitCommandError) {
      return { commits: [], has_more: false };
    }
    throw error;
  }

  const commits: GitCommit[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) {
      continue;
    }
    const fields = line.split('\x1f');
    if (fields.length !== 5) {
      continue;
    }
    const sha = fields[0] ?? '';
    const shortSha = fields[1] ?? '';
    const author = fields[2] ?? '';
    const timestamp = fields[3] ?? '';
    const subject = fields[4] ?? '';
    commits.push({ sha, short_sha: shortSha, subject, author, timestamp });
  }

  return { commits: commits.slice(0, limit), has_more: commits.length > limit };
}

async function resolveCommit(repoDir: string, commit: string): Promise<string> {
  return runGitCommand(['git', '--no-pager', 'rev-parse', '--verify', `${commit}^{commit}`], { cwd: repoDir });
}

export async function getCommitChanges(repoDir: string, commit: string): Promise<GitChange[]> {
  const validatedRepo = await validateGitRepository(repoDir);
  const sha = await resolveCommit(validatedRepo, commit);
  const parent = (await revParse(validatedRepo, `${sha}^`)) ?? GIT_EMPTY_TREE_HASH;

  const output = await runGitCommand(['git', '--no-pager', 'diff', '--name-status', parent, sha], { cwd: validatedRepo });
  return parseNameStatus(output.split(/\r?\n/u).filter((entry) => entry.trim().length > 0));
}

export async function getCommitFileDiff(filePath: string, commit: string): Promise<GitDiff> {
  const path = resolve(filePath);

  const closestRepo = await getClosestGitRepo(path);
  if (closestRepo === null) {
    throw new GitRepositoryError(`File is not in a git repository: ${path}`);
  }
  const validatedRepo = await validateGitRepository(closestRepo);

  const sha = await resolveCommit(validatedRepo, commit);
  const parent = (await revParse(validatedRepo, `${sha}^`)) ?? GIT_EMPTY_TREE_HASH;

  if (!path.startsWith(validatedRepo + sep) && path !== validatedRepo) {
    throw new GitPathError(`File is not within git repository: ${path}`);
  }
  const relativePath = toPosixPath(path.slice(validatedRepo.length + 1));

  const original = await showFileAtRev(validatedRepo, parent, relativePath);
  const modified = await showFileAtRev(validatedRepo, sha, relativePath);
  return { modified, original };
}

async function showFileAtRev(repo: string, rev: string, relativePath: string): Promise<string> {
  const spec = `${rev}:${relativePath}`;
  let sizeOutput: string | null = null;
  try {
    sizeOutput = await runGitCommand(['git', '--no-pager', 'cat-file', '-s', spec], { cwd: repo });
  } catch (error) {
    if (!(error instanceof GitCommandError)) {
      throw error;
    }
  }
  if (sizeOutput !== null) {
    const size = Number.parseInt(sizeOutput, 10);
    if (Number.isFinite(size) && size > MAX_FILE_SIZE_FOR_GIT_DIFF) {
      throw new GitPathError(`File too large for git diff: ${size} bytes (max: ${MAX_FILE_SIZE_FOR_GIT_DIFF} bytes)`);
    }
  }

  try {
    return await runGitCommand(['git', '--no-pager', 'show', spec], { cwd: repo });
  } catch (error) {
    if (error instanceof GitCommandError) {
      return '';
    }
    throw error;
  }
}

function parseNameStatus(lines: readonly string[]): GitChange[] {
  const changes: GitChange[] = [];
  for (const line of lines) {
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
  return changes;
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
