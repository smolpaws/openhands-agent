# Upstream Drift Tooling

> Status: control plane and weekly watcher implemented; differential oracles remain follow-up work.

This document describes the machinery that keeps the two TypeScript transpiles in a deliberate relationship with `OpenHands/software-agent-sdk`:

- `smolpaws/openhands-agent` for `openhands-sdk`, `openhands-tools`, and `openhands-workspace`;
- `smolpaws/smolpaws/packages/openhands-agent-server` for the Python agent-server package.

The drift system answers:

> What changed upstream since our canonical pin, and has every relevant change received an explicit disposition?

It does **not** claim behavioral parity. Python/TypeScript OpenAPI comparisons, wire goldens, and scenario differentials provide that evidence.

## Principles

1. **One pin and one weekly clock.** `smolpaws/openhands-agent` owns the canonical manifest, drift CLI, and scheduled workflow. The server consumes the packaged/vendored manifest.
2. **Finite intervals only.** Reconciliation happens over `OLD_PIN..NEW_PIN`. A moving upstream branch may be observed by the watcher, but it is never the unit of implementation work.
3. **Generate facts; review semantics.** Git history, changed paths, tests, examples, target ownership, and policy hints are generated. Humans or agents assign dispositions and reasons.
4. **No mutable global parity ledger.** Each chosen pin advance gets one finite review file that freezes as historical evidence.
5. **Unknown stays visible.** Unmapped paths, missing policy IDs, incomplete annotations, and stale review files fail validation.
6. **Tests remain the proof.** Drift tooling proves review completeness. Differential/golden tests prove compatibility.

## Implemented files

```text
transpile/upstream.json           canonical repository, pin, scope and policy hints
scripts/drift/cli.ts              scan / prepare / check entry point
scripts/drift/git.ts              local git adapter
scripts/drift/inventory.ts        deterministic change inventory
scripts/drift/manifest.ts         manifest validation
scripts/drift/review.ts           review template + phase validation
scripts/drift/render.ts           generated Markdown view
scripts/drift/drift.node-test.ts  synthetic-repository tests
tsconfig.drift.json               strict tooling typecheck
.github/workflows/upstream-drift.yml
```

The CLI has no network code. It receives a local upstream checkout, which keeps the core deterministic and testable without GitHub.

## Canonical source manifest

`transpile/upstream.json` is the only authored upstream pin.

It records:

- upstream repository and full commit SHA;
- source, test, and example prefixes for both targets;
- explicitly shared root/test-infrastructure paths;
- repository-only paths that are intentionally ignored;
- the small `DEV-*`, `EXC-*`, and `EXT-*` policy registry plus path hints.

The manifest is included in the npm package. SmolPaws vendoring preserves the exact file under:

```text
packages/openhands-agent-server/vendor/openhands-agent/transpile/upstream.json
```

Contracts and scripts should read the manifest rather than copying its SHA into prose or code.

Path hints do not automatically decide a disposition. A commit touching a security path still appears for review, and a mixed plugin/core commit cannot be blanket-excluded.

## Commands

### Scan current drift

```sh
npm run drift:scan -- \
  --upstream ../software-agent-sdk \
  --to HEAD \
  --json .drift/inventory.json \
  --markdown .drift/report.md
```

`scan` resolves both refs to full SHAs and emits deterministic JSON plus Markdown containing:

- pin and candidate SHAs/dates;
- total and first-parent commit counts;
- first-parent commits in order;
- added, modified, deleted, copied, and renamed paths;
- SDK/server target buckets;
- subsystem/module summaries;
- changed tests and examples;
- policy hints;
- explicitly ignored repository paths;
- unmapped paths requiring explanation or a manifest change.

`scan` is factual. It never assigns `PORT`, `NO_TARGET_CHANGE`, `DEVIATION`, `EXCLUDED`, or `DEFERRED`.

### Prepare a bounded review

```sh
npm run drift:prepare -- \
  --upstream ../software-agent-sdk \
  --to <full-candidate-sha> \
  --out transpile/updates/9663409..abcdef0.json
```

`prepare` requires a full immutable SHA and writes three sibling files:

```text
<name>.json            editable semantic review
<name>.inventory.json  generated factual inventory
<name>.md              generated human-readable report
```

The normal review unit is **first-parent commit × target**. A commit touching both SDK and server creates two items.

A review item contains only decisions/evidence:

```json
{
  "disposition": "PORT",
  "reason": "Conversation error propagation changed.",
  "policy": null,
  "tracking": ["openhands-agent-..."],
  "evidence": ["src/conversation/__tests__/..."],
  "compatibilityConsequence": null,
  "revisitTrigger": null,
  "docsImpact": "update",
  "docs": ["enyst.github.io/arch/..."]
}
```

The review stores a SHA-256 of its generated inventory so later validation catches a stale or hand-edited factual basis.

### Validate review or closure

```sh
npm run drift:check -- \
  --upstream ../software-agent-sdk \
  --review transpile/updates/9663409..abcdef0.json \
  --phase review

npm run drift:check -- \
  --upstream ../software-agent-sdk \
  --review transpile/updates/9663409..abcdef0.json \
  --phase close
```

Both phases regenerate the interval from git and verify that:

- `from` equals the canonical manifest pin;
- `to` resolves to the recorded full SHA and descends from `from`;
- the inventory hash is current;
- every generated unit has exactly one annotation;
- no stale/unknown annotation remains;
- every unmapped path has an explanation;
- `NO_TARGET_CHANGE` has a concrete reason;
- `DEVIATION` and `EXCLUDED` use a known policy for the correct target;
- `EXCLUDED` covers every changed file in that unit, preventing mixed commits from being filtered wholesale;
- `DEFERRED` has tracking, a compatibility consequence, and a revisit trigger;
- documentation impact is explicitly classified;
- `PORT` has target evidence before the `close` phase succeeds.

The checker cannot judge whether a reason is wise. It makes omissions and stale bookkeeping difficult to hide.

## Dispositions and policies

Review dispositions respond to upstream changes:

- `PORT`
- `NO_TARGET_CHANGE`
- `DEVIATION`
- `EXCLUDED`
- `DEFERRED`

Stable policy IDs describe human decisions:

- `DEV-*` intentional alternative behavior that must still be reviewed when upstream moves;
- `EXC-*` whole subsystems outside scope;
- `EXT-*` target-only additive behavior, used by later differential allowlists rather than as an upstream-change disposition.

An exclusion is broader than a deviation operationally. `EXCLUDED` changes can be filtered only when the entire review unit lies within that exclusion. `DEVIATION` changes remain review-relevant because they may affect the alternative implementation or shared contracts.

## Tests

The first slice uses Node's built-in test runner with real temporary git repositories:

```sh
npm run test:drift
npm run typecheck:drift
```

Coverage includes:

- source/test/example target mapping;
- policy hints;
- ignored and unmapped paths;
- review versus closure validation;
- mandatory `PORT` evidence;
- exclusion boundaries for mixed commits;
- stale inventory hashes.

CI runs these checks alongside the existing SDK suite, typecheck, lint, and build.

## Weekly watcher

`.github/workflows/upstream-drift.yml` runs every Monday and via manual dispatch.

It:

1. checks out this repo and the full upstream repository;
2. installs the SDK repo dependencies;
3. runs `drift:scan` from the canonical pin to the observed upstream checkout;
4. writes the report into the Actions job summary;
5. uploads JSON and Markdown artifacts;
6. creates or updates one current drift issue when Issues are enabled.

Forks may have Issues disabled. In that case the workflow deliberately falls back to the Actions summary and artifact rather than failing. When the same workflow lands in a repository with Issues enabled, the single issue becomes an alarm panel, not historical evidence.

The watcher never creates one issue or Bead per changed module. Work items are created only after a concrete candidate interval is selected and reviewed.

## Server consumption

The server repo does not own another pin or schedule.

Its vendored SDK contains `transpile/upstream.json`, and server scripts read that file for the current pin. Server CI verifies the vendored manifest exists and is internally valid. Later parity artifacts, beginning with the Python OpenAPI oracle, must identify the same commit.

The existing hand-written route inventory is transitional. It now reads its displayed pin from the vendored manifest, but it remains circular until the generated Python OpenAPI comparison replaces it.

## Remaining differential work

### Python agent-server OpenAPI oracle

Generate `api.openapi()` from the pinned Python checkout, canonicalize it, and compare it with TypeScript OpenAPI using a small policy/extension allowlist.

Land this in two slices:

1. operation parity: paths, methods, parameters/media types, status codes, stale/unknown exceptions;
2. schema parity: canonical request/response semantics with equivalent JSON Schema encodings normalized.

Then delete the hand-typed upstream route list.

### SDK wire goldens

Run Python and TypeScript over language-neutral deterministic fixtures for:

- event JSON;
- `eventsToMessages` projections;
- tool schemas;
- settings/profile serialization;
- conversation restore;
- remote protocol payloads;
- deterministic condenser/view transformations.

### Server scenario differential

Run pinned Python and TypeScript servers with deterministic fake/TestLLM behavior, normalize IDs/timestamps/environment metadata, and compare response meaning, events, execution transitions, and error classes.

Provider live smokes stay separate. They prove external API viability, not Python parity.

## Cross-repo pin advance

“Lockstep” means one reviewed interval and the same final upstream SHA, not an impossible atomic commit across repositories.

A normal batch is:

1. select `NEW_PIN`;
2. prepare/classify the interval in the SDK repo;
3. port SDK `PORT` items tests-first and regenerate SDK evidence;
4. update/package the canonical manifest;
5. vendor that SDK state into SmolPaws;
6. port server `PORT` items tests-first;
7. regenerate Python OpenAPI and run server evidence;
8. verify all provenance/oracle pins agree;
9. pass `drift:check --phase close` and freeze the interval record.

During coordinated work the repos may temporarily differ, but the server must not claim a new pin until its vendored SDK and parity artifacts match.

## Documentation rule

The contracts are policy. This file describes tooling. Weekly reports are generated operational state. Reviewed interval files are immutable historical evidence.

Public `enyst.github.io` architecture pages are explanatory snapshots. When implementation passes them, add a historical/superseded banner or update their status, and link back to current contracts/designs. Do not copy weekly counts or mutable parity totals into the public site.
