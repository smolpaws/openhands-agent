import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { extractRepoName, isGitUrl, normalizeGitUrl } from '../git/index.js';

export type ExtensionSourceType = 'local' | 'git' | 'github';

export interface ParsedExtensionSource {
  readonly type: ExtensionSourceType;
  readonly url: string;
}

export class ExtensionFetchError extends Error {}

export function parseExtensionSource(source: string): ParsedExtensionSource {
  const value = source.trim();
  if (value.startsWith('github:')) {
    const repo = value.slice('github:'.length);
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) {
      throw new ExtensionFetchError(`Invalid GitHub shorthand format: ${value}. Expected format: github:owner/repo`);
    }
    return { type: 'github', url: `https://github.com/${repo}.git` };
  }
  if (isGitUrl(value)) {
    return { type: 'git', url: normalizeGitUrl(value) };
  }
  if (isLocalPathSource(value) || (value.includes('/') && !value.includes('://'))) {
    return { type: 'local', url: value };
  }
  throw new ExtensionFetchError(`Unable to parse extension source: ${value}`);
}

export function getCachePath(source: string, cacheDir: string): string {
  const parsed = parseExtensionSource(source);
  const repoName = parsed.type === 'local' ? basename(parsed.url.replace(/\/+$/u, '')) || 'extension' : extractRepoName(parsed.url);
  const digest = createHash('sha256').update(parsed.url).digest('hex').slice(0, 12);
  return join(cacheDir, `${repoName}-${digest}`);
}

export interface FetchOptions {
  readonly ref?: string | null;
  readonly update?: boolean;
  readonly repoPath?: string | null;
  readonly gitFetcher?: (url: string, destination: string, options: { readonly ref: string | null; readonly update: boolean }) => Promise<string | null>;
}

export interface FetchResolution {
  readonly path: string;
  readonly resolvedRef: string | null;
}

export async function fetchWithResolution(source: string, cacheDir: string, options: FetchOptions = {}): Promise<FetchResolution> {
  const parsed = parseExtensionSource(source);
  if (parsed.type === 'local') {
    if (options.repoPath !== undefined && options.repoPath !== null) {
      throw new ExtensionFetchError('repoPath is not supported for local extension sources. Specify the full path directly.');
    }
    return { path: await resolveLocalSource(parsed.url), resolvedRef: null };
  }
  if (options.gitFetcher === undefined) {
    throw new ExtensionFetchError('Git extension fetching requires an explicit gitFetcher in the TypeScript package');
  }
  await mkdir(cacheDir, { recursive: true });
  const cachePath = getCachePath(source, cacheDir);
  const resolvedRef = await options.gitFetcher(parsed.url, cachePath, { ref: options.ref ?? null, update: options.update ?? true });
  return { path: await applySubpath(cachePath, options.repoPath ?? null), resolvedRef };
}

export async function fetchExtension(source: string, cacheDir: string, options: FetchOptions = {}): Promise<string> {
  return (await fetchWithResolution(source, cacheDir, options)).path;
}

export interface ExtensionProtocol {
  readonly name: string;
  readonly version: string;
  readonly description?: string | null;
}

export interface InstallationInfoOptions {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly source: string;
  readonly resolvedRef?: string | null;
  readonly repoPath?: string | null;
  readonly installedAt?: string;
  readonly installPath: string;
}

export class InstallationInfo {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  enabled: boolean;
  readonly source: string;
  readonly resolvedRef: string | null;
  readonly repoPath: string | null;
  readonly installedAt: string;
  readonly installPath: string;

  constructor(options: InstallationInfoOptions) {
    this.name = options.name;
    this.version = options.version ?? '';
    this.description = options.description ?? '';
    this.enabled = options.enabled ?? true;
    this.source = options.source;
    this.resolvedRef = options.resolvedRef ?? null;
    this.repoPath = options.repoPath ?? null;
    this.installedAt = options.installedAt ?? new Date().toISOString();
    this.installPath = options.installPath;
  }

  static fromExtension(extension: ExtensionProtocol, source: string, installPath: string, options: { readonly resolvedRef?: string | null; readonly repoPath?: string | null } = {}): InstallationInfo {
    return new InstallationInfo({
      name: extension.name,
      version: extension.version,
      description: extension.description ?? '',
      source,
      installPath,
      resolvedRef: options.resolvedRef ?? null,
      repoPath: options.repoPath ?? null,
    });
  }

