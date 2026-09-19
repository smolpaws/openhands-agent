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

Profiles may select Anthropic explicit-cache duration with the optional `anthropicCacheTtl: '5m' | '1h'`. Omission stays absent through profile parsing and persistence; never insert this provider option into other profiles. An omitted duration leaves Anthropic's five-minute wire behavior unchanged. The pinned Python serializer emits fixed ephemeral markers without a duration; selecting one hour is a deliberate target profile option. Provider adapters apply the selected duration uniformly to existing Anthropic request breakpoints, including lifted tool-result markers, without changing persisted messages, cache selection or opt-out behavior. Five-minute requests retain the upstream wire shape without `ttl`; unrelated transports ignore this option. Keep this separate from OpenAI `promptCacheRetention`. Review upstream caching and profile changes against this choice; see [Anthropic cache evidence](../transpile/anthropic-cache.md).

Profiles may explicitly select `verbosity: 'low' | 'medium' | 'high'`. Omission stays absent through parsing and persistence. The OpenAI-compatible Chat Completions client emits top-level `verbosity`; the Responses client emits `text.verbosity`. This is an opt-in provider option: callers select it only for models/endpoints that support it; unrelated native provider clients ignore it. This extends the profile-first configuration boundary without changing the upstream pin.

The optional `switch_llm` builtin retains the upstream profile-name/reason input and structured observation. Hosts provide saved profile names and a profile-selection callback; the SDK does not choose a global profile database. A callback may prepare and durably accept a pending selection during tool execution, then install it at the completed-step boundary before the next LLM call. Its success text describes acceptance for that next call, rather than claiming the currently executing batch changed models. Failure leaves the working selection intact. Settings-driven hosts honor `enable_switch_llm_tool` (default true); it is not one of the unconditional `BUILT_IN_TOOLS`.

Condenser settings select their own `llm_profile_ref`, or an explicit host-provided default reference. Materialization must resolve that reference independently; it must never silently reuse the main agent client. Disabled/no-op settings require no credential lookup. Missing references and resolution failures are errors at materialization, while old settings without a reference remain loadable for host migration. Profile switches do not implicitly switch the condenser.

### DEV-SDK-005 — no ACP runtime execution

ACP execution/model-switching runtime behavior is not part of this transpilation.

### DEV-SDK-006 — exec-based terminal executor

The Python terminal tool runs commands in a persistent tmux/subprocess session: it supports interactive input, returns to the model after 30 seconds without output while the process keeps running (soft timeout, exit code -1), and lets a later call continue or stop it. The TypeScript executor runs each command with Node's `exec`: no interactive input, no persistent session, and a **hard** default timeout (300 seconds unless the action sets `timeout`; `timeout: 0` means no limit) after which the process is killed and the observation reports `timeout: true` with exit code -1. Upstream changes to the terminal tool's soft-timeout, session, or input semantics must still be reviewed against this alternative.

### DEV-SDK-007 — native accounting with explicit measurement coverage

Preserve per-completion usage, accumulation by usage ID, independent snapshots, and continuity after restore. Native provider adapters normalize token categories once and retain the provider's usage payload. Persist one accounting delta per returned `Agent.step` LLM response, including available accounting metadata on response failures, then project conversation statistics; do not add cumulative response snapshots together or charge a multi-tool response once per action. Use independent local accounting IDs because provider response IDs may be absent or reused. Hosts implementing a metrics-reset fork append a validated reset boundary after the copied history.

The Python metric defaults collapse several absent values to zero and assume a scalar cost. This target deliberately represents absent token/cost fields and incomplete accumulated totals as unknown, with known subtotals and explicit coverage. Keep currency/unit and provider-reported versus calculated provenance. A reported zero remains zero; an unavailable price remains unknown. Derived prices require a retained dated quote and matching provider/model semantics; subscription usage must not inherit API pricing. Normalize inclusive input/output totals before deriving cache rates, without guessing inclusion conventions from the relative counter sizes.

