# Upstream Drift Tooling Design

> Status: design complete; implementation pending.

This document specifies the smallest durable system for noticing, reviewing, and closing upstream drift between `OpenHands/software-agent-sdk` and the two TypeScript transpiles:

- `enyst/openhands-agent` for the SDK-side packages;
- `enyst/smolpaws/packages/openhands-agent-server` for the Python agent-server package.

The goal is not to build a second project-management system. The goal is to make every bounded upstream interval mechanically visible, semantically reviewed, and backed by executable evidence before the pin moves.

## Design principles

1. **One owner and one weekly clock.** `enyst/openhands-agent` owns the source manifest, drift CLI, and scheduled workflow. The server repo consumes its pin/provenance and parity artifacts; it does not run a second independent drift watcher.
2. **Bounded intervals only.** Every review is `OLD_PIN..NEW_PIN`. Moving upstream `HEAD` may be a candidate ref, never the unit of work.
3. **Generate discovery; hand-review policy.** Commits, changed files, tests, examples, and OpenAPI operations are generated. Humans/agents assign semantic dispositions and write reasons.
4. **No global mutable parity ledger.** Permanent policy stays small. Each actual pin advance gets one finite review record, then freezes.
5. **Watch is not reconcile.** A weekly report says what changed since the pin. It does not authorize a pin bump or claim compatibility.
6. **Tests remain the proof.** Drift tooling establishes completeness of review. Differential/golden tests establish behavioral compatibility.
7. **Unknown means visible.** Unmapped paths, missing policy IDs, or unreviewed change units fail closure rather than disappearing into an “other” bucket.

## Non-goals

The first implementation will not:

- auto-port Python changes;
- infer semantic dispositions from commit messages;
- create one Bead/issue per changed module;
- compare nondeterministic live LLM output;
- move the upstream pin automatically;
- treat provider live smokes as parity evidence;
- duplicate source/pin state independently in both repos.

## Architecture

```text
OpenHands/software-agent-sdk
            │
            │ git OLD_PIN..NEW_PIN
            ▼
enyst/openhands-agent
  transpile/upstream.json       canonical source + pin + path map
  scripts/drift/                standalone deterministic CLI
  .github/workflows/
    upstream-drift.yml          the only weekly clock
  transpile/updates/            finite reviewed pin-advance records
            │
            ├──────── weekly scan → Actions summary/artifact + one current issue
            │
            └──────── candidate interval → review record + test work
                                         │
                                         ▼
enyst/smolpaws
  vendor/openhands-agent/
    transpile/upstream.json      propagated SDK provenance
  packages/openhands-agent-server/
    transpile/openapi-policy.json
    transpile/python-openapi.json
    scripts/check-openapi-parity.ts
```

The SDK fork is the control plane because both transpiles share one upstream repository and pin. This does **not** make the server implementation an SDK responsibility; it only gives the relationship one clock and one provenance owner.

## Canonical source manifest

The first implementation adds `transpile/upstream.json` to `enyst/openhands-agent` and includes that exact file in the npm package.

It contains:

```json
{
  "schemaVersion": 1,
  "repository": "OpenHands/software-agent-sdk",
  "commit": "FULL_SHA",
  "targets": {
    "sdk": {
      "sourcePrefixes": [
        "openhands-sdk/",
        "openhands-tools/",
        "openhands-workspace/"
      ],
      "testPrefixes": [
        "tests/sdk/",
        "tests/tools/",
        "tests/workspace/",
        "tests/integration/"
      ],
      "examplePrefixes": [
        "examples/01_standalone_sdk/"
      ]
    },
    "server": {
      "sourcePrefixes": [
        "openhands-agent-server/"
      ],
      "testPrefixes": [
        "tests/agent_server/",
        "tests/cross/"
      ],
      "examplePrefixes": [
        "examples/02_remote_agent_server/"
      ]
    }
  },
  "policyHints": [
    {
      "prefix": "openhands-sdk/openhands/sdk/plugin/",
      "target": "sdk",
      "policy": "EXC-SDK-001"
    }
  ]
}
```

The real manifest will enumerate all established `DEV-*`/`EXC-*` path hints, but hints are not automatic dispositions. A commit touching a deviation path still appears for review, especially when it also touches shared code.

After this exists:

