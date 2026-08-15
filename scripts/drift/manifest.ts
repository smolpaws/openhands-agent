import { readFile } from 'node:fs/promises';

import type {
  PolicyConfig,
  PolicyKind,
  SharedPathConfig,
  TargetConfig,
  TargetName,
  UpstreamManifest,
} from './types.js';

const FULL_SHA = /^[0-9a-f]{40}$/;
const POLICY_ID = /^(DEV|EXC|EXT)-(SDK|SERVER)-\d{3}$/;
const TARGETS: readonly TargetName[] = ['sdk', 'server'];
const POLICY_KINDS: readonly PolicyKind[] = ['DEVIATION', 'EXCLUDED', 'EXTENSION'];

export async function loadManifest(path: string): Promise<UpstreamManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parseManifest(parsed);
}

export function parseManifest(value: unknown): UpstreamManifest {
  const root = strictObject(value, 'manifest', [
    'schemaVersion',
    'repository',
    'commit',
    'targets',
    'sharedPaths',
    'ignorePrefixes',
    'ignorePaths',
    'policies',
  ]);
  equal(root.schemaVersion, 1, 'manifest.schemaVersion');
  const repository = nonEmptyString(root.repository, 'manifest.repository');
  const commit = nonEmptyString(root.commit, 'manifest.commit');
  if (!FULL_SHA.test(commit)) {
    throw new Error('manifest.commit must be a full lowercase 40-character Git SHA');
  }

  const rawTargets = strictObject(root.targets, 'manifest.targets', TARGETS);
  const targets = {} as Record<TargetName, TargetConfig>;
  for (const target of TARGETS) {
    const rawTarget = strictObject(rawTargets[target], `manifest.targets.${target}`, [
      'sourcePrefixes',
      'testPrefixes',
      'examplePrefixes',
    ]);
    targets[target] = {
      sourcePrefixes: prefixArray(rawTarget.sourcePrefixes, `manifest.targets.${target}.sourcePrefixes`),
      testPrefixes: prefixArray(rawTarget.testPrefixes, `manifest.targets.${target}.testPrefixes`),
      examplePrefixes: prefixArray(rawTarget.examplePrefixes, `manifest.targets.${target}.examplePrefixes`),
    };
  }

  const sharedPaths = array(root.sharedPaths, 'manifest.sharedPaths').map((item, index): SharedPathConfig => {
    const raw = strictObject(item, `manifest.sharedPaths[${index}]`, ['path', 'targets', 'module']);
    return {
      path: exactPath(raw.path, `manifest.sharedPaths[${index}].path`),
      targets: targetArray(raw.targets, `manifest.sharedPaths[${index}].targets`),
      module: nonEmptyString(raw.module, `manifest.sharedPaths[${index}].module`),
    };
  });

  const policies = array(root.policies, 'manifest.policies').map((item, index): PolicyConfig => {
    const raw = strictObject(item, `manifest.policies[${index}]`, [
      'id',
      'kind',
      'target',
      'prefixes',
      'paths',
    ]);
    const id = nonEmptyString(raw.id, `manifest.policies[${index}].id`);
    const match = POLICY_ID.exec(id);
    if (!match) throw new Error(`manifest.policies[${index}].id is not a stable DEV/EXC/EXT policy ID`);
    const kind = enumValue(raw.kind, POLICY_KINDS, `manifest.policies[${index}].kind`);
    const target = enumValue(raw.target, TARGETS, `manifest.policies[${index}].target`);
    const expectedPrefix = kind === 'DEVIATION' ? 'DEV-' : kind === 'EXCLUDED' ? 'EXC-' : 'EXT-';
    if (!id.startsWith(expectedPrefix)) {
      throw new Error(`policy ${id} must use ${expectedPrefix} for kind ${kind}`);
    }
    const encodedTarget = match[2]?.toLowerCase();
    if (encodedTarget !== target) {
      throw new Error(`policy ${id} encodes target ${encodedTarget}, not ${target}`);
    }
    return {
      id,
      kind,
      target,
      prefixes: prefixArray(raw.prefixes, `manifest.policies[${index}].prefixes`),
      paths: exactPathArray(raw.paths, `manifest.policies[${index}].paths`),
    };
  });

  assertUnique(sharedPaths.map((item) => item.path), 'manifest.sharedPaths paths');
  assertUnique(policies.map((policy) => policy.id), 'manifest.policies IDs');

  return {
    schemaVersion: 1,
    repository,
    commit,
    targets,
    sharedPaths,
    ignorePrefixes: prefixArray(root.ignorePrefixes, 'manifest.ignorePrefixes'),
    ignorePaths: exactPathArray(root.ignorePaths, 'manifest.ignorePaths'),
    policies,
  };
}

export function policyById(manifest: UpstreamManifest, id: string): PolicyConfig | undefined {
  return manifest.policies.find((policy) => policy.id === id);
}

function strictObject(value: unknown, label: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const unexpected = Object.keys(result).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unknown keys: ${unexpected.join(', ')}`);
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function repositoryPath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label);
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`${label} must be a repository-relative POSIX path`);
  }
  return path;
}

function exactPath(value: unknown, label: string): string {
  const path = repositoryPath(value, label);
  if (path.endsWith('/')) throw new Error(`${label} must be an exact file path, not a prefix`);
  return path;
}

function prefixArray(value: unknown, label: string): string[] {
  const result = array(value, label).map((item, index) => repositoryPath(item, `${label}[${index}]`));
  for (const item of result) {
    if (!item.endsWith('/')) throw new Error(`${label} entries must end in /: ${item}`);
  }
  assertUnique(result, label);
  return result;
}

function exactPathArray(value: unknown, label: string): string[] {
  const result = array(value, label).map((item, index) => exactPath(item, `${label}[${index}]`));
  assertUnique(result, label);
  return result;
}

function targetArray(value: unknown, label: string): TargetName[] {
  const result = array(value, label).map((item, index) => enumValue(item, TARGETS, `${label}[${index}]`));
  if (result.length === 0) throw new Error(`${label} must contain at least one target`);
  assertUnique(result, label);
  return result;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} must equal ${String(expected)}`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}
