import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryFileStore, LocalFileStore, MemoryLRUCache } from '../index.js';

describe('MemoryLRUCache', () => {
  it('enforces entry-count and memory limits', () => {
    const cache = new MemoryLRUCache<string, string>({ maxMemory: 10, maxSize: 2 });

    cache.set('a', '1234');
    cache.set('b', '1234');
    cache.set('c', '1234');

    expect(cache.size).toBeLessThanOrEqual(2);
    expect(cache.has('a')).toBe(false);
    expect(cache.currentMemory).toBeLessThanOrEqual(10);
  });

  it('skips entries larger than the memory budget', () => {
    const cache = new MemoryLRUCache<string, string>({ maxMemory: 3, maxSize: 10 });

    cache.set('too-large', '1234');

    expect(cache.has('too-large')).toBe(false);
    expect(cache.currentMemory).toBe(0);
  });
});

describe('LocalFileStore', () => {
  it('writes, reads, lists, deletes, and caches text files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openhands-agent-io-'));
    try {
      const store = new LocalFileStore(dir, { cacheLimitSize: 10 });

      store.write('subdir/test.txt', 'Hello, World!');
      expect(store.read('subdir/test.txt')).toBe('Hello, World!');
      expect(store.exists('subdir/test.txt')).toBe(true);
      expect(store.list('subdir')).toEqual(['subdir/test.txt']);
      expect(store.cache.has(store.getFullPath('subdir/test.txt'))).toBe(true);

      store.write('subdir/child.txt', 'child');
      expect(store.list('subdir').sort()).toEqual(['subdir/child.txt', 'subdir/test.txt']);

      store.delete('subdir/test.txt');
      expect(store.exists('subdir/test.txt')).toBe(false);
      expect(store.cache.has(store.getFullPath('subdir/test.txt'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('blocks POSIX and Windows-style path traversal', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openhands-agent-io-'));
    try {
      const store = new LocalFileStore(path.join(dir, 'filestore_root'));
      await writeFile(path.join(dir, 'sensitive.txt'), 'SENSITIVE DATA');

      for (const attackPath of [
        '../sensitive.txt',
        '../../sensitive.txt',
        'subdir/../../../sensitive.txt',
        String.raw`..\sensitive.txt`,
        String.raw`subdir\..\..\sensitive.txt`,
      ]) {
        expect(() => store.getFullPath(attackPath)).toThrow(/path escapes filestore root/u);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes root and keeps leading slashes under the file store root', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openhands-agent-io-'));
    try {
      const store = new LocalFileStore(path.join(dir, 'filestore_root'));

      expect(store.getFullPath('')).toBe(store.root);
      expect(store.getFullPath('/')).toBe(store.root);
      expect(store.getFullPath('.')).toBe(store.root);
      expect(store.getFullPath('/nested/file.txt')).toBe(path.join(store.root, 'nested', 'file.txt'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers stale lock files whose owning process is gone', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openhands-agent-io-'));
    try {
      const store = new LocalFileStore(dir);
      store.write('locks/test.lock', '999999999\n2026-01-01T00:00:00.000Z\n');

      const result = store.lock('locks/test.lock', () => 'acquired', { timeoutSeconds: 1, pollIntervalMs: 1 });

      expect(result).toBe('acquired');
      expect(store.exists('locks/test.lock')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects reentrant and asynchronous local lock callbacks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openhands-agent-io-'));
    try {
      const store = new LocalFileStore(dir);

      expect(() => {
        store.lock('locks/test.lock', () => {
          store.lock('locks/test.lock', () => undefined);
        });
      }).toThrow(/Deadlock detected/u);
      expect(store.exists('locks/test.lock')).toBe(false);

      expect(() => store.lock('locks/async.lock', async () => 'value')).toThrow(/does not support asynchronous callbacks/u);
      expect(store.exists('locks/async.lock')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not immediately reap fresh empty lock files but recovers old malformed locks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'openhands-agent-io-'));
    try {
      const store = new LocalFileStore(dir);
      store.write('locks/fresh.lock', '');

      expect(() => store.lock('locks/fresh.lock', () => 'blocked', { timeoutSeconds: 0.01, pollIntervalMs: 1 })).toThrow();
      expect(store.exists('locks/fresh.lock')).toBe(true);

      const oldLockPath = store.getFullPath('locks/old.lock');
      store.write('locks/old.lock', 'not-a-pid\n');
      const oldTime = new Date(Date.now() - 10_000);
      await utimes(oldLockPath, oldTime, oldTime);

      const result = store.lock('locks/old.lock', () => 'acquired', { timeoutSeconds: 1, pollIntervalMs: 1 });

      expect(result).toBe('acquired');
      expect(store.exists('locks/old.lock')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});

describe('InMemoryFileStore', () => {
  it('supports file operations and directory-like listings', () => {
    const store = new InMemoryFileStore({ 'events/one.json': 'one' });

    store.write('events/two.json', Buffer.from('two'));

    expect(store.read('events/one.json')).toBe('one');
    expect(store.read('events/two.json')).toBe('two');
    expect(store.list('events').sort()).toEqual(['events/one.json', 'events/two.json']);
    expect(store.exists('events')).toBe(true);

    store.delete('events');
    expect(store.exists('events/one.json')).toBe(false);
  });

  it('rejects reentrant lock acquisition instead of blocking the event loop', () => {
    const store = new InMemoryFileStore();

    expect(() => {
      store.lock('events/.eventlog.lock', () => {
        store.lock('events/.eventlog.lock', () => undefined);
      });
    }).toThrow(/Deadlock detected/u);
  });

  it('rejects asynchronous in-memory lock callbacks', () => {
    const store = new InMemoryFileStore();

    expect(() => store.lock('events/.eventlog.lock', async () => 'value')).toThrow(/does not support asynchronous callbacks/u);
  });
});
