import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractRepoName, getChangesInRepo, getClosestGitRepo, getGitDiff, isGitUrl, normalizeGitUrl, runGitCommand } from '../index.js';

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
});
