import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

const execFileAsync = promisify(execFile);

const packOutputSchema = z.array(z.object({
  files: z.array(z.object({ path: z.string() }).passthrough()),
}).passthrough()).min(1);

const { stdout } = await execFileAsync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--json'],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  },
);

const packs = packOutputSchema.parse(JSON.parse(String(stdout)) as unknown);
const files = new Set(packs[0]?.files.map((file) => file.path));
const required = [
  'package.json',
  'transpile/upstream.json',
  'dist/index.d.ts',
];
const missing = required.filter((path) => !files.has(path));

if (missing.length > 0) {
  console.error('Packed SDK is missing required provenance/runtime files:');
  for (const path of missing) console.error(`  - ${path}`);
  process.exit(1);
}

console.log('Packed SDK contains canonical upstream provenance and runtime entrypoints.');