  toJSON(): InstallationInfoOptions {
    return {
      name: this.name,
      version: this.version,
      description: this.description,
      enabled: this.enabled,
      source: this.source,
      resolvedRef: this.resolvedRef,
      repoPath: this.repoPath,
      installedAt: this.installedAt,
      installPath: this.installPath,
    };
  }
}

export interface InstallationMetadataOptions {
  readonly extensions?: Readonly<Record<string, InstallationInfo | InstallationInfoOptions>>;
  readonly plugins?: Readonly<Record<string, InstallationInfo | InstallationInfoOptions>>;
  readonly skills?: Readonly<Record<string, InstallationInfo | InstallationInfoOptions>>;
}

export class InstallationMetadata {
  static readonly metadataFilename = '.installed.json';
  readonly extensions: Record<string, InstallationInfo>;

  constructor(options: InstallationMetadataOptions = {}) {
    this.extensions = normalizeInfoMap({ ...(options.plugins ?? {}), ...(options.skills ?? {}), ...(options.extensions ?? {}) });
  }

  static metadataPath(installedDir: string): string {
    return join(installedDir, InstallationMetadata.metadataFilename);
  }

  static async loadFromDir(installedDir: string): Promise<InstallationMetadata> {
    try {
      const raw = JSON.parse(await readFile(InstallationMetadata.metadataPath(installedDir), 'utf8')) as unknown;
      if (isRecord(raw)) {
        return new InstallationMetadata(raw);
      }
    } catch {
      return new InstallationMetadata();
    }
    return new InstallationMetadata();
  }

  async saveToDir(installedDir: string): Promise<void> {
    const path = InstallationMetadata.metadataPath(installedDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ extensions: this.extensions }, null, 2)}\n`);
  }

  validateTracked(installedDir: string): InstallationInfo[] {
    const valid: InstallationInfo[] = [];
    for (const [name, info] of Object.entries({ ...this.extensions })) {
      try {
        validateExtensionName(name);
      } catch {
        delete this.extensions[name];
        continue;
      }
      if (existsSync(join(installedDir, name))) {
        valid.push(info);
      } else {
        delete this.extensions[name];
      }
    }
    return valid;
  }

  async discoverUntracked(installedDir: string, loadFromDir: (extensionDir: string) => Promise<ExtensionProtocol>): Promise<InstallationInfo[]> {
    const discovered: InstallationInfo[] = [];
    for (const item of await readdir(installedDir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith('.') || this.extensions[item.name] !== undefined) {
        continue;
      }
      validateExtensionName(item.name);
      const dir = join(installedDir, item.name);
      const extension = await loadFromDir(dir);
      const info = InstallationInfo.fromExtension(extension, 'local', dir);
      this.extensions[item.name] = info;
      discovered.push(info);
    }
    return discovered;
  }
}

export function validateExtensionName(name: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new Error(`Invalid extension name. Expected kebab-case, got ${JSON.stringify(name)}.`);
  }
}

function normalizeInfoMap(map: Readonly<Record<string, InstallationInfo | InstallationInfoOptions>>): Record<string, InstallationInfo> {
  const result: Record<string, InstallationInfo> = {};
  for (const [name, info] of Object.entries(map)) {
    result[name] = info instanceof InstallationInfo ? info : new InstallationInfo({ ...info, name: info.name ?? name });
  }
  return result;
}

async function resolveLocalSource(source: string): Promise<string> {
  const expanded = source.startsWith('~/') ? join(homedir(), source.slice(2)) : source;
  const path = resolve(expanded);
  if (!(await exists(path))) {
    throw new ExtensionFetchError(`Local extension path does not exist: ${path}`);
  }
  return path;
}

async function applySubpath(basePath: string, subpath: string | null): Promise<string> {
  if (subpath === null || subpath.length === 0) {
    return basePath;
  }
  const finalPath = resolve(basePath, subpath.replace(/^\/+|\/+$/gu, ''));
  if (!(await exists(finalPath))) {
    throw new ExtensionFetchError(`Subdirectory '${subpath}' not found in extension repository`);
  }
  return finalPath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isLocalPathSource(source: string): boolean {
  return source.startsWith('/') || source.startsWith('~/') || source.startsWith('./') || source.startsWith('../') || /^[a-zA-Z]:[\\/]/u.test(source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
