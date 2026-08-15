import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { fileMatchesPolicy, unitId, unmappedId } from './inventory.js';
import { policyById } from './manifest.js';
import type {
  CheckPhase,
  Disposition,
  DocsImpact,
  DriftInventory,
  DriftReview,
  MappedFile,
  ReviewItem,
  TargetName,
  UpstreamManifest,
} from './types.js';

const DISPOSITIONS: readonly Disposition[] = [
  'PORT',
  'NO_TARGET_CHANGE',
  'DEVIATION',
  'EXCLUDED',
  'DEFERRED',
];
const DOCS_IMPACTS: readonly DocsImpact[] = ['none', 'update'];

export function inventoryHash(inventory: DriftInventory): string {
  return createHash('sha256').update(`${JSON.stringify(inventory)}\n`).digest('hex');
}

export function prepareReview(inventory: DriftInventory): DriftReview {
  const items: Record<string, ReviewItem> = {};
  const unmapped: Record<string, string | null> = {};
  for (const commit of inventory.commits) {
    for (const target of ['sdk', 'server'] as const) {
      if (commit.units[target] === undefined) continue;
      items[unitId(commit.sha, target)] = emptyReviewItem();
    }
    for (const path of commit.unmappedPaths) unmapped[unmappedId(commit.sha, path)] = null;
  }
  return {
    schemaVersion: 1,
    repository: inventory.repository,
    from: inventory.from,
    to: inventory.to,
    inventorySha256: inventoryHash(inventory),
    items,
    unmapped,
  };
}

export async function loadReview(path: string): Promise<DriftReview> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return parseReview(parsed);
}

export async function writeReview(path: string, review: DriftReview): Promise<void> {
  await writeFile(path, `${JSON.stringify(review, null, 2)}\n`);
}

export function validateReview(
  inventory: DriftInventory,
  review: DriftReview,
  manifest: UpstreamManifest,
  phase: CheckPhase,
): string[] {
  const errors: string[] = [];
  if (review.repository !== inventory.repository) errors.push('review.repository does not match inventory');
  if (review.from !== inventory.from) errors.push('review.from does not match the canonical pin');
  if (review.to !== inventory.to) errors.push('review.to does not match the candidate commit');
  if (review.inventorySha256 !== inventoryHash(inventory)) errors.push('review inventory hash is stale');

  const expectedItems = new Map<string, { target: TargetName; files: readonly MappedFile[] }>();
  const expectedUnmapped = new Set<string>();
  for (const commit of inventory.commits) {
    for (const target of ['sdk', 'server'] as const) {
      const unit = commit.units[target];
      if (unit !== undefined) expectedItems.set(unitId(commit.sha, target), { target, files: unit.files });
    }
    for (const path of commit.unmappedPaths) expectedUnmapped.add(unmappedId(commit.sha, path));
  }

  for (const key of expectedItems.keys()) {
    if (!(key in review.items)) errors.push(`missing review item ${key}`);
  }
  for (const key of Object.keys(review.items)) {
    if (!expectedItems.has(key)) errors.push(`stale or unknown review item ${key}`);
  }
  for (const key of expectedUnmapped) {
    const reason = review.unmapped[key];
    if (!meaningful(reason)) errors.push(`unmapped path ${key} needs an explanation or manifest mapping`);
  }
  for (const key of Object.keys(review.unmapped)) {
    if (!expectedUnmapped.has(key)) errors.push(`stale or unknown unmapped-path entry ${key}`);
  }

  for (const [key, expected] of expectedItems) {
    const item = review.items[key];
    if (item === undefined) continue;
    validateItem(key, item, expected.target, expected.files, manifest, phase, errors);
  }
  return errors;
}

