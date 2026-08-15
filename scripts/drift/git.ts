import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import type { ChangedFile } from './types.js';

export interface CommitMeta {
  readonly sha: string;
  readonly authoredAt: string;
  readonly subject: string;
}

export class GitRepository {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    const inside = this.git(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') throw new Error(`${this.path} is not a git work tree`);
  }

  resolveCommit(ref: string): string {
    return this.git(['rev-parse', '--verify', `${ref}^{commit}`]);
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    try {
      this.git(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  countCommits(from: string, to: string, firstParent = false): number {
    const args = ['rev-list', '--count'];
    if (firstParent) args.push('--first-parent');
    args.push(`${from}..${to}`);
    return parseInteger(this.git(args), 'commit count');
  }

  firstParentCommits(from: string, to: string): string[] {
    const output = this.git(['rev-list', '--first-parent', '--reverse', `${from}..${to}`]);
    return output === '' ? [] : output.split('\n');
  }

  commitMeta(ref: string): CommitMeta {
    const output = this.git(['show', '-s', '--format=%H%x00%aI%x00%s', ref]);
    const [sha, authoredAt, subject, ...rest] = output.split('\0');
    if (sha === undefined || authoredAt === undefined || subject === undefined || rest.length > 0) {
      throw new Error(`could not parse commit metadata for ${ref}`);
    }
    return { sha, authoredAt, subject };
  }

  firstParent(ref: string): string | null {
    const parts = this.git(['rev-list', '--parents', '-n', '1', ref]).split(' ');
    return parts[1] ?? null;
  }

  changedFiles(parent: string | null, commit: string): ChangedFile[] {
    const args = parent === null
      ? ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', commit]
      : ['diff', '--name-status', '-M', '-z', parent, commit];
    const raw = this.gitRaw(args);
    return parseNameStatus(raw);
  }

  private git(args: readonly string[]): string {
    return this.gitRaw(args).toString('utf8').trim();
  }

  private gitRaw(args: readonly string[]): Buffer {
    return execFileSync('git', [...args], {
      cwd: this.path,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

export function parseNameStatus(raw: Buffer): ChangedFile[] {
  if (raw.length === 0) return [];
  const tokens = raw.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const result: ChangedFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++];
    if (rawStatus === undefined) break;
    const status = rawStatus[0] ?? rawStatus;
    if (status === 'R' || status === 'C') {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (previousPath === undefined || path === undefined) {
        throw new Error(`malformed git name-status output for ${rawStatus}`);
      }
      result.push({ status, path, previousPath });
    } else {
      const path = tokens[index++];
      if (path === undefined) throw new Error(`malformed git name-status output for ${rawStatus}`);
      result.push({ status, path, previousPath: null });
    }
  }
  return result;
}

function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${label}: ${value}`);
  return parsed;
}
