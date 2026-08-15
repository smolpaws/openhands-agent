import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { GitRepository } from './git.js';
import { generateInventory, unitId, unmappedId } from './inventory.js';
import { parseManifest } from './manifest.js';
import { inventoryHash, prepareReview, validateReview } from './review.js';
import type { DriftReview, UpstreamManifest } from './types.js';

const manifestTemplate = (commit: string): UpstreamManifest => parseManifest({
  schemaVersion: 1,
  repository: 'example/upstream',
  commit,
  targets: {
    sdk: {
      sourcePrefixes: ['openhands-sdk/'],
      testPrefixes: ['tests/sdk/'],
      examplePrefixes: ['examples/sdk/'],
    },
    server: {
      sourcePrefixes: ['openhands-agent-server/'],
      testPrefixes: ['tests/server/'],
      examplePrefixes: ['examples/server/'],
    },
  },
  sharedPaths: [],
  ignorePrefixes: ['.github/'],
  ignorePaths: ['README.md'],
  policies: [
    {
      id: 'EXC-SDK-001',
      kind: 'EXCLUDED',
      target: 'sdk',
      prefixes: ['openhands-sdk/plugin/', 'tests/sdk/plugin/'],
      paths: [],
    },
    {
      id: 'DEV-SDK-001',
      kind: 'DEVIATION',
      target: 'sdk',
      prefixes: ['openhands-sdk/security/'],
      paths: [],
    },
    {
      id: 'EXT-SERVER-001',
      kind: 'EXTENSION',
      target: 'server',
      prefixes: [],
      paths: [],
    },
  ],
});

test('inventory maps target files, policy hints, ignored paths, and unmapped paths', async () => {
  const fixture = await createFixture();
  try {
    await put(fixture.path, 'openhands-sdk/conversation/base.py', 'base v2\n');
    await put(fixture.path, 'tests/sdk/conversation/test_base.py', 'test\n');
    await put(fixture.path, 'openhands-sdk/plugin/loader.py', 'plugin\n');
    await put(fixture.path, 'mystery.txt', 'unknown\n');
    const sdkCommit = commit(fixture.path, 'feat: update sdk');

    await put(fixture.path, 'openhands-agent-server/event_router.py', 'router\n');
    await put(fixture.path, 'tests/server/test_events.py', 'test\n');
    const serverCommit = commit(fixture.path, 'feat: update server');

    const inventory = generateInventory(new GitRepository(fixture.path), manifestTemplate(fixture.pin), 'HEAD');
    assert.equal(inventory.to, serverCommit);
    assert.equal(inventory.firstParentCommits, 2);
    assert.equal(inventory.totalCommits, 2);

    const first = inventory.commits[0];
    assert.equal(first?.sha, sdkCommit);
    assert.deepEqual(first?.ignoredPaths, []);
    assert.deepEqual(first?.unmappedPaths, ['mystery.txt']);
    assert.deepEqual(first?.units.sdk?.modules, ['conversation', 'plugin']);
    assert.deepEqual(first?.units.sdk?.policyHints, ['EXC-SDK-001']);
    assert.equal(first?.units.sdk?.files.filter((file) => file.kind === 'test').length, 1);

    const second = inventory.commits[1];
    assert.equal(second?.sha, serverCommit);
    assert.deepEqual(second?.units.server?.modules, ['event', 'test_events']);
    assert.equal(inventory.summary.targets.sdk.commitUnits, 1);
    assert.equal(inventory.summary.targets.server.commitUnits, 1);
  } finally {
    await rm(fixture.path, { recursive: true, force: true });
  }
});

