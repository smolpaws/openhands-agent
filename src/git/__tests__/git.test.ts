import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractRepoName, getChangesInRepo, getClosestGitRepo, getCommitChanges, getCommitFileDiff, getGitCommits, getGitDiff, getGitRepositoryMetadata, getValidRef, GIT_EMPTY_TREE_HASH, isGitUrl, normalizeGitUrl, runGitCommand } from '../index.js';

describe('git utilities', () => {
  it('detects and normalizes git URLs', () => {
    expect(isGitUrl('https://github.com/owner/repo')).toBe(true);
    expect(isGitUrl('git@github.com:owner/repo.git')).toBe(true);
    expect(isGitUrl('/local/path')).toBe(false);
    expect(normalizeGitUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo.git');
    expect(extractRepoName('git@github.com:owner/my.repo.git')).toBe('my-repo');
  });

  it('collects changed files and file content diff against HEAD', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openhands-git-'));
    try {
      await runGitCommand(['git', 'init'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.name', 'Tester'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.email', 'tester@example.com'], { cwd: repo });
      await writeFile(join(repo, 'tracked.txt'), 'old\n');
      await runGitCommand(['git', 'add', 'tracked.txt'], { cwd: repo });
      await runGitCommand(['git', 'commit', '-m', 'initial'], { cwd: repo });
      await writeFile(join(repo, 'tracked.txt'), 'new\n');
      await writeFile(join(repo, 'new.txt'), 'hello\n');
      await mkdir(join(repo, 'sub'));

      expect(await getClosestGitRepo(join(repo, 'sub'))).toBe(repo);
      const changes = await getChangesInRepo(repo, 'HEAD');
      expect(changes).toEqual([
        { status: 'ADDED', path: 'new.txt' },
        { status: 'UPDATED', path: 'tracked.txt' },
      ]);

      const diff = await getGitDiff(join(repo, 'tracked.txt'), 'HEAD');
      expect(diff.original).toBe('old');
      expect(diff.modified).toBe('new');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('redacts credentials from git command errors', async () => {
    await expect(runGitCommand(['git', 'ls-remote', 'https://token@example.invalid/repo.git'], { timeoutSeconds: 1 })).rejects.toMatchObject({ command: ['git', 'ls-remote', 'https://<redacted>@example.invalid/repo.git'] });
  });

  it('resolves HEAD (git-status style) for display and empty-tree for export in a no-remote repo', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openhands-git-ref-'));
    try {
      await runGitCommand(['git', 'init', '-b', 'main'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.name', 'Tester'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.email', 'tester@example.com'], { cwd: repo });
      await writeFile(join(repo, 'a.txt'), 'a');
      await runGitCommand(['git', 'add', 'a.txt'], { cwd: repo });
      await runGitCommand(['git', 'commit', '-m', 'base'], { cwd: repo });
      const head = await runGitCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo });

      expect(await getValidRef(repo, null)).toBe(GIT_EMPTY_TREE_HASH);
      expect(await getValidRef(repo, null, 'display')).toBe(head);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('lists recent commits newest-first with has_more', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openhands-git-commits-'));
    try {
      await runGitCommand(['git', 'init', '-b', 'main'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.name', 'Tester'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.email', 'tester@example.com'], { cwd: repo });
      await writeFile(join(repo, 'a.txt'), 'one');
      await runGitCommand(['git', 'add', 'a.txt'], { cwd: repo });
      await runGitCommand(['git', 'commit', '-m', 'first commit'], { cwd: repo });
      await writeFile(join(repo, 'a.txt'), 'two');
      await runGitCommand(['git', 'add', 'a.txt'], { cwd: repo });
      await runGitCommand(['git', 'commit', '-m', 'second commit'], { cwd: repo });
      const sha = await runGitCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo });

      const page = await getGitCommits(repo);
      expect(page.commits.map((commit) => commit.subject)).toEqual(['second commit', 'first commit']);
      expect(page.has_more).toBe(false);
      expect(page.commits[0]?.sha).toBe(sha);
      expect(sha.startsWith(page.commits[0]?.short_sha ?? '')).toBe(true);
      expect(page.commits[0]?.author).toBe('Tester');
      expect(Number.isNaN(Date.parse(page.commits[0]?.timestamp ?? ''))).toBe(false);

      const limited = await getGitCommits(repo, 1);
      expect(limited.commits.map((commit) => commit.subject)).toEqual(['second commit']);
      expect(limited.has_more).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports a single commit change list and per-commit file diff from git objects', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openhands-git-commit-'));
    try {
      await runGitCommand(['git', 'init', '-b', 'main'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.name', 'Tester'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.email', 'tester@example.com'], { cwd: repo });
      await writeFile(join(repo, 'keep.txt'), 'original');
      await writeFile(join(repo, 'doomed.txt'), 'doomed');
      await runGitCommand(['git', 'add', '.'], { cwd: repo });
      await runGitCommand(['git', 'commit', '-m', 'base'], { cwd: repo });

      await writeFile(join(repo, 'keep.txt'), 'changed');
      await writeFile(join(repo, 'added.txt'), 'new');
      await runGitCommand(['git', 'rm', '-q', 'doomed.txt'], { cwd: repo });
      await runGitCommand(['git', 'add', '.'], { cwd: repo });
      await runGitCommand(['git', 'commit', '-m', 'mixed'], { cwd: repo });
      const sha = await runGitCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo });

      const changes = await getCommitChanges(repo, sha);
      const byPath = Object.fromEntries(changes.map((change) => [change.path, change.status]));
      expect(byPath).toEqual({ 'keep.txt': 'UPDATED', 'added.txt': 'ADDED', 'doomed.txt': 'DELETED' });

      // A working-tree edit after the commit must not leak into the commit diff.
      await writeFile(join(repo, 'keep.txt'), 'working tree noise');
      const diff = await getCommitFileDiff(join(repo, 'keep.txt'), sha);
      expect(diff.original).toBe('original');
      expect(diff.modified).toBe('changed');

      // Deleted files still render from git objects.
      const deletedDiff = await getCommitFileDiff(join(repo, 'doomed.txt'), sha);
      expect(deletedDiff.original).toBe('doomed');
      expect(deletedDiff.modified).toBe('');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exposes redacted repository metadata', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openhands-git-meta-'));
    try {
      await runGitCommand(['git', 'init', '-b', 'main'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.name', 'Tester'], { cwd: repo });
      await runGitCommand(['git', 'config', 'user.email', 'tester@example.com'], { cwd: repo });
      await writeFile(join(repo, 'a.txt'), 'a');
      await runGitCommand(['git', 'add', 'a.txt'], { cwd: repo });
      await runGitCommand(['git', 'commit', '-m', 'base'], { cwd: repo });
      // Use HTTPS:// (mixed-case scheme) so the case-insensitive scheme redaction is exercised.
      await runGitCommand(['git', 'remote', 'add', 'origin', 'HTTPS://user:secret@github.com/org/repo.git'], { cwd: repo });
      const head = await runGitCommand(['git', 'rev-parse', 'HEAD'], { cwd: repo });

      const metadata = await getGitRepositoryMetadata(repo);
      expect(metadata.repo_remote).toBe('HTTPS://****@github.com/org/repo.git');
      expect(metadata.head_commit).toBe(head);
      expect(metadata.branch).toBe('main');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
