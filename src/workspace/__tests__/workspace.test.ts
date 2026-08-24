import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runGitCommand } from '../../git/index.js';
import { LocalWorkspace, RemoteWorkspace, RepoSource, buildCloneUrl, getReposContext, workspace } from '../index.js';

describe('LocalWorkspace', () => {
  it('executes shell commands in the workspace directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openhands-workspace-'));
    try {
      const ws = new LocalWorkspace({ workingDir: dir });
      await writeFile(join(dir, 'input.txt'), 'hello\n');

      const result = await ws.executeCommand('cat input.txt');

      expect(result).toMatchObject({ command: 'cat input.txt', exitCode: 0, stdout: 'hello\n', stderr: '', timeoutOccurred: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('copies files for upload and download results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openhands-workspace-'));
    try {
      const ws = new LocalWorkspace({ workingDir: dir });
      const source = join(dir, 'source.txt');
      const uploaded = join(dir, 'nested', 'uploaded.txt');
      const downloaded = join(dir, 'downloaded.txt');
      await writeFile(source, 'payload');

      expect(await ws.fileUpload(source, uploaded)).toMatchObject({ success: true, fileSize: 7 });
      expect(await ws.fileDownload(uploaded, downloaded)).toMatchObject({ success: true, fileSize: 7 });
      expect(await readFile(downloaded, 'utf8')).toBe('payload');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wraps git changes and diffs relative to the workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openhands-workspace-'));
    try {
      await runGitCommand(['git', 'init'], { cwd: dir });
      await runGitCommand(['git', 'config', 'user.name', 'Tester'], { cwd: dir });
      await runGitCommand(['git', 'config', 'user.email', 'tester@example.com'], { cwd: dir });
      await writeFile(join(dir, 'tracked.txt'), 'old\n');
      await runGitCommand(['git', 'add', 'tracked.txt'], { cwd: dir });
      await runGitCommand(['git', 'commit', '-m', 'initial'], { cwd: dir });
      await writeFile(join(dir, 'tracked.txt'), 'new\n');
      await writeFile(join(dir, 'new.txt'), 'hello\n');

      const ws = new LocalWorkspace({ workingDir: dir });

      expect(await ws.gitChanges('.')).toEqual([
        { status: 'ADDED', path: 'new.txt' },
        { status: 'UPDATED', path: 'tracked.txt' },
      ]);
      expect(await ws.gitDiff('tracked.txt')).toEqual({ original: 'old', modified: 'new' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('workspace repo helpers', () => {
  it('validates RepoSource and safely builds clone URLs', () => {
    expect(new RepoSource({ url: 'http://github.com/owner/repo' }).url).toBe('https://github.com/owner/repo');
    expect(() => new RepoSource({ url: 'owner/repo' })).toThrow(/requires explicit provider/u);
    const source = new RepoSource({ url: 'owner/repo', provider: 'github' });

    expect(source.getProvider()).toBe('github');
    expect(source.getTokenName()).toBe('github_token');
    expect(buildCloneUrl(source.url, source.getProvider(), 'secret')).toBe('https://secret@github.com/owner/repo.git');
    expect(buildCloneUrl('https://github.com.evil.test/owner/repo', 'github', 'secret')).toBe('https://github.com.evil.test/owner/repo');
  });

  it('injects tokens into self-hosted hosts only when the provider is explicit', () => {
    expect(buildCloneUrl('https://gitlab.mycompany.com/owner/repo', 'gitlab', 'gltoken123', true)).toBe(
      'https://oauth2:gltoken123@gitlab.mycompany.com/owner/repo',
    );
    expect(buildCloneUrl('https://gitlab.mycompany.com/owner/repo', 'gitlab', 'gltoken123', false)).toBe(
      'https://gitlab.mycompany.com/owner/repo',
    );
  });

  it('never injects tokens into lookalike hosts', () => {
    expect(buildCloneUrl('https://github.com.evil.com/owner/repo', 'github', 'ghtoken123', false)).toBe(
      'https://github.com.evil.com/owner/repo',
    );
    expect(buildCloneUrl('https://github.com.evil.com/owner/repo', 'github', 'ghtoken123', true)).toBe(
      'https://github.com.evil.com/owner/repo',
    );
  });

  it('normalizes host case and preserves non-default ports when injecting', () => {
    expect(buildCloneUrl('https://GitLab.MyCompany.com:8443/owner/repo', 'gitlab', 'gltoken123', true)).toBe(
      'https://oauth2:gltoken123@gitlab.mycompany.com:8443/owner/repo',
    );
  });

  it('preserves credentials already embedded in the URL', () => {
    expect(buildCloneUrl('https://oauth2:embedded@gitlab.mycompany.com/owner/repo', 'gitlab', 'gltoken123', true)).toBe(
      'https://oauth2:embedded@gitlab.mycompany.com/owner/repo',
    );
  });

  it('creates local workspaces from the workspace factory and renders repo context', () => {
    const ws = workspace({ workingDir: '/tmp/project' });

    expect(ws).toBeInstanceOf(LocalWorkspace);
    expect(getReposContext({ repo: { url: 'https://github.com/a/repo', dirName: 'repo', localPath: '/workspace/repo', ref: 'main' } })).toContain('`https://github.com/a/repo` (ref: main) → `/workspace/repo/`');
  });

  it('uses LocalWorkspace and RemoteWorkspace instances as the workspace guard surface', () => {
    const local = workspace({ workingDir: '/tmp/project' });
    const remote = workspace({ host: 'http://127.0.0.1:18999', workingDir: '/workspace/project' });

    expect(local).toBeInstanceOf(LocalWorkspace);
    expect(local).not.toBeInstanceOf(RemoteWorkspace);
    expect(remote).toBeInstanceOf(RemoteWorkspace);
    expect(remote).not.toBeInstanceOf(LocalWorkspace);
  });
});
