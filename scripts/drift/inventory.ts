import type {
  ChangedFile,
  CommitInventory,
  DriftInventory,
  DriftSummary,
  FileKind,
  MappedFile,
  TargetName,
  TargetUnit,
  UpstreamManifest,
} from './types.js';
import { GitRepository } from './git.js';

const TARGET_NAMES: readonly TargetName[] = ['sdk', 'server'];

export function generateInventory(
  repository: GitRepository,
  manifest: UpstreamManifest,
  toRef: string,
): DriftInventory {
  const from = repository.resolveCommit(manifest.commit);
  const to = repository.resolveCommit(toRef);
  if (!repository.isAncestor(from, to)) {
    throw new Error(`candidate ${to} does not descend from manifest pin ${from}`);
  }

  const fromMeta = repository.commitMeta(from);
  const toMeta = repository.commitMeta(to);
  const commits = repository.firstParentCommits(from, to).map((sha) => {
    const meta = repository.commitMeta(sha);
    const parent = repository.firstParent(sha);
    return classifyCommit(meta, repository.changedFiles(parent, sha), manifest);
  });

  return {
    schemaVersion: 1,
    repository: manifest.repository,
    from,
    to,
    fromAuthoredAt: fromMeta.authoredAt,
    toAuthoredAt: toMeta.authoredAt,
    totalCommits: repository.countCommits(from, to),
    firstParentCommits: commits.length,
    commits,
    summary: summarize(commits),
  };
}

function classifyCommit(
  meta: { readonly sha: string; readonly authoredAt: string; readonly subject: string },
  changedFiles: readonly ChangedFile[],
  manifest: UpstreamManifest,
): CommitInventory {
  const buckets: Record<TargetName, MappedFile[]> = { sdk: [], server: [] };
  const ignoredPaths = new Set<string>();
  const unmappedPaths = new Set<string>();

  for (const file of changedFiles) {
    const mapped = mapFile(file, manifest);
    if (mapped.length > 0) {
      for (const item of mapped) buckets[item.target].push(item);
      continue;
    }
    const paths = file.previousPath === null ? [file.path] : [file.previousPath, file.path];
    const label = file.previousPath === null ? file.path : `${file.previousPath} -> ${file.path}`;
    if (paths.every((path) => isIgnored(path, manifest))) ignoredPaths.add(label);
    else unmappedPaths.add(label);
  }

  const units: Partial<Record<TargetName, TargetUnit>> = {};
  for (const target of TARGET_NAMES) {
    const files = buckets[target].sort(compareMappedFiles);
    if (files.length === 0) continue;
    units[target] = {
      target,
      files,
      modules: uniqueSorted(files.map((file) => file.module)),
      policyHints: uniqueSorted(files.flatMap((file) => file.policyHints)),
    };
  }

  return {
    sha: meta.sha,
    authoredAt: meta.authoredAt,
    subject: meta.subject,
    units,
    ignoredPaths: [...ignoredPaths].sort(),
    unmappedPaths: [...unmappedPaths].sort(),
  };
}

function mapFile(file: ChangedFile, manifest: UpstreamManifest): MappedFile[] {
  const paths = file.previousPath === null ? [file.path] : [file.previousPath, file.path];
  const matches = new Map<TargetName, { kind: FileKind; prefix: string; path: string }>();

  for (const target of TARGET_NAMES) {
    const config = manifest.targets[target];
    const candidates: Array<{ kind: FileKind; prefixes: readonly string[] }> = [
      { kind: 'source', prefixes: config.sourcePrefixes },
      { kind: 'test', prefixes: config.testPrefixes },
      { kind: 'example', prefixes: config.examplePrefixes },
    ];
    for (const path of paths) {
      for (const candidate of candidates) {
        const prefix = longestPrefix(path, candidate.prefixes);
        if (prefix !== null) {
          const existing = matches.get(target);
          if (existing === undefined || prefix.length > existing.prefix.length) {
            matches.set(target, { kind: candidate.kind, prefix, path });
          }
        }
      }
    }
  }

  for (const shared of manifest.sharedPaths) {
    if (!paths.includes(shared.path)) continue;
    for (const target of shared.targets) {
      if (!matches.has(target)) matches.set(target, { kind: 'shared', prefix: shared.path, path: shared.path });
    }
  }

  const result: MappedFile[] = [];
  for (const target of TARGET_NAMES) {
    const match = matches.get(target);
    if (match === undefined) continue;
    const shared = manifest.sharedPaths.find((entry) => entry.path === match.path && entry.targets.includes(target));
    result.push({
      ...file,
      target,
      kind: match.kind,
      module: shared?.module ?? deriveModule(target, match.kind, match.path, match.prefix),
      policyHints: manifest.policies
        .filter((policy) => policy.target === target && paths.some((path) => policyMatchesPath(policy, path)))
        .map((policy) => policy.id)
        .sort(),
    });
  }
  return result;
}

