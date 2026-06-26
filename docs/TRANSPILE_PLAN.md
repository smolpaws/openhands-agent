# Transpile Plan — Python OpenHands agent-sdk → idiomatic TypeScript

> Source of truth for the roadmap is the beads issue **`openhands-agent-jad`**.
> This doc mirrors it in Markdown for easy reading. Keep them in sync.

## Objective

Produce `@smolpaws/openhands-agent`: a fresh, idiomatic TypeScript implementation of the
OpenHands Python `agent-sdk` (local source: `~/repos/agent-sdk`, upstream
`OpenHands/software-agent-sdk`). We transpile *anew* — we do **not** copy the outdated TS
attempt in `oh-tab/packages/agent-sdk`. That older code is reference-only (tooling, tests).

## Current status after 0.1.0

The first 0.1.0 line is released and covers the core event/conversation/agent/tool/LLM/profile path, concrete tools, hooks, critic, subagents, git helpers, MCP utilities, docs, examples, and CI. The remaining work is the cleanup/completeness pass needed to make this a faithful TypeScript transpilation within the rules and explicit exceptions below.

Accepted clarification: low-level LLM client classes may remain exported from the npm package as advanced/testing/building blocks. The product/REST boundary must still be **profile-only**: REST callers select LLM profiles, never raw clients or a Python-style bare `LLM` object.


## Pinned upstream target

Python `OpenHands/software-agent-sdk` main @
**`966340979be26c2162e9ab8805557b715e1f1a78`** (2026-06-23). We transpile against exactly this
commit and catch up to newer upstream in deliberate batches, not by chasing HEAD.

## Source scope (Python core `openhands-sdk/openhands/sdk`, ~59k LOC, 93 pydantic files)

| Module | Files | ~LOC | Notes |
|--------|-------|------|-------|
| llm | 40 | 10364 | LiteLLM-backed; biggest + riskiest |
| conversation | 29 | 8378 | Local + Remote conversation, state, event loop |
| agent | 9 | 7685 | The agent loop / step logic |
| context | 25 | 3301 | Condenser, skills context, agent context |
| settings | 5 | 3127 | Settings models |
| skills | 9 | 2586 | Skill discovery/validation |
| workspace | 10 | 2528 | Local/Remote/Apple workspace |
| tool | 11 | 2360 | Tool base + registry |
| security | 15 | 2084 | Confirmation, risk, analyzer |
| utils | 16 | 2004 | Shared helpers |
| event | 19 | 1923 | Event model hierarchy |
| hooks | 6 | 1669 | Lifecycle hooks |
| plugin | 7 | 1471 | **Intentionally skipped for this roadmap** unless Engel explicitly brings it back |
| critic | 12 | 1446 | Critic models |
| git | 6 | 1355 | Git integration |
| profiles | 5 | 1267 | LLM profiles |
| subagent | 4 | 1011 | Delegation |
| extensions | 8 | 988 | |
| mcp | 6 | 750 | MCP client |
| marketplace | 4 | 649 | **Intentionally skipped for this roadmap** unless Engel explicitly brings it back |
| observability | 3 | 447 | |
| io | 5 | 431 | |
| logger | 3 | 330 | |
| testing | 2 | 339 | test helpers |
| secret | ? | 155 | Python source reference only; TS uses OS keyring, not Python's plaintext/encrypted-at-rest split |

Plus `openhands-tools` (~16k LOC): concrete tools (terminal, file editor, browser, etc.).
`openhands-agent-server` is out of scope for now (possible later sibling package).

Follow-up scope after 0.1.0:

