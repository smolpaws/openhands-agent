import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const options = parseArgs(process.argv.slice(2));
const reviewPath = resolve(options.review);
const outputPath = resolve(options.output);
const review = asRecord(JSON.parse(await readFile(reviewPath, 'utf8')) as unknown, 'review');
const items = isRecord(review.items) ? review.items : {};
const lines: string[] = [
  '# Bounded upstream review',
  '',
  `**From:** \`${readOptionalString(review.from) ?? '<unknown>'}\`  `,
  `**To:** \`${readOptionalString(review.to) ?? '<unknown>'}\``,
  '',
  '> Generated view. Edit semantic annotations in the JSON review record, then regenerate this page.',
  '',
  `## Review units (${Object.keys(items).length})`,
  '',
];

for (const id of Object.keys(items).sort()) {
  const item = isRecord(items[id]) ? items[id] : {};
  const commit = isRecord(item.commit) ? item.commit : {};
  const subject = firstDefinedString(
    commit.subject,
    commit.message,
    item.subject,
    item.message,
  );
  const target = readOptionalString(item.target) ?? inferTarget(id) ?? 'unknown';
  const disposition = readOptionalString(item.disposition) ?? 'UNCLASSIFIED';
  const policy = readOptionalString(item.policy);
  const reason = readOptionalString(item.reason);
  const paths = collectPaths(item);
  const hints = collectPolicyHints(item);

  lines.push(`### \`${id}\``, '');
  lines.push(`- **Target:** ${target}`);
  lines.push(`- **Disposition:** \`${disposition}\``);
  if (policy !== undefined) lines.push(`- **Policy:** \`${policy}\``);
  if (subject !== undefined) lines.push(`- **Upstream:** ${subject.split('\n')[0]}`);
  if (hints.length > 0) {
    lines.push(`- **Policy hints:** ${hints.map((hint) => `\`${hint}\``).join(', ')}`);
  }
  if (reason !== undefined) lines.push(`- **Reason:** ${reason}`);
  if (paths.length > 0) {
    lines.push('- **Changed paths:**');
    for (const path of paths.slice(0, 60)) lines.push(`  - \`${path}\``);
    if (paths.length > 60) lines.push(`  - … ${paths.length - 60} more`);
  }
  lines.push('');
}

await writeFile(outputPath, `${lines.join('\n')}\n`);
console.log(`Wrote ${outputPath} (${Object.keys(items).length} review units)`);

function parseArgs(args: readonly string[]): {
  readonly review: string;
  readonly output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || !name.startsWith('--')) {
      throw new Error('Usage: --review <review.json> --output <review.md>');
    }
    values.set(name.slice(2), value);
  }
  const review = values.get('review');
  const output = values.get('output');
  if (review === undefined || output === undefined) {
    throw new Error('Usage: --review <review.json> --output <review.md>');
  }
  return { review, output };
}

function collectPaths(value: unknown): string[] {
  const found = new Set<string>();
  walk(value, '', (key, entry) => {
    if (typeof entry !== 'string') return;
    const normalizedKey = key.toLowerCase();
    if ((normalizedKey.includes('path') || normalizedKey.includes('file')) && entry.includes('/')) {
      found.add(entry);
    }
  });
  return [...found].sort();
}

function collectPolicyHints(value: unknown): string[] {
  const found = new Set<string>();
  walk(value, '', (key, entry) => {
    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.includes('hint') && !normalizedKey.includes('polic')) return;
    if (typeof entry === 'string' && /^(DEV|EXC|EXT)-/u.test(entry)) found.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === 'string' && /^(DEV|EXC|EXT)-/u.test(item)) found.add(item);
      }
    }
  });
  return [...found].sort();
}

function walk(
  value: unknown,
  key: string,
  visit: (key: string, value: unknown) => void,
): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, key, visit);
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, entry] of Object.entries(value)) walk(entry, childKey, visit);
}

function inferTarget(id: string): string | undefined {
  if (id.endsWith(':sdk') || id.includes(':sdk:')) return 'sdk';
  if (id.endsWith(':server') || id.includes(':server:')) return 'server';
  return undefined;
}

function firstDefinedString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = readOptionalString(value);
    if (string !== undefined) return string;
  }
  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