- contracts and scripts stop carrying independent literal pins;
- the SDK package publishes the manifest;
- SmolPaws vendoring preserves it;
- server CI reads the vendored manifest;
- the current downstream-only `_smolpawsProvenance.upstreamOpenHandsCommit` field is generated from the manifest or removed as duplicate state.

## Drift CLI

The CLI lives under `scripts/drift/`, uses Node.js plus `git`, and has no network logic in its core. Callers provide an upstream checkout; GitHub Actions is responsible for fetching it.

Suggested commands:

```sh
npm run drift:scan -- \
  --upstream ../software-agent-sdk \
  --to origin/main \
  --out .drift

npm run drift:prepare -- \
  --upstream ../software-agent-sdk \
  --to <candidate-sha> \
  --out transpile/updates/9663409..abcdef0.json

npm run drift:check -- \
  --upstream ../software-agent-sdk \
  --review transpile/updates/9663409..abcdef0.json
```

### `scan`

Produces deterministic JSON plus a Markdown view containing:

- resolved old/new full SHAs and commit dates;
- total and first-parent commit counts;
- first-parent commit units in order;
- changed/added/deleted/renamed files;
- target and subsystem buckets;
- changed tests and examples;
- known policy hints;
- unmapped paths;
- newly added or deleted source/test files.

`scan` is factual only. It does not assign `PORT`, `NO_TARGET_CHANGE`, `DEVIATION`, `EXCLUDED`, or `DEFERRED`.

### `prepare`

Builds a review template for one chosen immutable candidate SHA.

The generated unit is normally **first-parent commit × target**. A commit that touches both SDK and server creates separate review items. Each item carries its source/test/example paths and policy hints.

The editable portion contains only semantic annotations:

```json
{
  "from": "FULL_OLD_SHA",
  "to": "FULL_NEW_SHA",
  "items": {
    "FULL_COMMIT_SHA:sdk": {
      "disposition": "PORT",
      "reason": "Conversation error propagation changed.",
      "policy": null,
      "tracking": ["openhands-agent-..."],
      "evidence": [
        "src/conversation/__tests__/..."
      ]
    }
  }
}
```

The file does not copy a permanent global module matrix. It describes one interval and freezes when the pin advances.

### `check`

Regenerates the interval inventory and verifies:

- `from` equals the current manifest pin;
- `to` resolves to the recorded full SHA and descends from `from`;
- every target-relevant generated unit has an annotation;
- no annotation refers to a vanished/unknown unit;
- `NO_TARGET_CHANGE` has a concrete reason;
- `DEVIATION` and `EXCLUDED` reference a known policy ID;
- `DEFERRED` includes tracking, compatibility consequence, and revisit trigger;
- `PORT` records its target evidence before closure;
- no unmapped changed path remains unexplained.

The checker does not decide whether the human reasoning is good. It makes omissions and stale bookkeeping impossible to miss.

## Weekly watcher

Only `enyst/openhands-agent` gets a scheduled workflow.

The workflow:

1. checks out the SDK fork;
2. checks out/fetches `OpenHands/software-agent-sdk`;
3. resolves the manifest pin and upstream default-branch head;
4. runs `drift:scan`;
5. writes the Markdown report to the Actions job summary;
6. uploads JSON/Markdown artifacts;
7. creates or updates **one** current GitHub issue identified by a hidden marker.

The current issue is an alarm panel, not historical evidence. It should show:

- pin and candidate head;
- age/ahead counts;
- affected SDK/server subsystems;
- changed tests/examples;
- policy-hinted and unmapped changes;
- workflow/artifact link.

It must not create one issue or Bead per module automatically. Semantic work items are created only after a person/agent reviews a bounded candidate interval. Otherwise ordinary refactors would manufacture a noisy false backlog.

When the pin catches up, the issue may close automatically. Historical pin advances live in the reviewed interval records and commits, not in weekly issue-body archaeology.

## Server consumption and OpenAPI oracle

The server repo does not own a schedule or duplicate pin.

Its CI reads the vendored SDK manifest and checks that all server parity artifacts identify the same upstream SHA.

### Python oracle

At the pinned source, upstream already exposes a deterministic generator:

```py
from openhands.agent_server.api import api
schema = api.openapi()
```

The tooling runs the pinned Python `openhands/agent_server/openapi.py`, canonicalizes the JSON, and records source metadata beside the artifact.

### TypeScript comparison

