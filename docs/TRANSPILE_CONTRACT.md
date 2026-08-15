# Transpilation Contract

This is the durable contract for maintaining `@smolpaws/openhands-agent` as an idiomatic TypeScript transpilation of OpenHands `software-agent-sdk`.

This file is **policy, not status**. Release notes record history. Beads/issues track work. `ARCHITECTURE.md` explains the current implementation. Generated drift reports and tests provide evidence. Do not turn this file back into a roadmap or release diary.

## Source and scope

Upstream: `OpenHands/software-agent-sdk`

Current pinned commit:

```text
966340979be26c2162e9ab8805557b715e1f1a78
```

This package covers the SDK-side Python packages:

- `openhands-sdk/`
- `openhands-tools/`
- `openhands-workspace/`

The Python `openhands-agent-server/` package is transpiled separately in `smolpaws/smolpaws/packages/openhands-agent-server`.

The SDK and server transpiles must advance against the same upstream commit in deliberate batches. Never treat unbounded upstream `HEAD` as a work unit; every update is a finite `OLD_PIN..NEW_PIN` interval.

## Compatibility promise

Preserve observable upstream contract and behavior unless an explicit policy below says otherwise. This includes, where applicable:

- public concepts, names, and serialized shapes;
- event/message conversion and durable conversation semantics;
- agent-loop behavior, tool dispatch, pending/parallel actions, cancellation, and restore;
- tool schemas and concrete tool behavior;
- workspace and remote protocol behavior;
- settings/profile behavior;
- LLM request/response semantics observable through the SDK;
- observable errors and lifecycle behavior;
- supported deterministic examples and tests.

Use idiomatic strict TypeScript. zod may replace pydantic, discriminated unions may replace Python class hierarchies, and provider-native clients may replace LiteLLM internals. Such implementation choices are still parity when the observable contract is preserved.

## Upstream-change dispositions

Every meaningful in-scope upstream change reviewed during a pin advance gets exactly one disposition:

| Disposition | Meaning |
|---|---|
| `PORT` | Target tests and/or code must change to preserve compatibility. |
| `NO_TARGET_CHANGE` | Reviewed; no target change is required. Record why. |
| `DEVIATION` | The area is relevant to this transpilation, but target behavior intentionally differs. Reference a `DEV-*` policy ID. |
| `EXCLUDED` | The upstream subsystem is outside this transpilation's declared scope. Reference an `EXC-*` policy ID. |
| `DEFERRED` | In scope, but intentionally not implemented yet. Record the compatibility consequence and tracking item. |

`DEVIATION` and `EXCLUDED` are both departures from upstream in ordinary language. We distinguish them because maintenance differs: upstream changes under a `DEVIATION` must still be reviewed against our alternative behavior; changes under an `EXCLUDED` subsystem do not create port work unless scope changes.

Do not add an `ADAPTED` disposition. Target-language implementation choices that preserve behavior are `PORT`/parity work, not policy exceptions.

## Intentional deviations and exclusions

### DEV-SDK-001 — no security analyzers or risk scoring

Do not port the Python security-analyzer/risk-scoring subsystem as active SDK behavior. Compatibility metadata may be accepted or ignored where necessary, but do not recreate the execution machinery accidentally.

### DEV-SDK-002 — no confirmation gates

Do not port confirmation mode, confirmation policies, confirmation replies, or human approval gates.

This does **not** remove the pending-action queue, unmatched-action tracking, parallel tool execution, or cancellation. Those remain parity-critical execution machinery.

### DEV-SDK-003 — keyring-backed secret references

Do not port Python `Cipher` or its plaintext/encrypted-at-rest persistence split. Persistent settings/profiles contain stable secret references; raw values are resolved through `SecretStore`. Raw secrets must not be written to persisted settings, profiles, events, logs, fixtures, or snapshots.

### DEV-SDK-004 — profile-first product LLM boundary

Product/REST callers select an `LLMProfile`; they do not configure a Python-style bare `LLM` object or rely on an implicit default model. Low-level provider clients may remain exported for advanced SDK/testing use.

### DEV-SDK-005 — no ACP runtime execution

ACP execution/model-switching runtime behavior is not part of this transpilation.

### EXC-SDK-001 — plugin runtime

The Python plugin runtime is outside current transpilation scope unless this contract is deliberately changed.

### EXC-SDK-002 — marketplace runtime

The Python marketplace runtime is outside current transpilation scope unless this contract is deliberately changed.

## LLM/provider rule

Keep the shared `LLMClient` boundary thin. Provider clients own provider-specific request construction, tool serialization, continuation/replay, reasoning metadata, caching, and error mapping. Do not flatten provider semantics merely to make the abstraction look uniform.

Product dispatch is profile-first. Credential lookup is provider-driven rather than inferred from model-family names. No implicit fallback model chain.

## Tests-first rule

For every upstream behavior change that requires target work:

1. identify the upstream source change and relevant tests/examples;
2. port or adapt the test first;
3. demonstrate the changed test is red for the expected reason;
4. implement the smallest behavior change that makes it green;
5. run the surrounding suite;
6. add differential/golden evidence when the behavior is primarily serialization, persistence, wire format, or deterministic state transformation.

If upstream changes observable behavior without adding a test, write the missing compatibility test from the source diff before implementing it.

## Pin-advance procedure

Every update is `OLD_PIN..NEW_PIN`.

### 1. Discover mechanically

Collect commits/PRs, changed/added/deleted in-scope files, changed tests, changed examples, and cross-package protocol/persistence changes. Prefer generated inventories over hand-maintained lists.

### 2. Classify before coding

Assign each meaningful in-scope change one disposition above. `NO_TARGET_CHANGE` needs a concrete reason. `DEVIATION`/`EXCLUDED` reference stable policy IDs. `DEFERRED` records the upstream change, affected contract, reason, tracking item, compatibility consequence, and revisit trigger.

### 3. Port red/green

Process `PORT` changes tests-first. Prefer small coherent batches over one giant catch-up patch.

### 4. Run evidence

At minimum:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
```

Run affected wire/golden suites as they exist. Credential-gated provider smokes prove external API viability; they are not substitutes for Python/TypeScript parity tests.

### 5. Close the interval

Do not move the pin while an in-scope upstream change is unclassified. A pin advance records `OLD_PIN -> NEW_PIN`, counts/by-item dispositions, and evidence run. SDK and server must end the batch on the same upstream commit.

## Evidence model

A green TypeScript suite proves implemented behavior; it does not prove that every upstream change was noticed. Therefore:

- discovery inventories should be generated;
- Python/TypeScript differential or golden tests should be preferred for deterministic wire/state behavior;
- server OpenAPI inventory should be generated from the pinned Python source rather than hand-copied;
- update records should be generated from an interval, reviewed/annotated, then frozen as historical evidence rather than continuously maintained.

Do not build a hand-maintained global parity ledger unless generated evidence proves insufficient.

## Documentation ownership

- `TRANSPILE_CONTRACT.md`: durable policy, scope, deviations, update procedure.
- `ARCHITECTURE.md`: current target architecture and implementation boundaries.
- `RELEASE_*.md`: historical release evidence.
- `README.md`: package usage and concise compatibility statement.
- `AGENTS.md`: operational instructions for coding agents.
- Beads/issues: work tracking only, never compatibility truth.

When prose conflicts with code, first determine whether the prose is stale implementation/status documentation or this contract. Code/tests describe current factual behavior; this contract describes intended policy. A code/contract mismatch must be investigated, not automatically resolved in favor of either side.
