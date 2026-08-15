#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { GitRepository } from './git.js';
import { generateInventory } from './inventory.js';
import { loadManifest } from './manifest.js';
import { loadReview, prepareReview, validateReview, writeReview } from './review.js';
import { renderMarkdown } from './render.js';
import type { CheckPhase } from './types.js';

const FULL_SHA = /^[0-9a-f]{40}$/;

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  const args = parseArgs(rest);
  const manifestPath = resolve(args.get('--manifest') ?? 'transpile/upstream.json');
  const upstreamPath = required(args, '--upstream');
  const manifest = await loadManifest(manifestPath);
  const repository = new GitRepository(upstreamPath);

  switch (command) {
    case 'scan': {
      const inventory = generateInventory(repository, manifest, args.get('--to') ?? 'HEAD');
      const markdown = renderMarkdown(inventory);
      const jsonPath = args.get('--json');
      const markdownPath = args.get('--markdown');
      if (jsonPath !== undefined) await writeJson(jsonPath, inventory);
      if (markdownPath !== undefined) await writeText(markdownPath, markdown);
      if (markdownPath === undefined) process.stdout.write(markdown);
      return;
    }
    case 'prepare': {
      const to = required(args, '--to');
      if (!FULL_SHA.test(to)) throw new Error('--to must be an immutable full 40-character commit SHA');
      const reviewPath = resolve(required(args, '--out'));
      const inventory = generateInventory(repository, manifest, to);
      const review = prepareReview(inventory);
      await mkdir(dirname(reviewPath), { recursive: true });
      await writeReview(reviewPath, review);
      await writeJson(sibling(reviewPath, '.inventory.json'), inventory);
      await writeText(sibling(reviewPath, '.md'), renderMarkdown(inventory, review));
      process.stdout.write(`Prepared ${reviewPath}\n`);
      return;
    }
    case 'check': {
      const reviewPath = resolve(required(args, '--review'));
      const review = await loadReview(reviewPath);
      const phase = parsePhase(args.get('--phase') ?? 'review');
      const inventory = generateInventory(repository, manifest, review.to);
      const errors = validateReview(inventory, review, manifest, phase);
      const reportPath = args.get('--markdown');
      if (reportPath !== undefined) await writeText(reportPath, renderMarkdown(inventory, review));
      if (errors.length > 0) {
        for (const error of errors) process.stderr.write(`- ${error}\n`);
        throw new Error(`drift review failed ${errors.length} validation check${errors.length === 1 ? '' : 's'}`);
      }
      process.stdout.write(`Drift review is valid for phase ${phase}: ${review.from}..${review.to}\n`);
      return;
    }
    default:
      throw new Error(`unknown drift command: ${command}`);
  }
}

function parseArgs(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`expected --name value pairs, got: ${values.slice(index).join(' ')}`);
    }
    if (result.has(key)) throw new Error(`duplicate argument ${key}`);
    result.set(key, value);
  }
  return result;
}

function required(args: ReadonlyMap<string, string>, key: string): string {
  const value = args.get(key);
  if (value === undefined || value.trim() === '') throw new Error(`${key} is required`);
  return value;
}

function parsePhase(value: string): CheckPhase {
  if (value !== 'review' && value !== 'close') throw new Error('--phase must be review or close');
  return value;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, value);
}

function sibling(path: string, suffix: string): string {
  return path.endsWith('.json') ? `${path.slice(0, -5)}${suffix}` : `${path}${suffix}`;
}

function printHelp(): void {
  process.stdout.write(`Usage:\n  drift scan --upstream PATH [--to REF] [--json PATH] [--markdown PATH]\n  drift prepare --upstream PATH --to FULL_SHA --out REVIEW.json\n  drift check --upstream PATH --review REVIEW.json [--phase review|close]\n\nOptions:\n  --manifest PATH   Defaults to transpile/upstream.json\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`drift: ${message}\n`);
  process.exitCode = 1;
});