The target exposes immutable record projections and compact snapshots rather than Python's mutable `Metrics`/`LLMRegistry` objects. Its durable `llm_usage` and `llm_metrics_reset` state-update keys replace Python's separate metrics state-file storage. Preserve explicit null values and provider usage detail inside the accounting payload during disk serialization; the ordinary event serializer's null omission must not turn unknowns into malformed records. Missing historical records remain unmeasured; do not reconstruct billed usage from transcript text. Full Python `base_state.stats` import and automatic attribution of standalone client calls or unrelated auxiliary consumers are outside this implementation and must not be claimed as parity. Condenser calls made inside `Agent.step` are attributed automatically to usage ID `condenser`, preserving the actual selected profile on each record. Save one record for every summary completion attempt, including hard-reset attempts and failed calls with unknown usage/cost; a persistence callback failure must propagate without recharging or retrying that callback. Standalone condensers require an explicit accounting callback. Upstream changes to these surfaces still require review. See [metric semantics and limits](LLM_METRICS.md) and [port evidence](../transpile/llm-metrics.md).

Per-completion records may include a non-secret `history_origin` digest to associate opaque continuation data with its producing profile binding. This provenance does not create a billable call or reset accumulated usage; absent historical provenance remains unknown. See DEV-SDK-008.

### DEV-SDK-008 — cross-profile opaque reasoning projection

When a saved conversation changes profile binding, project its outgoing transcript without replaying signed or encrypted reasoning from a different binding. `src/llm/history.ts` associates responses with the preceding usage record in event order, including when a provider reuses response IDs. Binding identity hashes profile ID, provider, requested model, sanitized endpoint origin/path, API mode, and authentication selection. Raw credentials, headers, URL userinfo, and URL query values are excluded. Credential/header/query-only edits within the same profile therefore do not establish a distinguishable origin.

Before host switching, persist one `llm_history_origin` state-update anchor for the original binding. Unknown events before that anchor may retain opaque continuation only for the original binding; known incompatible legacy profile/provider/model metadata overrides that inference. Unknown events after the anchor cannot inherit that trust. This is a compatibility projection, not reconstructed historical provider evidence.

On an origin mismatch, outgoing copies omit `thinking_blocks` and `responses_reasoning_item`; an otherwise empty reasoning-only assistant turn is omitted. Preserve plaintext reasoning, visible text, tool requests/results, persisted history, and usage accounting. Same-binding native continuation remains intact. The pinned Python implementation only explicitly strips Responses reasoning for subscription transport; general cross-profile projection is a deliberate target behavior, not a claim of Python parity. See [profile-switch evidence](../transpile/profile-switch.md) and `src/agent/__tests__/profile-history.test.ts`.

For auxiliary condenser projection, the current main binding supplies the fallback origin of unanchored legacy history. This does not manufacture historical evidence or persist a profile switch; an existing durable origin anchor and per-response metadata remain authoritative. Summary prompts contain the pinned visible event previews, not opaque continuation payloads.

### DEV-SDK-009 — request causality for concurrent user input

For serialized agent steps, capture the input event boundary synchronously with each outgoing
Agent request. Persist an
`llm_request_boundary` state-update event before the response events in the same serialized append
batch. Its versioned payload identifies the last input event and explicit local response event IDs;
provider response IDs and timestamps are not sufficient evidence. A batch is not a crash transaction:
incomplete response membership leaves the marker inert.

After applying condensation, project retained user arrivals that the request could not have seen
after its response, preserving their relative order and content. Use the original full log to resolve
boundaries without restoring forgotten events or moving messages across synthetic summaries. The
existing provider tool-result projection still keeps completed tool exchanges adjacent. Do not change
durable event order, public `eventsToMessages` semantics, usage accounting, or the server's obligation
to run a follow-up for input not yet consumed. Response-owned corrective messages are not user arrivals.

Old histories without provenance keep their recorded order; do not invent retrospective boundaries.
As with `LocalConversation` and the server, callers must serialize steps sharing one state; this
projection does not coordinate overlapping direct `Agent.step` calls.
The pinned Python async loop detects mid-step arrivals, but source inspection does not establish
equivalent durable plain-response causality. This target behavior is an intentional deviation, not a
claim of an upstream runtime bug. Review upstream changes to async request capture, emission,
condensation and event conversion against it. See [concurrent response evidence and recovery limits](../transpile/concurrent-response-history.md).

