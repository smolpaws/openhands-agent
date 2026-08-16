import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import * as sdk from '../../src/index.js';

const casesSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    kind: z.literal('tool-definition'),
    name: z.string().min(1),
    description: z.string(),
    parameters: z.unknown(),
  }).strict()),
}).strict();

const oracleSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    repository: z.literal('OpenHands/software-agent-sdk'),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
  }).strict(),
  results: z.record(z.string(), z.unknown()),
}).strict();

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal('OpenHands/software-agent-sdk'),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
}).passthrough();

type RuntimeSchema = { parse(value: unknown): unknown };
type JsonValue = null | boolean | number | string | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

type Difference = {
  readonly path: string;
  readonly kind: 'missing-python' | 'missing-typescript' | 'value';
  readonly python?: JsonValue;
  readonly typescript?: JsonValue;
};

const toolDefinitionSchema = resolveToolDefinitionSchema();
const options = parseArgs(process.argv.slice(2));
const root = resolve(import.meta.dirname, '../..');
const manifest = manifestSchema.parse(await readJson(resolve(root, 'transpile/upstream.json')));
const cases = casesSchema.parse(await readJson(resolve(root, 'transpile/wire/tool-cases.json')));
const oracle = oracleSchema.parse(await readJson(resolve(root, 'transpile/wire/python-tool-oracle.json')));

if (oracle.source.commit !== manifest.commit) {
  throw new Error(
    `Python tool oracle is pinned to ${oracle.source.commit}, but the canonical manifest is ${manifest.commit}`,
  );
}

const caseIds = new Set<string>();
const mismatches: Record<string, {
  readonly python: JsonValue;
  readonly typescript: JsonValue;
  readonly differences: readonly Difference[];
}> = {};

for (const testCase of cases.cases) {
  if (caseIds.has(testCase.id)) throw new Error(`Duplicate tool case id: ${testCase.id}`);
  caseIds.add(testCase.id);
  const pythonValue = toJsonValue(oracle.results[testCase.id], `Python tool ${testCase.id}`);
  const parsed = toolDefinitionSchema.parse(pythonValue);
  const typescriptValue = canonicalize(
    toJsonValue(JSON.parse(JSON.stringify(parsed)) as unknown, `TypeScript tool ${testCase.id}`),
  );
  const differences: Difference[] = [];
  diffValue(pythonValue, typescriptValue, '', differences);
  if (differences.length > 0) {
    mismatches[testCase.id] = { python: pythonValue, typescript: typescriptValue, differences };
  }
}

for (const oracleCase of Object.keys(oracle.results)) {
  if (!caseIds.has(oracleCase)) throw new Error(`Python tool oracle contains stale case: ${oracleCase}`);
}

const output = {
  schemaVersion: 1,
  sourceCommit: manifest.commit,
  caseCount: cases.cases.length,
  mismatchCount: Object.keys(mismatches).length,
  mismatches,
};

if (options.report !== undefined) {
  const reportPath = resolve(root, options.report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`);
}

if (output.mismatchCount > 0) {
  console.error(
    `SDK tool-definition parity failed against OpenHands ${manifest.commit}: `
    + `${output.mismatchCount} of ${output.caseCount} cases differ.`,
  );
  for (const [caseId, mismatch] of Object.entries(mismatches)) {
    console.error(`\n${caseId}`);
    for (const difference of mismatch.differences.slice(0, 20)) {
      console.error(`  - ${difference.kind} at ${difference.path}`);
    }
  }
  process.exit(1);
}

console.log(
  `SDK tool-definition parity passed against OpenHands ${manifest.commit}: ${output.caseCount} cases match exactly.`,
);

function resolveToolDefinitionSchema(): RuntimeSchema {
  const exports = sdk as unknown as Record<string, unknown>;
  for (const name of ['toolDefinitionSchema', 'ToolDefinitionSchema']) {
    const candidate = exports[name];
    if (isRuntimeSchema(candidate)) return candidate;
  }
  throw new Error(
    `Could not resolve an exported ToolDefinition schema; available exports: ${Object.keys(exports).sort().join(', ')}`,
  );
}

function isRuntimeSchema(value: unknown): value is RuntimeSchema {
  return typeof value === 'object'
    && value !== null
    && 'parse' in value
    && typeof (value as { parse?: unknown }).parse === 'function';
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key] as JsonValue);
    return result;
  }
  return value;
}

function diffValue(
  pythonValue: JsonValue | undefined,
  typescriptValue: JsonValue | undefined,
  path: string,
  differences: Difference[],
): void {
  if (pythonValue === undefined && typescriptValue === undefined) return;
  if (pythonValue === undefined) {
    differences.push({ path: displayPath(path), kind: 'missing-python', typescript: typescriptValue as JsonValue });
    return;
  }
  if (typescriptValue === undefined) {
    differences.push({ path: displayPath(path), kind: 'missing-typescript', python: pythonValue });
    return;
  }
  if (Object.is(pythonValue, typescriptValue)) return;

  if (Array.isArray(pythonValue) || Array.isArray(typescriptValue)) {
    if (!Array.isArray(pythonValue) || !Array.isArray(typescriptValue)) {
      differences.push({ path: displayPath(path), kind: 'value', python: pythonValue, typescript: typescriptValue });
      return;
    }
    const length = Math.max(pythonValue.length, typescriptValue.length);
    for (let index = 0; index < length; index += 1) {
      diffValue(pythonValue[index], typescriptValue[index], `${path}/${index}`, differences);
    }
    return;
  }

  if (isObject(pythonValue) || isObject(typescriptValue)) {
    if (!isObject(pythonValue) || !isObject(typescriptValue)) {
      differences.push({ path: displayPath(path), kind: 'value', python: pythonValue, typescript: typescriptValue });
      return;
    }
    const keys = new Set([...Object.keys(pythonValue), ...Object.keys(typescriptValue)]);
    for (const key of [...keys].sort()) {
      diffValue(
        pythonValue[key],
        typescriptValue[key],
        `${path}/${escapePointer(key)}`,
        differences,
      );
    }
    return;
  }

  differences.push({ path: displayPath(path), kind: 'value', python: pythonValue, typescript: typescriptValue });
}

function toJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry, label));
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry, label);
    return canonicalize(result);
  }
  throw new Error(`${label} is not JSON-serializable`);
}

function isObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayPath(path: string): string {
  return path.length === 0 ? '/' : path;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function parseArgs(args: readonly string[]): { readonly report?: string } {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--report' && args[1] !== undefined) {
    return { report: args[1] };
  }
  throw new Error('Usage: check-tool-wire-parity.ts [--report <path>]');
}