- **Workspace** is not present in an equivalent TS shape yet. Some local execution/file behavior exists in concrete tools, but Python `BaseWorkspace`/`LocalWorkspace`/remote workspace and repo-cloning are separate concepts and need an applicable TS port.
- **Extensions** are not present yet. Port fetch/source-resolution and installation metadata only where they are useful without bringing back plugins/marketplace.
- **Observability** is not present yet. Python uses Laminar with OTEL-compatible environment switches; TS should use the standard JS OpenTelemetry/Laminar path if practical, otherwise a tiny no-op-compatible wrapper that can be wired to OTEL later.
- **Testing helpers** are not present yet. Python `TestLLM` corresponds to a scripted `LLMClient` helper in TS; port it as a public testing helper if it improves downstream tests without encouraging mocks of real code paths.
- **Plugin** and **marketplace** remain intentionally skipped. Do not create beads for them unless explicitly requested.


## Workflow: tests first (red/green)

**The first thing in every unit of work is tests.** We port the Python tests *and* the examples
before (or alongside) the implementation, and drive each module red → green:

1. Port the relevant Python tests to vitest (conceptually — adapt to TS idioms, don't copy).
2. Port the relevant examples so they compile and run against the new API.
3. Watch them fail (red).
4. Implement until they pass (green).

Examples and tests are first-class deliverables, not an afterthought — they define the public
API shape and are the executable spec for each phase.

## Principles

1. **Idiomatic TS, not literal port.** Respect the architecture (event/conversation/agent
   separation, tool abstraction) but use TS idioms: discriminated unions over class hierarchies
   where natural, `readonly`, narrow types, no Python-isms.
2. **Type enforcement is non-negotiable.** `strict` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes` + `verbatimModuleSyntax`. `no-explicit-any` is an error.
3. **Runtime validation = zod v4.** The pydantic equivalent. Pydantic `BaseModel` → zod schema +
   `z.infer` type. zod v4's native `z.toJSONSchema()` covers the spots Python uses
   `model_json_schema()` (tool/settings schemas) — no separate `zod-to-json-schema` dep.
4. **No code copy.** Read Python for behavior, write TS fresh. Port tests conceptually too.
5. **Tooling parity with oh-tab** unless justified: tsup (ESM+CJS), vitest, eslint
   type-checked, tsc strict, target ES2022.
6. **Wire-protocol compatibility.** TS types must serialize to the same JSON the Python SDK and
   agent-server expect. Round-trip serialization tests are the correctness anchor.
7. **Secret safety overrides source parity.** Settings and profiles may persist secret references,
   never raw secret values. Runtime secret values live in an OS keyring backend (macOS Keychain
   first) under the `openhands` service; encryption/cipher/plaintext-storage machinery from
   Python is not ported. LLM API keys are provider-scoped by default, with explicit per-profile
   overrides only when the same provider needs multiple credentials.

## Decisions (resolved 2026-06-23 with Engel)

1. **zod v4** (4.4.3). Native JSON Schema; drop `zod-to-json-schema`. Done.
2. **Single package** for starters; split into npm workspaces later.
3. **LLM: thin abstraction, fat clients.** `LLMClient` is a deliberately thin interface; most
   logic lives inside each client. **Do not over-abstract.** Four clients, each owning its API's
   correctness + performance (request building, streaming, prompt caching, error mapping):
   - OpenAI / OpenAI-compatible (chat completions)
   - Anthropic Messages
   - Gemini (new interactions API)
   - OpenAI Responses API

   The shared surface is *extracted from what clients actually share*, built last — not designed
   up front. Live-test scripts live in `scripts/live/` (NOT CI), keys from a GitHub environment
   named `llm`, run on demand to confirm each API still works. Low-level clients may be exported
   from the npm package for advanced SDK use and tests, but REST/product callers use profiles only.
4. **Pin upstream** at `9663409` (above). Local `~/repos/agent-sdk` synced to it.
5. **Secrets: OS keyring, not Python's storage split.** The Python SDK has environment-specific
   secret behavior (plaintext local paths plus encrypted-at-rest docker/remote/agent-server
   handling). We intentionally do not port that complexity. The TS package persists only secret
   references in settings/profiles and stores actual values in the OS keyring under service
   `openhands`. macOS Keychain is the first supported backend; add Windows Credential Manager or
   Linux Secret Service later only if the abstraction stays simple. Environment variables may be
   used as ephemeral import/input, but not as persistent storage. LLM key resolution follows the
   OpenHands-Tab profile behavior: provider key as the shared default, optional per-profile
   override when a particular profile needs a different credential for the same provider.

## Intended deviations from the Python SDK

We transpile **anew**, and on purpose we do NOT reproduce everything. The rule on public API:

> **Public APIs should be consistent with the Python SDK across the transpilation** —
> same shapes, same names (adapted to TS idioms) — **EXCEPT** for the deviations below.
> And even there, clean code / clean APIs win over fidelity. Idiomatic, clean TS is more
> important than matching Python signature-for-signature.

1. **No security analyzers. None.** We do not port the risk/security analyzer machinery. Drop it
   entirely — no `SecurityAnalyzer`, no risk scoring, no analyzer hooks.
2. **No confirmation mechanism. None.** No confirmation policy, no human-in-the-loop confirm
   gates, no approval step before an action runs. The agent acts; we don't gate it.
   **IMPORTANT — this is NOT the pending-actions queue.** We absolutely KEEP the multi-tool-use
   pending-action mechanics: when the LLM emits multiple tool calls in one response, those become
   a queue of `ActionEvent`s, executed (incl. in parallel via the `ParallelToolExecutor`
   equivalent), with the "unmatched actions" tracking (`get_unmatched_actions`) and cancellation
   support. That is core execution machinery and is required. Only the *confirmation gate* is
   dropped — not the action queue.
3. **LLM is profile-first at the product/REST boundary.** There is no Python-style
   bare/standalone `LLM` class in the supported REST path. REST callers configure and select a
   profile; the SDK resolves the client from the profile. **No model fallback chains, no implicit
   default model, nothing** — just profiles. The npm package may expose low-level clients for
   advanced SDK users and tests, but they are not the REST interface.
4. **Secrets are keyring-backed references.** Do not port Python's `Cipher`, local plaintext
   secret persistence, or docker/remote/agent-server encrypted-at-rest branching. Persistent
   settings/profiles contain stable references such as `{ service: 'openhands', account }`; the raw
   value is written to and read from OS keyring at runtime, then redacted from logs/events.
   Provider keys use accounts like `llm-provider:<providerId>` (for example `llm-provider:openai`
   or `llm-provider:litellm_proxy`). Per-profile overrides use accounts like
   `llm-profile:<profileId>:api-key`, and are only used when enabled/selected for that profile.

### LLM key resolution

LLM API key lookup is provider-driven, not model-family-driven. A profile whose provider is
`litellm_proxy` must resolve a `litellm_proxy` key even if its model string looks like an OpenAI,
Anthropic, or Gemini model. The default keyring account for a provider is:

- service: `openhands`
- account: `llm-provider:<providerId>`

Profiles may opt into a profile-scoped key only when the same provider needs distinct credentials
or endpoints. This covers cases like an app LiteLLM proxy profile and an eval LiteLLM proxy profile
that both use provider `litellm_proxy` but need different proxy API keys. The profile override
account is:

- service: `openhands`
- account: `llm-profile:<profileId>:api-key`

Resolution for a profile:

1. If the profile explicitly enables a profile key override and that key exists, use
   `llm-profile:<profileId>:api-key`.
2. Otherwise use `llm-provider:<providerId>`.
3. If neither exists, fail with a clear error telling the caller to set the provider key or enable
   and set a profile override.

Consequence for the roadmap:
- The Python `security` module (~2084 LOC: confirmation + risk + analyzer) is **mostly dropped**.
  P7 no longer includes security analyzers or confirmation. If any non-security piece currently
  lives under `security/` and is genuinely needed elsewhere, it moves to its real home — but the
  analyzer/confirmation surface itself is gone.
- The LLM product/REST surface is **profile-first**: `LLMProfile` in, resolved client out. Bare
  Python-style `LLM` is not part of the supported REST boundary. Low-level clients may remain
  exported for advanced SDK/test use.
- Secret handling is its own small settings/profile concern, not a port of Python's cipher stack:
  implement `SecretRef`/`SecretStore` around OS keyring, then make provider profiles refer to
  secrets by reference.

## Phased roadmap

Each phase is a bead (see `bd list`). Dependencies chained so `bd ready` surfaces the next
workable phase.

- **P1 — Foundations:** utils, logger, io, event model. Low-dependency leaves first; establishes
  the zod patterns and the event discriminated-union shape everything builds on.
- **P2 — Types & settings:** settings models, profiles, `SecretRef`, and the keyring-backed
  `SecretStore` abstraction. Settings/profiles serialize references only, never raw values.
  Model provider-key and profile-override references explicitly. Validates the zod approach at
  scale. Serialization round-trip tests. (deps: P1)
- **P3 — Tool abstraction + registry:** base Tool, schema gen via `z.toJSONSchema()`, then one
  concrete tool end-to-end. (deps: P1)
- **P4 — LLM layer (profile-first):** profiles are the supported product/REST entry point. The
  four clients (one sub-bead each, done end-to-end) sit behind profile resolution for REST, while
  low-level npm exports may remain available for advanced SDK/test use. Profiles resolve API keys
  through `SecretRef`/keyring, not embedded values: explicit
  profile override first when enabled, otherwise provider key by `providerId` (not by model
  family). No model fallback chains, no implicit default model. Plus the live-test harness +
  `llm` environment, then the minimal shared interface extracted last. (deps: P1)
- **P5 — Conversation + agent loop:** LocalConversation, RemoteConversation, ConversationState,
  agent step loop, stuck detection. (deps: P3, P4)
- **P6 — Context & condenser, skills:** context-window management, condensation, skill
  discovery/validation. (deps: P5)
- **P7 — Surrounding subsystems:** hooks, critic, subagent, git, mcp. **No security analyzers
  and no confirmation mechanism** (see Intended deviations). (deps: P5)
- **P8 — Concrete tools** (`openhands-tools` equivalent): terminal, file editor, browser,
  grep/glob, task tracker, etc. May become a separate package later. (deps: P3)
- **P9 — Packaging, examples, docs, release 0.1.0.** (deps: P6, P7, P8)

## Remaining beads after 0.1.0

These are the not-quite-done gaps to close next, in tests-first order where applicable:

1. **Remove confirmation residues.** Keep pending-action/multi-tool execution. Remove local/public confirmation-shaped APIs and file-agent `permission_mode` confirmation parsing unless a field is strictly needed for wire compatibility and is documented as ignored metadata.
2. **Conversation wire compatibility and restore migrations.** Add Python/TS golden JSON fixtures for events/conversation state, import/export round trips, and a restore migration utility that drops or maps intentionally unsupported Python fields such as security analyzer metadata.
3. **Workspace.** Port applicable workspace models and local workspace behavior, then remote workspace only if it cleanly matches the REST architecture.
4. **Extensions.** Port applicable extension source parsing/fetching and installation metadata. Do not port plugin/marketplace behavior as part of this bead.
5. **Observability.** Add a TS observability wrapper compatible with standard JS OTEL and, if practical, Laminar. It must be no-op when env vars are absent.
6. **Testing helpers.** Port Python `TestLLM` into a scripted `LLMClient` helper and transfuse applicable Python tests before implementation.
7. **Examples/tests coverage expansion.** Port applicable Python examples/tests for persistence, async/send-message-while-running, condenser, remote conversation, workspace, extensions, observability, and testing helpers. The examples workflow remains label/manual-only.

## Reference materials

- Python source: `~/repos/agent-sdk/openhands-sdk/openhands/sdk` and `openhands-tools`
- Old TS attempt (reference only, do not copy): `~/repos/oh-tab/packages/agent-sdk`
- Wire protocol: agent-server API + `OpenHands/typescript-client`