### DEV-SDK-010 — explicit input-budget estimates and unavailable counts

Native clients expose optional token-counting, effective-input-limit and awaited runtime-metadata capabilities. Local text/tool counting ports the pinned LiteLLM generic BPE recipe; it is an estimate, not billed usage or a promise of provider-specific tokenizer equivalence. The native implementation does not reproduce every Hugging Face tokenizer, chat template, or multimodal token estimator. Unmeasurable images/opaque reasoning return `null`, never an invented zero or silent character-count approximation. Custom clients may omit these capabilities. Event-count, manual-request and typed provider-error condensation remain available when proactive token counting is unavailable.

Explicit profile input limits take precedence. Known native limits come from a reproducibly generated snapshot of the dependency locked at the canonical Python pin. Route overrides must not inherit an unrelated native catalog limit. Runtime discovery is bounded, cached, provider-owned and restricted to supported metadata routes; unknown limits remain `null`. This differs from Python's fallback-zero token counting and some dependency model resolution. Revisit this policy when adding native tokenizers/modalities or when upstream token accounting/model discovery changes. See [condensation evidence](../transpile/condensation.md).

The TypeScript Agent renders fixed system/context outside the event View. Include those blocks and usable tool declarations in every candidate token count without removing them during condensation. An oversized fixed prompt cannot be repaired by forgetting history; do not silently truncate host identity or memory to conceal it. Preflight estimates never enter the usage ledger.

### DEV-SDK-011 — shared condenser event defaults

The TypeScript summarizing-condenser class, validated settings and `defaultCondenser()` factory default to `max_size: 1000` / `maxSize: 1000` and `keep_first: 2` / `keepFirst: 2`. This intentionally differs from the pinned Python class/settings defaults of 240/2 and standard-agent/sub-agent factory defaults of 80/4. The target keeps more event history before event-count pressure alone requests condensation and uses the same defaults through all three construction paths.

These defaults apply only to omitted fields. Explicit constructor/settings values, including persisted conversation condenser bindings, remain authoritative and are not migrated merely because defaults changed. Event pressure remains strict greater-than; token pressure, explicit requests, provider-error recovery, safe cuts and reset behavior are unchanged. This policy does not select a model/profile, introduce a token budget, or make the factory reuse the main client. Review upstream condenser defaults, settings and standard-agent/sub-agent factory changes against this choice. See [condensation evidence](../transpile/condensation.md).

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

### EXT-SDK-003 — host preparation at completed-step boundaries

`LocalConversation` may accept an `onStepBoundary(agent)` callback implemented through `src/conversation/ext/step-boundary.ts`. It runs before the first step of a running invocation and after every successfully awaited step, including a final finish response, when all results have been appended. It may return a replacement `Agent`; the conversation retains its state, event log, iteration count, limits, and stuck detector. A rejected callback propagates without replacing the current agent. Concurrent `run()` callers share the active run, so they cannot prepare a replacement during an active batch or reset its iteration budget. Calls without this hook preserve the existing single-run behavior.

The host owns selection policy, validation, client construction, pending-selection persistence, and activation persistence. It must complete activation persistence before returning a replacement and must never wait for the current run from inside a tool executor. This extension adds no profile storage, SmolPaws paths, new action wire fields, or implicit auxiliary-model switching to the SDK. The optional upstream `switch_llm` tool remains a parity port governed by DEV-SDK-004; this host callback is the separate additive integration seam. See [profile-switch port evidence](../transpile/profile-switch.md).

Normal runs and explicit `condense()` operations share a step-level guard, so maintenance waits for the current step and runs before the next queued model request. It does not await the entire run, resume a paused conversation, reset the iteration budget, or mark queued user input answered. A successful manual step also reaches the completed-step host callback.

Terminal execution status is updated before the final boundary callback. A read-only `lastStepUserMessageId` records the latest user event synchronously immediately before `Agent.step`, so a host can distinguish input consumed by that step from input arriving during later preparation or completion. This queue-coordination marker is part of the host seam, not an upstream switch-tool field.

