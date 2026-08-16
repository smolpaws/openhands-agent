import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const durableFiles = [
  'README.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/TRANSPILE_CONTRACT.md',
  'docs/DRIFT_TOOLING.md',
];
const errors: string[] = [];

for (const relativePath of durableFiles) {
  const content = await readFile(resolve(root, relativePath), 'utf8');
  if (content.includes('TRANSPILE_PLAN.md')) {
    errors.push(`${relativePath} still refers to retired TRANSPILE_PLAN.md`);
  }
  if (relativePath === 'docs/TRANSPILE_CONTRACT.md') {
    if (!content.includes('transpile/upstream.json')) {
      errors.push('TRANSPILE_CONTRACT.md does not point at the canonical manifest');
    }
    const literalPins = content.match(/\b[0-9a-f]{40}\b/gu) ?? [];
    if (literalPins.length > 0) {
      errors.push(
        `TRANSPILE_CONTRACT.md contains literal commit SHA(s): ${literalPins.join(', ')}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error('Durable documentation authority check failed:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log('Durable documentation points at the canonical manifest and contains no retired plan references.');
