import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ExtensionFetchError,
  InstallationInfo,
  InstallationMetadata,
  fetchWithResolution,
  getCachePath,
  parseExtensionSource,
  validateExtensionName,
} from '../index.js';

describe('extension fetch utilities', () => {
  it('parses GitHub shorthand, git URLs, and local paths', () => {
    expect(parseExtensionSource(' github:owner/repo ')).toEqual({ type: 'github', url: 'https://github.com/owner/repo.git' });
    expect(parseExtensionSource('https://gitlab.com/org/repo')).toEqual({ type: 'git', url: 'https://gitlab.com/org/repo.git' });
    expect(parseExtensionSource('./local-extension')).toEqual({ type: 'local', url: './local-extension' });
    expect(() => parseExtensionSource('github:too/many/parts')).toThrow(ExtensionFetchError);
  });

  it('returns deterministic cache paths and resolves local sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openhands-ext-'));
    try {
      const extDir = join(dir, 'extension');
      await mkdir(extDir);

      expect(getCachePath('github:owner/repo', dir)).toMatch(new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/repo-[a-f0-9]{12}$`, 'u'));
      await expect(fetchWithResolution(extDir, dir)).resolves.toEqual({ path: extDir, resolvedRef: null });
      await expect(fetchWithResolution(extDir, dir, { repoPath: 'subdir' })).rejects.toThrow(/repoPath is not supported/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extension installation metadata', () => {
  it('validates extension names', () => {
    expect(() => validateExtensionName('valid-name')).not.toThrow();
    expect(() => validateExtensionName('InvalidName')).toThrow(/kebab-case/u);
  });

  it('loads legacy metadata keys, saves, and prunes missing tracked dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openhands-ext-meta-'));
    try {
      const existingDir = join(dir, 'existing-ext');
      await mkdir(existingDir, { recursive: true });
      const info = new InstallationInfo({ name: 'existing-ext', source: 'local', installPath: existingDir });
      const metadata = new InstallationMetadata({ plugins: { 'existing-ext': info, 'missing-ext': new InstallationInfo({ name: 'missing-ext', source: 'local', installPath: join(dir, 'missing-ext') }) } });

      await metadata.saveToDir(dir);
      const loaded = await InstallationMetadata.loadFromDir(dir);

      expect(Object.keys(loaded.extensions)).toEqual(['existing-ext', 'missing-ext']);
      expect(loaded.validateTracked(dir).map((entry) => entry.name)).toEqual(['existing-ext']);
      expect(Object.keys(loaded.extensions)).toEqual(['existing-ext']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records requested_ref separately from resolved_ref', () => {
    const info = InstallationInfo.fromExtension(
      { name: 'mock-extension', version: '0.1.2', description: 'Test' },
      'github:owner/repo',
      '/tmp/installed',
      { requestedRef: 'v1.0.0', resolvedRef: 'abc123' },
    );
    expect(info.requestedRef).toBe('v1.0.0');
    expect(info.resolvedRef).toBe('abc123');
  });

  it('leaves requested_ref null when only a resolved commit is recorded', () => {
    const info = InstallationInfo.fromExtension(
      { name: 'mock-extension', version: '0.1.2' },
      'github:owner/repo',
      '/tmp/installed',
      { resolvedRef: 'abc123' },
    );
    expect(info.requestedRef).toBeNull();
    expect(info.resolvedRef).toBe('abc123');
  });

  it('round-trips requested_ref through toJSON', () => {
    const info = new InstallationInfo({
      name: 'mock-extension',
      source: 'github:owner/repo',
      installPath: '/tmp/installed',
      requestedRef: 'main',
      resolvedRef: 'abc123',
    });
    expect(info.toJSON().requestedRef).toBe('main');
    expect(new InstallationInfo(info.toJSON()).requestedRef).toBe('main');
  });
});
