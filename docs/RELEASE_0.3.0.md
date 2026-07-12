# Release 0.3.0

`0.3.0` is the event-log persistence release for `@smolpaws/openhands-agent`. It builds on the 0.2.0 parity baseline with durable local conversation history, live-provider hardening, and the profile-first LLM client dispatcher needed by downstream SmolPaws usage.

## Highlights

- Added disk-backed conversation event persistence:
  - `EventLog` append/read/refresh support
  - event filename indexing and duplicate-event detection
  - contiguous-index recovery when stale writers observe disk gaps
  - JSON serialization that omits null optional fields for Python wire compatibility
- Integrated persistence into local conversations:
  - `LocalConversation` can restore from an event log
  - `ConversationState` can seed, sync, and rebuild from persisted events
  - constructor seeding is idempotent for already-persisted events
  - large persisted logs sync without spreading arrays into call arguments
- Hardened local file locking:
  - lock-file creation uses synchronous single-process semantics for local parity
  - fresh/old malformed lock files are handled differently to avoid deleting in-progress locks
  - lock cleanup closes descriptors before unlinking failed lock files
  - reentrant and async callbacks are rejected for the synchronous lock API
- Added the profile-first LLM client dispatcher:
  - `createClientFromProfile()` resolves the right provider client from an `LLMProfile`
  - OpenAI-compatible profile aliases normalize to the OpenAI chat-completions client
  - provider/profile secret resolution remains reference-based, not raw-key based
- Ported and hardened provider behavior:
  - OpenAI usage parsing and real LLM examples
  - OpenAI Responses reasoning live script
  - Anthropic prompt-cache live smoke script
  - Gemini thinking config/thought-signature round-trip coverage for current Gemini models
- Updated examples CI and shared example profile handling so real-provider examples can run from provider-specific environment keys.

## Included SDK surfaces

The 0.3.0 package includes the 0.2.0 SDK surface plus durable local event-log persistence and profile-selected LLM dispatch:

- strict TypeScript and zod v4 runtime schemas for events, messages, settings, profiles, tools, and surrounding subsystems;
- profile-first LLM clients for OpenAI chat completions, OpenAI Responses, Anthropic Messages, Gemini, and OpenAI-compatible profiles;
- agent and conversation loop with local/remote conversations, append-only in-memory state, disk-backed event logs, pending/parallel tool execution, pause/resume, restore, and stuck detection;
- context, condensers, skills, hooks, critics, subagents, git helpers, MCP wrappers, observability/test helper stubs, and extensions metadata helpers;
- concrete tools: terminal, file editor, glob, grep, task tracker, finish, and injectable browser adapter;
- local and remote workspace abstractions.

## Intentional deviations from Python

The following remain deliberate product choices, not release blockers:

- no ACP runtime execution;
- no security analyzers, risk scoring, or confirmation gates;
- no Python Cipher or Python secret-storage branching;
- Python `SecretRegistry` semantics map to the TypeScript `SecretStore`/keyring-oriented surface;
- no plugin/marketplace runtime unless explicitly brought back later.

Pending/parallel tool-call execution is **not** a dropped confirmation feature. It remains core execution machinery and is tested.

## Known follow-up

- `FileStore.lock()` is synchronous. Lock contention blocks the Node.js event loop, so server/runtime paths that may contend should move to a future async lock API. This is tracked as Bead `openhands-agent-bbh`.
- Gemini 2.5-specific `thinkingBudget` support is intentionally not included. Gemini 2.5 is obsolete for this SDK target and is not worth model-specific support now that current Gemini models use `thinkingLevel`/thought signatures.

## Verification

Run before publishing/tagging:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run typecheck:examples
npm run test:examples
npm pack --dry-run
```

Verification result for the release commit:

- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm test` — passed, 41 files / 232 tests
- `npm run build` — passed
- `npm run typecheck:examples` — passed
- `npm run test:examples` — passed
- `npm pack --dry-run` — passed

## Upgrade notes from 0.2.0

- Package metadata moves to `0.3.0`.
- Local conversation persistence is now available through `EventLog`-backed state/conversation construction.
- Persisted event JSON omits null optional fields for Python-compatible restore behavior.
- The low-level synchronous file lock is documented as local/parity-oriented; do not use it on contended server paths without the forthcoming async lock API.
- Legacy OpenAI-only profile factory aliases have been removed; use the generic `createClientFromProfile()` dispatcher or explicit provider factories such as `createOpenAIChatClientFromProfile()`.
