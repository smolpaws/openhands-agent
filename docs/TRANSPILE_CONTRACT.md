# Transpilation Contract

This is the durable contract for maintaining `@smolpaws/openhands-agent` as an idiomatic TypeScript transpilation of OpenHands `software-agent-sdk`.

This file is **policy, not status**. Release notes record history. Beads/issues track work. `ARCHITECTURE.md` explains the current implementation. Generated drift reports and tests provide evidence. Do not turn this file back into a roadmap or release diary.

## Source and scope

Upstream: `OpenHands/software-agent-sdk`

The canonical repository, current full commit SHA, source/test/example ownership, and policy path hints live in [`../transpile/upstream.json`](../transpile/upstream.json). Do not duplicate the literal pin in contracts or scripts.

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
| `DELEGATED` | The unit belongs to a target this repository does not own (the `server` target, reviewed in `smolpaws/smolpaws/packages/openhands-agent-server`). The decision is recorded there, not here. Required for, and only valid for, non-owned targets; `drift:prepare` pre-fills it and `drift:check` rejects any other disposition on them. |

`DEVIATION` and `EXCLUDED` are both departures from upstream in ordinary language. We distinguish them because maintenance differs: upstream changes under a `DEVIATION` must still be reviewed against our alternative behavior; changes wholly within an `EXCLUDED` subsystem do not create port work unless scope changes.

A mixed change cannot be blanket-excluded. Every changed file in an `EXCLUDED` review unit must fall under the named exclusion.

Do not add an `ADAPTED` disposition. Target-language implementation choices that preserve behavior are `PORT`/parity work, not policy exceptions.

