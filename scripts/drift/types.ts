export type TargetName = 'sdk' | 'server';

export interface TargetConfig {
  readonly sourcePrefixes: readonly string[];
  readonly testPrefixes: readonly string[];
  readonly examplePrefixes: readonly string[];
}

export type PolicyKind = 'DEVIATION' | 'EXCLUDED' | 'EXTENSION';

export interface PolicyConfig {
  readonly id: string;
  readonly kind: PolicyKind;
  readonly target: TargetName;
  readonly prefixes: readonly string[];
  readonly paths: readonly string[];
}

export interface SharedPathConfig {
  readonly path: string;
  readonly targets: readonly TargetName[];
  readonly module: string;
}

export interface UpstreamManifest {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly commit: string;
  readonly targets: Readonly<Record<TargetName, TargetConfig>>;
  readonly sharedPaths: readonly SharedPathConfig[];
  readonly ignorePrefixes: readonly string[];
  readonly ignorePaths: readonly string[];
  readonly policies: readonly PolicyConfig[];
}

export interface ChangedFile {
  readonly status: string;
  readonly path: string;
  readonly previousPath: string | null;
}

export type FileKind = 'source' | 'test' | 'example' | 'shared';

export interface MappedFile extends ChangedFile {
  readonly target: TargetName;
  readonly kind: FileKind;
  readonly module: string;
  readonly policyHints: readonly string[];
}

export interface TargetUnit {
  readonly target: TargetName;
  readonly files: readonly MappedFile[];
  readonly modules: readonly string[];
  readonly policyHints: readonly string[];
}

export interface CommitInventory {
  readonly sha: string;
  readonly authoredAt: string;
  readonly subject: string;
  readonly units: Readonly<Partial<Record<TargetName, TargetUnit>>>;
  readonly ignoredPaths: readonly string[];
  readonly unmappedPaths: readonly string[];
}

export interface DriftSummary {
  readonly targets: Readonly<Record<TargetName, {
    readonly commitUnits: number;
    readonly files: number;
    readonly modules: readonly string[];
    readonly tests: number;
    readonly examples: number;
    readonly policyHints: readonly string[];
  }>>;
  readonly ignoredPaths: readonly string[];
  readonly unmappedPaths: readonly string[];
}

export interface DriftInventory {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly from: string;
  readonly to: string;
  readonly fromAuthoredAt: string;
  readonly toAuthoredAt: string;
  readonly totalCommits: number;
  readonly firstParentCommits: number;
  readonly commits: readonly CommitInventory[];
  readonly summary: DriftSummary;
}

export type Disposition =
  | 'PORT'
  | 'NO_TARGET_CHANGE'
  | 'DEVIATION'
  | 'EXCLUDED'
  | 'DEFERRED';

export type DocsImpact = 'none' | 'update';

export interface ReviewItem {
  disposition: Disposition | null;
  reason: string;
  policy: string | null;
  tracking: string[];
  evidence: string[];
  compatibilityConsequence: string | null;
  revisitTrigger: string | null;
  docsImpact: DocsImpact | null;
  docs: string[];
}

export interface DriftReview {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly from: string;
  readonly to: string;
  readonly inventorySha256: string;
  readonly items: Record<string, ReviewItem>;
  readonly unmapped: Record<string, string | null>;
}

export type CheckPhase = 'review' | 'close';
