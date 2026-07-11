import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { toPosixPath } from '../utils/index.js';

export interface FileStoreLockOptions {
  readonly timeoutSeconds?: number;
  readonly pollIntervalMs?: number;
}

export interface FileStore {
  write(filePath: string, contents: string | Buffer): void;
  read(filePath: string): string;
  list(filePath: string): string[];
  delete(filePath: string): void;
  exists(filePath: string): boolean;
  getAbsolutePath(filePath: string): string;
  lock<T>(filePath: string, callback: () => T, options?: FileStoreLockOptions): T;
}

export interface MemoryLRUCacheOptions {
  readonly maxMemory: number;
  readonly maxSize: number;
}

export class MemoryLRUCache<K, V> {
  readonly maxMemory: number;
  readonly maxSize: number;
  currentMemory = 0;
  private readonly entries = new Map<K, { readonly value: V; readonly size: number }>();

  constructor(options: MemoryLRUCacheOptions) {
    this.maxMemory = options.maxMemory;
    this.maxSize = Math.max(1, options.maxSize);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): this {
    const newSize = valueSize(value);
    if (newSize > this.maxMemory) {
      return this;
    }

    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.currentMemory -= existing.size;
      this.entries.delete(key);
    }

    this.currentMemory += newSize;
    this.entries.set(key, { value, size: newSize });
    this.evictIfNeeded();
    return this;
  }

  delete(key: K): boolean {
    const existing = this.entries.get(key);
    if (existing === undefined) {
      return false;
    }
    this.currentMemory -= existing.size;
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.currentMemory = 0;
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }

  [Symbol.iterator](): IterableIterator<K> {
    return this.keys();
  }

  private evictIfNeeded(): void {
    while ((this.entries.size > this.maxSize || this.currentMemory > this.maxMemory) && this.entries.size > 0) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey === undefined) {
        break;
      }
      this.delete(firstKey);
    }
  }
}

function valueSize(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  if (Buffer.isBuffer(value)) {
    return value.byteLength;
  }
  return JSON.stringify(value)?.length ?? 0;
}

export interface LocalFileStoreOptions {
  readonly cacheLimitSize?: number;
  readonly cacheMemorySize?: number;
}

export class LocalFileStore implements FileStore {
  readonly root: string;
  readonly cache: MemoryLRUCache<string, string>;
  private readonly locks = new Set<string>();

  constructor(root: string, options: LocalFileStoreOptions = {}) {
    const expandedRoot = root.startsWith('~') ? path.join(process.env.HOME ?? '', root.slice(1)) : root;
    this.root = path.resolve(path.normalize(expandedRoot));
    mkdirSync(this.root, { recursive: true });
    this.cache = new MemoryLRUCache<string, string>({
      maxMemory: options.cacheMemorySize ?? 20 * 1024 * 1024,
      maxSize: options.cacheLimitSize ?? 500,
    });
  }

  getFullPath(filePath: string): string {
    const relativePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    const fullPath = path.resolve(path.normalize(path.join(this.root, toPosixPath(relativePath))));
    const relativeToRoot = path.relative(this.root, fullPath);
    if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      throw new ValueError(`path escapes filestore root: ${filePath}`);
    }
    return fullPath;
  }

  getAbsolutePath(filePath: string): string {
    return this.getFullPath(filePath);
  }

  write(filePath: string, contents: string | Buffer): void {
    const fullPath = this.getFullPath(filePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    if (typeof contents === 'string') {
      writeFileSync(fullPath, contents, 'utf8');
      this.cache.set(fullPath, contents);
    } else {
      writeFileSync(fullPath, contents);
      this.cache.delete(fullPath);
    }
  }

  read(filePath: string): string {
    const fullPath = this.getFullPath(filePath);
    const cached = this.cache.get(fullPath);
    if (cached !== undefined) {
      return cached;
    }
    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const contents = readFileSync(fullPath, 'utf8');
    this.cache.set(fullPath, contents);
    return contents;
  }

  list(filePath: string): string[] {
    const fullPath = this.getFullPath(filePath);
    if (!existsSync(fullPath)) {
      return [];
    }
    if (statSync(fullPath).isFile()) {
      return [filePath];
    }
    return readdirNames(fullPath).map((name) => {
      const child = joinStorePath(filePath, name);
      return statSync(this.getFullPath(child)).isDirectory() ? `${child}/` : child;
    });
  }

  lock<T>(filePath: string, callback: () => T, options: FileStoreLockOptions = {}): T {
    assertSynchronousLockCallback(callback);
    const fullPath = this.getFullPath(filePath);
    if (this.locks.has(fullPath)) {
      throw new Error(`Deadlock detected: lock already held for ${filePath}`);
    }

    mkdirSync(path.dirname(fullPath), { recursive: true });
    const deadline = Date.now() + (options.timeoutSeconds ?? 30) * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 50;
    let acquired = false;

    while (!acquired) {
      try {
        const fd = openSync(fullPath, 'wx');
        try {
          writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
          acquired = true;
        } catch (error) {
          removeLockFile(fullPath);
          throw error;
        } finally {
          closeLockDescriptor(fd);
        }
      } catch (error) {
        if (!isExistingLockError(error) || Date.now() >= deadline) {
          throw error;
        }
        removeStaleLockFile(fullPath);
        sleepSync(pollIntervalMs);
      }
    }

    this.locks.add(fullPath);
    try {
      const result = callback();
      assertSynchronousLockResult(result);
      return result;
    } finally {
      try {
        removeLockFile(fullPath);
      } finally {
        this.cache.delete(fullPath);
        this.locks.delete(fullPath);
      }
    }
  }

  delete(filePath: string): void {
    const fullPath = this.getFullPath(filePath);
    if (!existsSync(fullPath)) {
      return;
    }
    const stats = statSync(fullPath);
    rmSync(fullPath, { recursive: stats.isDirectory(), force: true });
    if (stats.isDirectory()) {
      this.cache.clear();
    } else {
      this.cache.delete(fullPath);
    }
  }

  exists(filePath: string): boolean {
    return existsSync(this.getFullPath(filePath));
  }
}