Extensions are target policy, not upstream-change dispositions. Give additive target-only behavior — code that has no upstream counterpart to be faithful to — a stable `EXT-*` ID (see [Additive extensions](#additive-extensions)).

## Intentional deviations and exclusions

The stable policy IDs below are also registered in the canonical manifest so tooling can validate review records. The prose here remains the policy authority.

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

### DEV-SDK-006 — exec-based terminal executor

The Python terminal tool runs commands in a persistent tmux/subprocess session: it supports interactive input, returns to the model after 30 seconds without output while the process keeps running (soft timeout, exit code -1), and lets a later call continue or stop it. The TypeScript executor runs each command with Node's `exec`: no interactive input, no persistent session, and a **hard** default timeout (300 seconds unless the action sets `timeout`; `timeout: 0` means no limit) after which the process is killed and the observation reports `timeout: true` with exit code -1. Upstream changes to the terminal tool's soft-timeout, session, or input semantics must still be reviewed against this alternative.

### EXC-SDK-001 — plugin runtime

The Python plugin runtime is outside current transpilation scope unless this contract is deliberately changed.

### EXC-SDK-002 — marketplace runtime

The Python marketplace runtime is outside current transpilation scope unless this contract is deliberately changed.

## Additive extensions

Extensions are additive, target-only behavior that has **no upstream counterpart**. They are not judged by upstream parity because there is nothing upstream to be faithful to. Each extension has a stable `EXT-SDK-*` ID registered in the canonical manifest with `kind: EXTENSION`.

Rules for every extension:

- It must not change the observable behavior of any ported upstream surface. Ported concepts, tool schemas, event shapes, and the agent loop stay parity-governed.
- It must live in clearly separated target-only files so drift discovery does not mistake it for unclassified upstream work.
- It is not exempt from tests, typecheck, lint, or build — only from the differential/golden parity oracle.
- Keep the extension surface small. An extension that starts reshaping a parity-governed contract is no longer additive and must be reconsidered.

SmolPaws builds product-specific agent tools (outbound messaging, task scheduling) on the SDK's public `ToolDefinition` and tool-registry surface. Such tools are additive extensions: they emit ordinary `ActionEvent`s and carry no delivery, queue, or scheduling semantics inside the SDK — those live in the SmolPaws coordinator and server.

### EXT-SDK-001 — outbound message tool

The SDK may define `send_message` and `send_media` tools that lets the agent emit a mid-turn outbound message as an ordinary `ActionEvent`. The tool only records intent on the EventLog; it performs no delivery and does not end the turn. Delivery is owned by the SmolPaws coordinator, which projects the action into its durable outbox.

### EXT-SDK-002 — task-scheduler tools

The SDK may define smolpaws' cross-conversation scheduling tools (`schedule_task`, `list_tasks`, `update_task`, `cancel_task`, `pause_task`, `resume_task`) as ordinary tools that emit `ActionEvent`s. This is distinct from the upstream-parity `task_tracker` tool (a per-conversation checklist). The scheduling engine and turn enqueue live outside the SDK; these tools only express the request as durable events.

Hosts can bind these extension tools to real executors through `ToolDefinition`. An executor opting in
with `meta.smolpaws_execution_context: true` receives `{ actionEventId, toolCallId }` as its second
argument, allowing durable command deduplication. Ordinary tools retain their existing invocation.
This opt-in belongs to EXT-SDK-001/002: it adds no fields to wire events, no scheduling/delivery engine,
and no confirmation or queue semantics to the agent loop.

## LLM/provider rule

Keep the shared `LLMClient` boundary thin. Provider clients own provider-specific request construction, tool serialization, continuation/replay, reasoning metadata, caching, and error mapping. Do not flatten provider semantics merely to make the abstraction look uniform.

Product dispatch is profile-first. Credential lookup is provider-driven rather than inferred from model-family names. No implicit fallback model chain.

### Provider compatibility without LiteLLM

The Python SDK delegates part of provider compatibility to LiteLLM and its dependencies. This TypeScript SDK implements provider protocols directly, so it must own the equivalent request/response normalization, capability decisions, and continuation handling. A provider quirk may require a TypeScript fix even when no Python SDK source, test, or upstream pin has changed. Absence of a matching Python diff is not grounds to reject or remove that fix.

Compatibility is judged by observable behavior through the SDK, including the behavior supplied by upstream dependencies. Implementing equivalent provider handling is ordinary compatibility work, not automatically a `DEV-*` deviation or `EXT-*` extension. When classifying a finite upstream interval, use `PORT` if the target needs such a fix. Independently discovered provider bugs can be fixed without advancing the pin or inventing an upstream review unit. Intentional semantic differences still require the existing policy process.

Keep protocol normalization in the owning provider client and reusable capability decisions in small, pure provider helpers. Do not spread provider switches into agents, conversations, tools, servers, or bridges. Accept harmless extra wire fields only where safe, keep required fields validated, and preserve metadata needed for tool/reasoning continuation. A quirk must have a regression test from upstream evidence or a sanitized provider request/response fixture; when no Python test exists, demonstrate the failure with that fixture before fixing it. See [LLM provider implementation](LLM_PROVIDERS.md) for placement and test guidance.

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

Every update is `OLD_PIN..NEW_PIN` and uses the tooling described in [`DRIFT_TOOLING.md`](DRIFT_TOOLING.md).

### 1. Discover mechanically

Generate commits/PRs, changed/added/deleted in-scope files, changed tests, changed examples, policy hints, and cross-package protocol/persistence changes. Generated inventories replace hand-maintained parity lists.

### 2. Classify before coding

Assign each generated review unit one disposition above. `server` units are `DELEGATED`: their real disposition lives in the server package's review record. `NO_TARGET_CHANGE` needs a concrete reason. `DEVIATION`/`EXCLUDED` reference stable policy IDs. `DEFERRED` records the upstream change, affected contract, reason, tracking item, compatibility consequence, and revisit trigger. Documentation impact must also be classified.

### 3. Port red/green

Process `PORT` changes tests-first. Prefer small coherent batches over one giant catch-up patch.

### 4. Run evidence

At minimum:

```sh
npm test
npm run test:drift
npm run typecheck
npm run typecheck:drift
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
```

Run affected wire/golden suites as they exist. Credential-gated provider smokes prove external API viability; they are not substitutes for Python/TypeScript parity tests.

### 5. Close the interval

Do not move the pin while an in-scope upstream change is unclassified. `npm run drift:check -- --phase close` must pass, including required target evidence for `PORT` work. SDK and server must end the batch on the same upstream commit.

## Evidence model

A green TypeScript suite proves implemented behavior; it does not prove that every upstream change was noticed. Therefore:

- discovery inventories are generated from git;
- review files are bound to their inventory hash;
- Python/TypeScript differential or golden tests are preferred for deterministic wire/state behavior;
- server OpenAPI inventory must be generated from pinned Python rather than hand-copied;
- update records are reviewed for one interval and then frozen as historical evidence.

Do not build a hand-maintained global parity ledger unless generated evidence proves insufficient.

## Documentation ownership

- `TRANSPILE_CONTRACT.md`: durable policy, scope, deviations, update procedure.
- `DRIFT_TOOLING.md`: canonical pin, generated review machinery, and differential-oracle architecture.
- `ARCHITECTURE.md`: current target architecture and implementation boundaries.
- `RELEASE_*.md`: historical release evidence.
- `README.md`: package usage and concise compatibility statement.
- `AGENTS.md`: operational instructions for coding agents.
- Beads/issues: work tracking only, never compatibility truth.

When prose conflicts with code, first determine whether the prose is stale implementation/status documentation or this contract. Code/tests describe current factual behavior; this contract describes intended policy. A code/contract mismatch must be investigated, not automatically resolved in favor of either side.