function validateItem(
  key: string,
  item: ReviewItem,
  target: TargetName,
  files: readonly MappedFile[],
  manifest: UpstreamManifest,
  phase: CheckPhase,
  errors: string[],
): void {
  if (item.disposition === null) {
    errors.push(`${key} has no disposition`);
    return;
  }
  if (!DISPOSITIONS.includes(item.disposition)) {
    errors.push(`${key} has an invalid disposition`);
    return;
  }
  if (!meaningful(item.reason)) errors.push(`${key} needs a concrete reason`);
  if (item.docsImpact === null || !DOCS_IMPACTS.includes(item.docsImpact)) {
    errors.push(`${key} must classify documentation impact`);
  } else if (item.docsImpact === 'update' && item.docs.length === 0) {
    errors.push(`${key} says docs need updating but lists no docs`);
  }

  if (item.disposition === 'DEVIATION' || item.disposition === 'EXCLUDED') {
    if (item.policy === null) {
      errors.push(`${key} must reference a policy ID`);
    } else {
      const policy = policyById(manifest, item.policy);
      const expectedKind = item.disposition;
      if (policy === undefined) errors.push(`${key} references unknown policy ${item.policy}`);
      else if (policy.kind !== expectedKind) errors.push(`${key} policy ${item.policy} is ${policy.kind}, not ${expectedKind}`);
      else if (policy.target !== target) errors.push(`${key} policy ${item.policy} belongs to ${policy.target}, not ${target}`);
      else if (item.disposition === 'EXCLUDED' && !files.every((file) => fileMatchesPolicy(file, policy))) {
        errors.push(`${key} cannot be EXCLUDED: at least one changed file lies outside ${item.policy}`);
      }
    }
  } else if (item.policy !== null) {
    errors.push(`${key} must not attach policy ${item.policy} to ${item.disposition}`);
  }

  if (item.disposition === 'DEFERRED') {
    if (item.tracking.length === 0) errors.push(`${key} DEFERRED work needs a tracking item`);
    if (!meaningful(item.compatibilityConsequence)) errors.push(`${key} DEFERRED work needs a compatibility consequence`);
    if (!meaningful(item.revisitTrigger)) errors.push(`${key} DEFERRED work needs a revisit trigger`);
  } else {
    if (item.compatibilityConsequence !== null) errors.push(`${key} has a compatibility consequence but is not DEFERRED`);
    if (item.revisitTrigger !== null) errors.push(`${key} has a revisit trigger but is not DEFERRED`);
  }

  if (phase === 'close' && item.disposition === 'PORT' && item.evidence.length === 0) {
    errors.push(`${key} PORT work needs target evidence before closure`);
  }
}

function parseReview(value: unknown): DriftReview {
  const root = object(value, 'review');
  if (root.schemaVersion !== 1) throw new Error('review.schemaVersion must equal 1');
  const itemsObject = object(root.items, 'review.items');
  const items: Record<string, ReviewItem> = {};
  for (const [key, rawValue] of Object.entries(itemsObject)) {
    const raw = object(rawValue, `review.items.${key}`);
    items[key] = {
      disposition: nullableEnum(raw.disposition, DISPOSITIONS, `review.items.${key}.disposition`),
      reason: string(raw.reason, `review.items.${key}.reason`),
      policy: nullableString(raw.policy, `review.items.${key}.policy`),
      tracking: stringArray(raw.tracking, `review.items.${key}.tracking`),
      evidence: stringArray(raw.evidence, `review.items.${key}.evidence`),
      compatibilityConsequence: nullableString(raw.compatibilityConsequence, `review.items.${key}.compatibilityConsequence`),
      revisitTrigger: nullableString(raw.revisitTrigger, `review.items.${key}.revisitTrigger`),
      docsImpact: nullableEnum(raw.docsImpact, DOCS_IMPACTS, `review.items.${key}.docsImpact`),
      docs: stringArray(raw.docs, `review.items.${key}.docs`),
    };
  }
  const unmappedObject = object(root.unmapped, 'review.unmapped');
  const unmapped: Record<string, string | null> = {};
  for (const [key, rawValue] of Object.entries(unmappedObject)) {
    unmapped[key] = nullableString(rawValue, `review.unmapped.${key}`);
  }
  return {
    schemaVersion: 1,
    repository: nonEmptyString(root.repository, 'review.repository'),
    from: fullSha(root.from, 'review.from'),
    to: fullSha(root.to, 'review.to'),
    inventorySha256: hash(root.inventorySha256, 'review.inventorySha256'),
    items,
    unmapped,
  };
}

function emptyReviewItem(): ReviewItem {
  return {
    disposition: null,
    reason: '',
    policy: null,
    tracking: [],
    evidence: [],
    compatibilityConsequence: null,
    revisitTrigger: null,
    docsImpact: null,
    docs: [],
  };
}

function meaningful(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length >= 4;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.trim() === '') throw new Error(`${label} must not be empty`);
  return result;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${label} must be a string array`);
  return [...value];
}

function nullableEnum<T extends string>(value: unknown, values: readonly T[], label: string): T | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`${label} has an invalid value`);
  return value as T;
}

function fullSha(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${label} must be a full Git SHA`);
  return result;
}

function hash(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${label} must be a SHA-256 hash`);
  return result;
}