export function unitId(commitSha: string, target: TargetName): string {
  return `${commitSha}:${target}`;
}

export function unmappedId(commitSha: string, path: string): string {
  return `${commitSha}:${path}`;
}

function policyMatchesPath(
  policy: { readonly prefixes: readonly string[]; readonly paths: readonly string[] },
  path: string,
): boolean {
  return policy.paths.includes(path) || policy.prefixes.some((prefix) => path.startsWith(prefix));
}

export function fileMatchesPolicy(file: MappedFile, policy: { readonly prefixes: readonly string[]; readonly paths: readonly string[] }): boolean {
  const paths = file.previousPath === null ? [file.path] : [file.previousPath, file.path];
  return paths.every((path) => policyMatchesPath(policy, path));
}

function isIgnored(path: string, manifest: UpstreamManifest): boolean {
  return manifest.ignorePaths.includes(path) || manifest.ignorePrefixes.some((prefix) => path.startsWith(prefix));
}

function longestPrefix(path: string, prefixes: readonly string[]): string | null {
  let longest: string | null = null;
  for (const prefix of prefixes) {
    if (path.startsWith(prefix) && (longest === null || prefix.length > longest.length)) longest = prefix;
  }
  return longest;
}

function deriveModule(target: TargetName, kind: FileKind, path: string, matchedPrefix: string): string {
  if (kind === 'shared') return 'repository';
  if (target === 'sdk') {
    const roots = [
      'openhands-sdk/openhands/sdk/',
      'openhands-tools/openhands/tools/',
      'openhands-workspace/openhands/workspace/',
      'tests/sdk/',
      'tests/tools/',
      'tests/workspace/',
      'tests/integration/',
      'examples/01_standalone_sdk/',
    ];
    const root = longestPrefix(path, roots) ?? matchedPrefix;
    if (root.startsWith('openhands-workspace/')) return 'workspace';
    return firstPathPart(path.slice(root.length)) ?? 'root';
  }

  const roots = [
    'openhands-agent-server/openhands/agent_server/',
    'openhands-agent-server/',
    'tests/agent_server/',
    'tests/cross/',
    'examples/02_remote_agent_server/',
  ];
  const root = longestPrefix(path, roots) ?? matchedPrefix;
  const first = firstPathPart(path.slice(root.length)) ?? 'root';
  return first.replace(/\.(py|md|json|toml)$/, '').replace(/_(router|service)$/, '');
}

function firstPathPart(value: string): string | null {
  const part = value.split('/').find((item) => item !== '');
  if (part === undefined) return null;
  return part.replace(/\.[^.]+$/, '');
}

function summarize(commits: readonly CommitInventory[]): DriftSummary {
  const targetSummary = {} as Record<TargetName, DriftSummary['targets'][TargetName]>;
  for (const target of TARGET_NAMES) {
    const units = commits.flatMap((commit) => commit.units[target] === undefined ? [] : [commit.units[target]]);
    const files = units.flatMap((unit) => unit.files);
    targetSummary[target] = {
      commitUnits: units.length,
      files: files.length,
      modules: uniqueSorted(units.flatMap((unit) => unit.modules)),
      tests: files.filter((file) => file.kind === 'test').length,
      examples: files.filter((file) => file.kind === 'example').length,
      policyHints: uniqueSorted(units.flatMap((unit) => unit.policyHints)),
    };
  }
  return {
    targets: targetSummary,
    ignoredPaths: uniqueSorted(commits.flatMap((commit) => commit.ignoredPaths)),
    unmappedPaths: uniqueSorted(commits.flatMap((commit) => commit.unmappedPaths)),
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function compareMappedFiles(left: MappedFile, right: MappedFile): number {
  return left.path.localeCompare(right.path) || left.status.localeCompare(right.status);
}
