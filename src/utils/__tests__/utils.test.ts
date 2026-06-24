import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEXT_CONTENT_LIMIT,
  DEFAULT_TRUNCATE_NOTICE,
  executeCommand,
  isAbsolutePathSource,
  isHostAbsolutePath,
  isLocalPathSource,
  maybeTruncate,
  pageIterator,
  posixPathName,
  redactTextSecrets,
  redactUrlCredentials,
  redactUrlCredentialsInText,
  redactUrlParams,
  sanitizedEnv,
  sanitizeOpenHandsMentions,
  toPosixPath,
} from '../index.js';

describe('maybeTruncate', () => {
  it('keeps content when no positive limit is set or content fits', () => {
    expect(maybeTruncate('This is a test string')).toBe('This is a test string');
    expect(maybeTruncate('Short string', { truncateAfter: 100 })).toBe('Short string');
    expect(maybeTruncate('test', { truncateAfter: 0 })).toBe('test');
    expect(maybeTruncate('test', { truncateAfter: -1 })).toBe('test');
  });

  it('truncates using head and tail around the notice', () => {
    const content = 'A'.repeat(1000);
    const limit = 200;
    const result = maybeTruncate(content, { truncateAfter: limit });
    const availableChars = limit - DEFAULT_TRUNCATE_NOTICE.length;
    const half = Math.floor(availableChars / 2);
    const headChars = half + (availableChars % 2);
    const tailChars = half;

    expect(result).toBe(content.slice(0, headChars) + DEFAULT_TRUNCATE_NOTICE + content.slice(-tailChars));
    expect(result).toHaveLength(limit);
  });

  it('returns a sliced notice when the notice exceeds the budget', () => {
    expect(maybeTruncate('A'.repeat(100), { truncateAfter: 10, truncateNotice: 'X'.repeat(20) })).toBe('X'.repeat(10));
  });

  it('persists full content with hash-based deduplication', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openhands-agent-utils-'));
    try {
      const content = 'Test content for hashing '.repeat(20);
      const first = maybeTruncate(content, { truncateAfter: 300, saveDir: dir, toolPrefix: 'test' });
      const second = maybeTruncate(content, { truncateAfter: 300, saveDir: dir, toolPrefix: 'test' });
      const files = await readdir(dir);

      expect(first).toBe(second);
      expect(first).toContain('<response clipped>');
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^test_output_[a-f0-9]{8}\.txt$/u);
      expect(await readFile(join(dir, files[0] ?? ''), 'utf8')).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports the Python-compatible default text limit', () => {
    expect(DEFAULT_TEXT_CONTENT_LIMIT).toBe(50_000);
  });
});

describe('path utilities', () => {
  it('normalizes path display strings to POSIX separators without resolving', () => {
    expect(toPosixPath(String.raw`C:\work\repo\file.py`)).toBe('C:/work/repo/file.py');
    expect(posixPathName(String.raw`C:\work\repo\file.py`)).toBe('file.py');
  });

  it('detects local path sources while keeping URLs remote', () => {
    expect(isLocalPathSource(String.raw`C:\work\repo`)).toBe(true);
    expect(isLocalPathSource(String.raw`relative\plugin`)).toBe(true);
    expect(isLocalPathSource('.openhands')).toBe(true);
    expect(isLocalPathSource('https://github.com/org/repo')).toBe(false);
  });

  it('distinguishes cross-platform absolute syntax from host absolute paths', () => {
    expect(isAbsolutePathSource('/workspace/file.py')).toBe(true);
    expect(isAbsolutePathSource(String.raw`\workspace\file.py`)).toBe(true);
    expect(isAbsolutePathSource(String.raw`C:\workspace\file.py`)).toBe(true);
    expect(isHostAbsolutePath('/workspace/file.py')).toBe(true);
    expect(isHostAbsolutePath(String.raw`C:\workspace\file.py`)).toBe(false);
  });
});

describe('GitHub utilities', () => {
  it('sanitizes OpenHands mentions without changing case', () => {
    expect(sanitizeOpenHandsMentions('Thanks @OpenHands and @openhands and @OPENHANDS'))
      .toBe('Thanks @‍OpenHands and @‍openhands and @‍OPENHANDS');
    expect(sanitizeOpenHandsMentions('No mention here')).toBe('No mention here');
  });
});

describe('pageIterator', () => {
  it('iterates items from pages until nextPageId is absent', async () => {
    const calls: Array<string | undefined> = [];
    const search = async ({ pageId }: { pageId?: string }) => {
      calls.push(pageId);
      if (pageId === undefined) {
        return { items: [1, 2], nextPageId: 'second' };
      }
      return { items: [3], nextPageId: null };
    };

    const seen: number[] = [];
    for await (const item of pageIterator(search, {})) {
      seen.push(item);
    }

    expect(seen).toEqual([1, 2, 3]);
    expect(calls).toEqual([undefined, 'second']);
  });
});


describe('command utilities', () => {
  it('returns a sanitized environment copy', () => {
    const env = {
      FOO: 'bar',
      LD_LIBRARY_PATH: '/pyinstaller',
      LD_LIBRARY_PATH_ORIG: '/original',
      SESSION_API_KEY: 'secret-session',
    };

    const result = sanitizedEnv(env);

    expect(result).toEqual({ FOO: 'bar', LD_LIBRARY_PATH: '/original', LD_LIBRARY_PATH_ORIG: '/original' });
    expect(result).not.toBe(env);
  });

  it('removes LD_LIBRARY_PATH when the original value is empty', () => {
    const result = sanitizedEnv({ LD_LIBRARY_PATH: '/pyinstaller', LD_LIBRARY_PATH_ORIG: '' });

    expect(result).toEqual({ LD_LIBRARY_PATH_ORIG: '' });
  });

  it('executes commands and captures stdout and stderr', () => {
    const result = executeCommand('printf out && printf err >&2', { printOutput: false });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });
});

describe('redaction utilities', () => {
  it('redacts credentials embedded in URLs', () => {
    expect(redactUrlCredentials('https://oauth2:SECRET@gitlab.com/repo.git')).toBe('https://****@gitlab.com/repo.git');
    expect(redactUrlCredentials('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
    expect(redactUrlCredentialsInText("fatal: unable to access 'https://oauth2:SECRET@github.com/o/r.git/'"))
      .toBe("fatal: unable to access 'https://****@github.com/o/r.git/'");
  });

  it('redacts sensitive URL parameters while preserving safe ones', () => {
    const result = redactUrlParams('https://example.com/search?q=hello&apikey=secret123&Authorization=Bearer+xyz');

    expect(result).not.toContain('secret123');
    expect(result).not.toContain('Bearer');
    expect(result).not.toContain('xyz');
    expect(result).toContain('q=hello');
    expect(redactUrlParams('https://example.com/path')).toBe('https://example.com/path');
  });

  it('redacts key-value secrets in arbitrary text', () => {
    const redacted = redactTextSecrets("docker run -e api_key='secretvalue123456789' -e DEBUG=true image");

    expect(redacted).not.toContain('secretvalue123456789');
    expect(redacted).toContain('<redacted>');
    expect(redacted).toContain('DEBUG=true');
  });
});