## Context and persistent memory

Preserve the existing always-on context path: a non-AgentSkills `Skill` with `trigger: null` contributes its full content to `AgentContext`'s `REPO_CONTEXT` block. A host may read its chosen instruction or memory files and supply those skills through the public constructor. Product-specific file selection belongs to the host; the SDK must not discover SmolPaws private paths implicitly. This uses an existing SDK contract and does not require a new extension or a larger `AgentLaunchAdditions.system_message_suffix_append` limit.

Upstream's opt-in `load_memory` / `memory_context`, memory-index loader, settings propagation and initialization/restore behavior remain in scope. Absence of that implementation is a deferred parity gap, not evidence for `NO_TARGET_CHANGE` or an exclusion. Keep that separate from the supported explicit-skill path; supplying a memory file as a skill does not complete the native memory port. See the [current context and memory evidence](../transpile/context-memory.md) for the tracked gap and superseded historical classifications.

## LLM/provider rule

Keep the shared `LLMClient` boundary thin. Provider clients own provider-specific request construction, tool serialization, continuation/replay, reasoning metadata, caching, and error mapping. Do not flatten provider semantics merely to make the abstraction look uniform.

Product dispatch is profile-first. Credential lookup is provider-driven rather than inferred from model-family names. No implicit fallback model chain.

### Provider compatibility without LiteLLM

The Python SDK delegates part of provider compatibility to LiteLLM and its dependencies. This TypeScript SDK implements provider protocols directly, so it must own the equivalent request/response normalization, capability decisions, and continuation handling. A provider quirk may require a TypeScript fix even when no Python SDK source, test, or upstream pin has changed. Absence of a matching Python diff is not grounds to reject or remove that fix.

Compatibility is judged by observable behavior through the SDK, including the behavior supplied by upstream dependencies. Implementing equivalent provider handling is ordinary compatibility work, not automatically a `DEV-*` deviation or `EXT-*` extension. When classifying a finite upstream interval, use `PORT` if the target needs such a fix. Independently discovered provider bugs can be fixed without advancing the pin or inventing an upstream review unit. Intentional semantic differences still require the existing policy process.

Keep protocol normalization in the owning provider client and reusable capability decisions in small, pure provider helpers. Do not spread provider switches into agents, conversations, tools, servers, or bridges. Accept harmless extra wire fields only where safe, keep required fields validated, and preserve metadata needed for tool/reasoning continuation. A quirk must have a regression test from upstream evidence or a sanitized provider request/response fixture; when no Python test exists, demonstrate the failure with that fixture before fixing it. See [LLM provider implementation](LLM_PROVIDERS.md) for placement and test guidance.

### Subscription (OAuth) authentication

OpenAI ChatGPT subscription authentication is in scope. `src/llm/auth/` owns the Python-compatible `OAuthCredentials` and `CredentialStore`, device and browser PKCE login, expiry/refresh, signed JWT account lookup, and subscription message transformation. Its private credential directory is `OH_PERSISTENCE_DIR/auth` or `~/.openhands/auth`; it never reads the Codex CLI's `~/.codex/auth.json`.

OAuth tokens are runtime credentials and remain in that dedicated private store. DEV-SDK-003 still prohibits writing raw secrets to profiles, settings, events, or snapshots; it does not exclude the upstream OAuth credential store. An explicit `LLMProfile.authType: 'subscription'` selects this path. DEV-SDK-004 means hosts select profiles and present login URLs/consent through callbacks instead of the Python terminal-oriented `subscription_login()` helper. The underlying browser/device exchanges and credential lifecycle preserve upstream behavior.

Refresh credentials when constructing a subscription client and before every request. Derive headers from current credentials, force subscription transport options, preserve streamed tool/text output, and avoid replaying unresolvable reasoning IDs. See [LLM provider implementation](LLM_PROVIDERS.md) and [subscription port evidence](../transpile/subscription-auth.md). Model catalogs are generated from the same canonical pin; they do not enable ACP execution.

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