test('review validation distinguishes review completeness from close evidence', async () => {
  const fixture = await createFixture();
  try {
    await put(fixture.path, 'openhands-sdk/conversation/base.py', 'base v2\n');
    await put(fixture.path, 'mystery.txt', 'unknown\n');
    const changed = commit(fixture.path, 'feat: observable change');
    const manifest = manifestTemplate(fixture.pin);
    const inventory = generateInventory(new GitRepository(fixture.path), manifest, changed);
    const review = prepareReview(inventory);
    const key = unitId(changed, 'sdk');
    const item = review.items[key];
    assert.ok(item);
    item.disposition = 'PORT';
    item.reason = 'Observable conversation behavior changed.';
    item.docsImpact = 'none';
    review.unmapped[unmappedId(changed, 'mystery.txt')] = 'Repository fixture used only by the upstream test harness.';

    assert.deepEqual(validateReview(inventory, review, manifest, 'review'), []);
    assert.ok(validateReview(inventory, review, manifest, 'close').some((error) => error.includes('target evidence')));

    item.evidence.push('src/conversation/__tests__/base.test.ts');
    assert.deepEqual(validateReview(inventory, review, manifest, 'close'), []);
  } finally {
    await rm(fixture.path, { recursive: true, force: true });
  }
});

test('EXCLUDED is accepted only when every changed file is inside the exclusion', async () => {
  const fixture = await createFixture();
  try {
    await put(fixture.path, 'openhands-sdk/plugin/loader.py', 'plugin\n');
    await put(fixture.path, 'tests/sdk/plugin/test_loader.py', 'test\n');
    const pluginOnly = commit(fixture.path, 'feat: plugin only');
    const manifest = manifestTemplate(fixture.pin);
    const repository = new GitRepository(fixture.path);
    const inventory = generateInventory(repository, manifest, pluginOnly);
    const review = prepareReview(inventory);
    const item = review.items[unitId(pluginOnly, 'sdk')];
    assert.ok(item);
    item.disposition = 'EXCLUDED';
    item.reason = 'Plugin runtime is outside the declared transpilation scope.';
    item.policy = 'EXC-SDK-001';
    item.docsImpact = 'none';
    assert.deepEqual(validateReview(inventory, review, manifest, 'close'), []);

    await put(fixture.path, 'openhands-sdk/conversation/base.py', 'core too\n');
    const mixed = commit(fixture.path, 'feat: plugin and core');
    const mixedInventory = generateInventory(repository, manifest, mixed);
    const mixedReview = prepareReview(mixedInventory);
    for (const reviewItem of Object.values(mixedReview.items)) {
      reviewItem.disposition = 'EXCLUDED';
      reviewItem.reason = 'Attempted blanket exclusion.';
      reviewItem.policy = 'EXC-SDK-001';
      reviewItem.docsImpact = 'none';
    }
    assert.ok(validateReview(mixedInventory, mixedReview, manifest, 'close').some((error) => error.includes('outside EXC-SDK-001')));
  } finally {
    await rm(fixture.path, { recursive: true, force: true });
  }
});

test('stale inventory hashes are rejected', async () => {
  const fixture = await createFixture();
  try {
    await put(fixture.path, 'openhands-sdk/conversation/base.py', 'v2\n');
    const changed = commit(fixture.path, 'feat: change');
    const manifest = manifestTemplate(fixture.pin);
    const inventory = generateInventory(new GitRepository(fixture.path), manifest, changed);
    const review: DriftReview = prepareReview(inventory);
    assert.equal(review.inventorySha256, inventoryHash(inventory));
    (review as { inventorySha256: string }).inventorySha256 = '0'.repeat(64);
    assert.ok(validateReview(inventory, review, manifest, 'review').includes('review inventory hash is stale'));
  } finally {
    await rm(fixture.path, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<{ path: string; pin: string }> {
  const path = await mkdtemp(join(tmpdir(), 'drift-test-'));
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'drift@example.test']);
  git(path, ['config', 'user.name', 'Drift Test']);
  await put(path, 'openhands-sdk/conversation/base.py', 'base\n');
  await put(path, 'README.md', 'ignored\n');
  const pin = commit(path, 'init');
  return { path, pin };
}

async function put(repository: string, relative: string, content: string): Promise<void> {
  const path = join(repository, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function commit(repository: string, message: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-q', '-m', message]);
  return git(repository, ['rev-parse', 'HEAD']);
}

function git(repository: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repository, encoding: 'utf8' }).trim();
}