Replace the hand-written `upstreamSnapshot` route list with generated comparison against the Python oracle.

The exception file contains only policy:

```json
{
  "operations": {
    "POST /api/conversations/{conversation_id}/switch_acp_model": {
      "disposition": "DEVIATION",
      "policy": "DEV-SERVER-001"
    }
  },
  "differences": {
    "POST /api/conversations/{conversation_id}/events request.event_id": {
      "disposition": "EXTENSION",
      "policy": "EXT-SERVER-001"
    }
  }
}
```

It is acceptable to hand-maintain exceptions because they are deliberate policy/debt. It is not acceptable to hand-maintain the upstream operation inventory.

OpenAPI comparison lands in two slices:

1. **Operation parity:** paths, methods, status codes, content types, stale/unknown exception detection.
2. **Schema parity:** dereference local component refs and compare a canonical semantic projection of parameters, request bodies, responses, required fields, types, formats, enums, constraints, defaults, and nullability. Ignore presentation-only titles/descriptions and normalize equivalent JSON Schema encodings.

A committed Python oracle keeps ordinary server CI fast. A regeneration check, required when the pin changes and available manually, proves the artifact came from the pinned Python source.

## Evidence beyond drift discovery

The drift CLI is necessary but insufficient. It answers “did we review everything?”, not “does the target behave the same?”

Follow-on evidence:

### SDK wire goldens

Run Python and TypeScript over shared deterministic fixtures for:

- event JSON;
- `eventsToMessages` projections;
- tool JSON Schema;
- settings/profile serialization;
- conversation restore;
- remote request/response payloads;
- deterministic condenser/view transformations.

### Server scenario differential

Run pinned Python and TypeScript servers with deterministic fake/TestLLM behavior and replay language-neutral cases. Normalize IDs, timestamps, and environment metadata, then compare response meaning, event kinds/content, execution transitions, and error classes.

### Live provider smokes

Keep these separate. They answer “does the provider still accept our request?” and are valuable, but they do not establish Python parity.

## Failure behavior

The tooling fails closed when:

- the manifest pin is absent from the upstream checkout;
- the candidate is not a descendant of the pin;
- a changed path maps nowhere;
- a generated review unit lacks a disposition;
- a policy ID is unknown;
- an OpenAPI exception no longer matches either oracle;
- the server oracle and vendored SDK pin disagree.

Repository-only upstream CI/docs changes may appear in an informational bucket, but source/tests/examples in declared target scopes can never be silently ignored.

## Cross-repo pin advance

“Lockstep” means one reviewed interval and the same final upstream SHA, not an impossible atomic merge across two repositories.

A normal update batch is:

1. choose `NEW_PIN`;
2. generate and classify the interval in the SDK fork;
3. port SDK `PORT` items tests-first;
4. regenerate SDK goldens;
5. build/release or vendor the SDK with the new manifest;
6. port server `PORT` items tests-first;
7. regenerate Python OpenAPI and run server differentials;
8. verify server vendor/oracle pin alignment;
9. close the interval record and move both targets to the same SHA.

During coordinated work the repos may temporarily differ, but the server must not claim a new pin until its vendored SDK provenance and Python oracle match.

## Implementation order

### Slice 1 — control plane

- add `transpile/upstream.json`;
- implement/test `scan`, `prepare`, and `check` against synthetic local git repositories;
- package the manifest with the SDK;
- teach server CI to read and verify the vendored manifest.

### Slice 2 — stop blind drift

- add the weekly SDK workflow;
- publish job summary/artifacts;
- maintain one current drift issue.

### Slice 3 — kill the circular route check

- generate Python OpenAPI from the pin;
- replace the hand-typed route inventory with operation parity;
- move current route exceptions into a policy file.

### Slice 4 — deepen the oracles

- add normalized OpenAPI schema comparison;
- add SDK wire goldens;
- add deterministic cross-server scenarios.

### Slice 5 — reconcile the backlog

Feed the current pinned interval through the machinery in dependency-ordered batches. Move the pin only when every generated unit is dispositioned and required evidence is green.

## Documentation rule

The contracts remain the policy source. This file describes tooling architecture. Weekly reports are generated operational state. Pin-advance review files are immutable historical evidence. Public `enyst.github.io` architecture pages are explanatory snapshots and should carry “historical/superseded” notices when they stop describing current code; they must not become another live parity ledger.