export class InMemoryFileStore implements FileStore {
  readonly files: MemoryLRUCache<string, string>;
  private readonly instanceId = randomUUID().replace(/-/gu, '');
  private readonly locks = new Set<string>();

  constructor(files: Readonly<Record<string, string>> = {}, options: LocalFileStoreOptions = {}) {
    this.files = new MemoryLRUCache<string, string>({
      maxMemory: options.cacheMemorySize ?? 20 * 1024 * 1024,
      maxSize: options.cacheLimitSize ?? 100_000,
    });
    for (const [filePath, contents] of Object.entries(files)) {
      this.files.set(filePath, contents);
    }
  }

  write(filePath: string, contents: string | Buffer): void {
    this.files.set(filePath, typeof contents === 'string' ? contents : contents.toString('utf8'));
  }

  read(filePath: string): string {
    const contents = this.files.get(filePath);
    if (contents === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }
    return contents;
  }

  list(filePath: string): string[] {
    const files: string[] = [];
    const normalizedPrefix = filePath.replace(/\/+$/u, '');
    for (const storedPath of this.files.keys()) {
      if (!storedPath.startsWith(normalizedPrefix)) {
        continue;
      }
      const suffix = storedPath.slice(normalizedPrefix.length).replace(/^\//u, '');
      const [firstPart, ...rest] = suffix.split('/');
      if (firstPart === undefined || firstPart.length === 0) {
        continue;
      }
      const listedPath = rest.length === 0 ? storedPath : `${joinStorePath(normalizedPrefix, firstPart)}/`;
      if (!files.includes(listedPath)) {
        files.push(listedPath);
      }
    }
    return files;
  }

  delete(filePath: string): void {
    for (const storedPath of [...this.files.keys()]) {
      if (storedPath === filePath || storedPath.startsWith(`${filePath}/`)) {
        this.files.delete(storedPath);
      }
    }
  }

  exists(filePath: string): boolean {
    if (this.files.has(filePath)) {
      return true;
    }
    return [...this.files.keys()].some((storedPath) => storedPath.startsWith(`${filePath}/`));
  }

  lock<T>(filePath: string, callback: () => T, _options: FileStoreLockOptions = {}): T {
    assertSynchronousLockCallback(callback);
    if (this.locks.has(filePath)) {
      throw new Error(`Deadlock detected: lock already held for ${filePath}`);
    }

    this.locks.add(filePath);
    try {
      const result = callback();
      assertSynchronousLockResult(result);
      return result;
    } finally {
      this.locks.delete(filePath);
    }
  }

  getAbsolutePath(filePath: string): string {
    return path.join(tmpdir(), `openhands_inmemory_${this.instanceId}`, filePath);
  }
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

function joinStorePath(basePath: string, childName: string): string {
  if (basePath.length === 0 || basePath === '.') {
    return childName;
  }
  return `${basePath.replace(/\/+$/u, '')}/${childName}`;
}

const asyncFunctionConstructor = (async () => {
  await Promise.resolve();
}).constructor;
const MALFORMED_LOCK_STALE_GRACE_MS = 5_000;

function assertSynchronousLockCallback(callback: () => unknown): void {
  if (callback.constructor === asyncFunctionConstructor) {
    throw new Error('FileStore.lock does not support asynchronous callbacks because it is synchronous.');
  }
}

function assertSynchronousLockResult(result: unknown): void {
  if (isPromiseLike(result)) {
    throw new Error('FileStore.lock does not support asynchronous callbacks because it is synchronous.');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

function closeLockDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Still attempt to unlink the lock path so a close failure does not deadlock future writers.
  }
}

function readdirNames(directory: string): string[] {
  return statSync(directory).isDirectory() ? readdirSync(directory).sort() : [];
}

function isExistingLockError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, milliseconds);
}

function removeStaleLockFile(lockPath: string): void {
  let contents: string;
  try {
    contents = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }

  const pidLine = (contents.split(/\r?\n/u)[0] ?? '').trim();
  if (!/^\d+$/u.test(pidLine)) {
    if (isMalformedLockWithinGracePeriod(lockPath)) {
      return;
    }
    removeLockFile(lockPath);
    return;
  }

  const pid = Number.parseInt(pidLine, 10);
  if (pid > 0 && isProcessAlive(pid)) {
    return;
  }
  removeLockFile(lockPath);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorCode(error, 'EPERM');
  }
}

function isMalformedLockWithinGracePeriod(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < MALFORMED_LOCK_STALE_GRACE_MS;
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return true;
    }
    throw error;
  }
}

function removeLockFile(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isNodeErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
