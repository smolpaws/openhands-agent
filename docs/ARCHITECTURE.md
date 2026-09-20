# Architecture

`@smolpaws/openhands-agent` is an idiomatic TypeScript implementation of the OpenHands Python `agent-sdk` architecture. It keeps the Python SDK's core boundaries — events, messages, tools, workspaces, conversations, agents, context, and settings — while using TypeScript-native types, zod schemas, and explicit runtime adapters.

## Design principles

1. **Events are the durable protocol.** Conversations are persisted and replayed as typed event records. Components communicate through events rather than hidden mutable state.
2. **LLM messages are derived views.** The agent converts event history into provider-neutral `Message` values only at completion time.
3. **Tools are pure boundaries.** A tool validates an action payload, executes one capability, and returns a structured observation.
4. **Workspaces own execution context.** Local and remote workspace adapters isolate shell/file/git operations from the agent loop.
5. **Profiles own LLM configuration.** Product-facing callers select LLM profiles; clients resolve credentials through secret references.
6. **Runtime validation is explicit.** zod schemas replace pydantic models and guard persisted data, API-shaped data, and tool arguments.

## High-level data flow

```text
user input
  ↓
LocalConversation / RemoteConversation
  ↓ appends MessageEvent
ConversationState ──────────────┐
  ↓                              │
Agent.step                       │ event history
  ↓                              │
View + optional Condenser        │
  ↓                              │
eventsToMessages                 │
  ↓                              │
LLMClient.complete(messages, usable tools)
  ↓ provider client serializes ToolDefinition schemas
ConversationStateUpdateEvent(llm_usage)
  ↓ persists one accounting delta before dispatch
dispatchLlmResponse              │
  ├─ content/reasoning → MessageEvent
  └─ tool_calls → ActionEvent(s) → ToolDefinition.execute → ObservationEvent(s)
```

The durable transcript is always `ConversationState.events`. `Message[]` is a temporary projection used to call the LLM.

## Package map

| Area | Source | Responsibility |
|------|--------|----------------|
| Agent loop | `src/agent/` | Convert state to LLM messages, call the LLM, dispatch responses and tool calls. |
| Conversation runtime | `src/conversation/` | Local/remote orchestration, state, restore, pause/resume, stuck detection, parallel tool execution. |
| Events | `src/event/` | zod-backed event schemas, event union types, event-to-message conversion. |
| LLM | `src/llm/` | Provider-neutral message/content types plus OpenAI, Responses, Anthropic, Gemini clients. |
| Tools | `src/tool/`, `src/tools/` | Tool definitions/registry plus concrete terminal, file editor, glob, grep, task tracker, browser adapter. |
| Workspace | `src/workspace/` | Local and remote execution/files/git substrate. |
| Settings/profiles/secrets | `src/settings/`, `src/profiles/`, `src/secrets/` | Agent settings, LLM profile settings, profile hygiene, and keyring-backed secret references. |
| Context/skills/condenser | `src/context/`, `src/skills/` | Prompt context, activated skills, and condensation views. |
| Hooks | `src/hooks/` | Lifecycle hook configuration and hook execution results. |
| MCP | `src/mcp/` | MCP tool wrapper definitions, action conversion, observations. |
| Surrounding subsystems | `src/git/`, `src/critic/`, `src/subagent/`, `src/extensions/`, `src/observability/`, `src/testing/` | Supporting APIs ported where relevant for the TypeScript SDK. |

## Events and messages

Events live in `src/event/index.ts` and use a discriminated `kind` field. They are designed to be persisted, restored, and exchanged across local/remote boundaries.

Important event families:

- `MessageEvent` — user/assistant/system/tool messages from the transcript.
- `SystemPromptEvent` — system prompt plus optional dynamic context.
- `ActionEvent` — one LLM-requested tool call, including original `MessageToolCall` metadata.
- `ObservationEvent` — successful tool result.
- `AgentErrorEvent` and `UserRejectObservation` — observation-like events for failed or rejected actions.
- `Condensation` and `CondensationSummaryEvent` — context-window management artifacts.
- `ConversationStateUpdateEvent`, `PauseEvent`, `InterruptEvent`, `HookExecutionEvent`, and ACP compatibility events.

`eventsToMessages()` is the bridge from durable transcript to provider-neutral LLM messages. It:

- merges adjacent plain user messages, matching Python SDK behavior for synthetic context;
- does **not** merge user messages that carry `tool_calls`, `tool_call_id`, or `name`;
- combines adjacent `ActionEvent`s with the same `llm_response_id` into one assistant message with parallel tool calls;
- preserves reasoning/thinking metadata on assistant action messages.

## Agent and conversation runtime

`Agent` is intentionally small. It owns:

- an `LLMClient`;
- a list of executable `ToolDefinition`s;
- optional `AgentContext`, `Condenser` and separately configured hard fallback;
- the per-step orchestration method `step(state)`.

A step performs:

1. capture the input boundary and render fixed context, then resolve available model metadata;
2. rebuild a `View` with tool-history property enforcement;
3. prepare the selected context mode: ordinary condensation may persist a summary and return; opt-in agent reset emits advisory warnings without a proactive summary;
4. call `LLMClient.complete(messages, tools)` with the agent's usable `ToolDefinition`s;
5. persist one `llm_usage` record from the returned usage, identity and timing;
6. dispatch the result with `dispatchLlmResponse()`.

Passing tools matches the pinned Python Agent, which passes its resolved `tools_map` values through `make_llm_completion()`. The opt-in reset lifecycle below is a separate target policy. The TypeScript `LLMClient` remains a thin transport boundary: it receives executable tool definitions but does not reshape them. Provider clients that support native tools own their wire format and derive schemas from `ToolDefinition` helpers; Agent and server code must not construct provider-specific tool DTOs.

`LocalConversation` owns the local run loop around an `Agent` and `ConversationState`. `RemoteConversation` mirrors the public shape for an agent-server-backed runtime. `ConversationState` is the append-only event log plus execution status.

`ConversationState.stats` derives per-usage metrics from immutable accounting deltas. Raw provider usage and cost provenance remain on each record; compact snapshots omit history lists. Unknown fields and unmeasured historical responses remain visible. [LLM metrics](LLM_METRICS.md) describes the native persistence contract, upstream differences and auxiliary-call limits.

`dispatchLlmResponse()` preserves every returned tool call as an `ActionEvent`. `ParallelToolExecutor` then runs pending batches with a configurable concurrency limit, so adding tool definitions to completion does not collapse or bypass multi-tool dispatch. This is distinct from Python's confirmation gates: pending/parallel actions are core execution machinery and are retained; confirmation/security policy execution is deliberately not ported.

`StuckDetector` scans recent events for repeated action/observation loops, repeated action/error loops, or agent monologues after the last user turn.

## LLM layer

The neutral LLM model lives in `src/llm/index.ts`:

- `Content` is `TextContent | ImageContent`.
- `Message` normalizes string/null/list content into a consistent content array.
- `MessageToolCall` captures tool call IDs, response-item IDs, function names, JSON arguments, and origin (`completion` or `responses`).
- `reduceTextContent()` and `contentToString()` provide compatibility helpers.

The SDK owns provider compatibility normally supplied by LiteLLM in Python. Protocol normalization belongs in these clients; shared capability decisions live in `src/llm/provider-quirks.ts`. The [LLM provider implementation guide](LLM_PROVIDERS.md) describes where to put fixes and how to test them without expanding the shared `LLMClient` interface.

Provider clients live next to the neutral model:

- `OpenAIChatClient` for chat completions and compatible proxies.
- `OpenAIResponsesClient` for the Responses API.
- `AnthropicMessagesClient` for Anthropic Messages.
- `GeminiClient` for the Gemini Interactions API.

The product boundary is profile-first: `createClientFromProfile(profile, secretStore)` resolves a concrete client from an `LLMProfile`. Product and REST callers select profiles; they do not instantiate a raw Python-style `LLM`, pass loose model/provider fields, or rely on implicit default models. Low-level provider clients and provider-specific factories remain exported only as explicit advanced SDK/test building blocks.

This goes further than upstream Python intentionally. The Python SDK is the architectural source, but this TypeScript package makes the product LLM boundary stricter and cleaner:

- `LLMProfile` is the supported product-facing LLM configuration object.
- `AgentSettings` and `AgentProfile` reference profiles by ID (`llm_profile_ref`) instead of duplicating raw LLM fields.
- `clearRawLlmFieldsWhenProfileSelected()` removes stale raw-provider settings once a profile is selected.
- `createClientFromProfile()` dispatches by `providerId` first, then by `baseUrl` for custom/internal gateways.
- Explicit provider factories are still available for advanced SDK tests and provider-specific code.

The four provider APIs are implemented as the APIs they actually are, not hidden behind an over-broad abstraction:

- OpenAI-compatible Chat Completions owns chat-completions request/response shape and compatible proxy behavior.
- OpenAI Responses owns Responses-specific input, tool, reasoning, and replay fields.
- Anthropic Messages owns Anthropic content blocks, prompt caching, extended-thinking details, `tool_use` calls, and `tool_result` continuation.
- Gemini owns Interactions steps, flat function tools, signed thought replay, `function_call` parsing, and `function_result` continuation.

Every client receives the same optional `ToolDefinition[]` through `LLMClient.complete()` and derives its provider declaration from `ToolDefinition.toResponsesTool()`. Chat Completions wraps that schema in its nested function shape; Responses uses the top-level shape; Anthropic renames `parameters` to `input_schema`; Gemini uses a flat function declaration and removes JSON Schema fields its API rejects. All clients omit the wire-level `tools` field when the supplied list is empty.

Gemini requests use documented stateless Interactions mode (`store: false`) and reconstruct `user_input`, `thought`, `model_output`, `function_call`, and `function_result` steps from the durable neutral transcript. This keeps conversation restore and forks correct instead of coupling an SDK client instance to server-side `previous_interaction_id` state. Signed thought steps round-trip through `Message.thinking_blocks`.

`oh-tab/packages/agent-sdk` was used as inspiration for product-level profile semantics, key lookup shape, and build/test tooling expectations. It was not copied: the implementation is fresh TypeScript, and the older package remains reference-only.

Compatibility details intentionally covered by tests:

- old `TextContent.enable_truncation` and old message serialization-control fields are accepted and dropped;
- assistant tool-call messages omit empty content, matching Python/OpenAI expectations;
- provider-scoped API keys resolve by `providerId`, not by model string family.

## Settings, profiles, and secrets

Settings are zod-validated data structures in `src/settings/` and `src/profiles/`.

The supported model is:

- host applications persist serializable `LLMProfile` records and pass selected profiles into this package;
- persisted settings contain profile IDs (`llm_profile_ref`) and secret references, not raw secret values;
- provider API keys default to `llm-provider:<providerId>`;
- profile override keys use `llm-profile:<profileId>:api-key` and are only selected when enabled;
- raw LLM fields are cleaned when a profile is selected through `clearRawLlmFieldsWhenProfileSelected()`.

This package deliberately does not pick a global on-disk LLM profile database or config path. `LLMProfile` is a zod-validated data contract, not a singleton local registry. A product such as Agent Canvas or OpenHands Tab may store profile JSON wherever its settings system lives, then provide the selected profile to `createClientFromProfile()`. Examples use `InMemorySecretStore` and construct profiles in process.

`SwitchLLMTool.create({ profileNames, switchProfile })` exposes the optional saved-profile tool. Hosts resolve names, build the replacement client, and durably accept the selection in `switchProfile`; a pending selection can activate through `LocalConversation.onStepBoundary` before the next model call. The boundary runs before the first step and after complete persisted tool batches, including a final finish. Returning an `Agent` replaces only the active agent; the same conversation state and run budget continue. Concurrent `run()` callers share one run. The read-only `lastStepUserMessageId` tells hosts which user event the latest step actually saw, so later queued input can be handled separately.

Accounting records retain a non-secret profile-origin digest. Before a host callback may change the binding, the conversation anchors legacy history to the original binding. `Agent.step` projects outgoing history for the current profile: foreign signed/encrypted reasoning is removed while visible text, tools, plaintext reasoning, stored events, and metrics remain intact. See DEV-SDK-008 for the conservative legacy rules and excluded credential/header/query identity fields; this is broader than pinned Python's subscription-only Responses filtering.

Raw API keys are separate from profile JSON. With `MacOSKeychainSecretStore`, values live in macOS Keychain generic-password items under service `openhands` and accounts such as `llm-provider:openai`, `llm-provider:gemini`, `llm-provider:anthropic`, or `llm-profile:<profileId>:api-key`. This intentionally replaces Python's `SecretRegistry`/Cipher/storage split with the current `SecretStore` and keyring-oriented surface.

## Tools and workspaces

`ToolDefinition` is the public tool abstraction:

- validates inputs with a zod schema;
- optionally validates outputs;
- emits OpenAI Responses-compatible tool definitions and MCP tool shapes;
- delegates execution to an executor function.

Concrete tools in `src/tools/` include terminal, file editor, glob, grep, task tracker, finish, and injectable browser adapters. They are usable directly or through the agent loop.

Workspaces in `src/workspace/` separate execution substrate from agent logic:

- `LocalWorkspace` executes commands/files/git against the local filesystem.
- `RemoteWorkspace` targets an agent-server-compatible HTTP runtime.
- workspace factory helpers create the correct implementation from settings.

## Context, skills, hooks, and MCP

`AgentContext` composes repository guidance, current time, and skills into prompt suffixes. Skills support static content and keyword triggers; activated skills can contribute user-message suffixes without changing the durable event protocol.

Explicit non-AgentSkills skills with `trigger: null` include their complete body in `REPO_CONTEXT`; hosts can use this for durable instruction files. Automatic upstream memory-index loading (`load_memory` / `memory_context`) is a separate, deferred feature. See [context and memory evidence](../transpile/context-memory.md) for the current limits, persistence distinction, and tracking.

Condensers operate on `View` objects while the complete event log remains unchanged. `View.fromEvents()` replays summaries and enforces observation uniqueness, complete parallel batches, tool-call/result matching and whole thinking tool loops to a fixed point. Its manipulation indices identify safe summary boundaries. Incomplete tool exchanges are excluded from the model View, not deleted from the log.

`LLMSummarizingCondenser` implements the pinned Python request/event/token triggers, safe-range selection, minimum progress and full-context reset fallback. It uses its own LLM client without tools. Class/settings defaults and `defaultCondenser(llm)` all use 1000 events and 2 retained first events under [DEV-SDK-011](TRANSPILE_CONTRACT.md#dev-sdk-011--shared-condenser-event-defaults); explicitly configured values are preserved. Thresholds are strict greater-than. Event-only condensation is soft: if no safe cut exists, another step may create one. Requests and token overflow are hard: a failed safe cut attempts whole-view reset up to five times, progressively shortening rendered previews. There is no detached background summary task.

A condenser returns a View or a Condensation, synchronously or asynchronously. `PipelineCondenser` preserves synchronous callers when its members are synchronous and awaits asynchronous members in order. `Agent.step` provides the actual fixed system/context and usable tools to token counting, projects summary history for the selected condenser profile, and persists each summary attempt under usage ID `condenser`. For ordinary capable summarizers, typed context-window or malformed-history failures append a `CondensationRequest`; a later step condenses, and a subsequent step retries the main model with the reduced View. Unsupported ordinary condensers propagate the original failure. Agent-reset mode has the separate error-only fallback described below.

`LocalConversation.condense()` serializes one forced step with ordinary run steps. `RemoteConversation.condense()` posts through the existing authenticated conversation endpoint. Settings materialization validates the supported condenser variants and resolves a separate explicit profile reference through a host callback. [Condensation port evidence](../transpile/condensation.md) records source mapping, generated Python oracles and remaining limits.

### Agent-controlled context reset

The opt-in implementation being integrated on 2026-09-20 adds
`AgentResetCondenser` alongside the existing summarizer. It supplies advisory
thresholds and returns the unchanged View during ordinary preparation.
`Agent` installs the `condense` tool for this mode and owns request/commit handling
through `src/agent/context-reset.ts`; the tool itself does not write notes or reset
the View. Integration/release evidence is tracked in
[agent-reset evidence](../transpile/agent-reset.md), separately from the completed
standard-condensation port.

`src/context/context-warnings.ts` counts the full prospective main-model request,
including fixed context and tools. An explicit main-profile `maxInputTokens`
overrides a different effective client limit; absent explicit limits may use resolved
metadata. Unknown measurements remain unknown. Crossings are persisted as
`agent_context_warning` state updates and projected into environment-source
user-role messages. Warnings do not block requests or trigger condensation, even
at estimates of 100% or more. Only a committed Condensation rearms the warnings.

`src/tool/condense.ts` defines the optional `message_to_future_self` action field
and structured result. Existing ActionEvent/ObservationEvent envelopes retain the
real IDs and payloads. A versioned `CondensationRequest.details` records agent or
provider-error provenance and an input boundary; `Condensation.reset` correlates
the commit. `View` validates this metadata and projects fixed context, the exact
notice `The agent triggered context condensation.`, the real tool exchange and
late input. There is no summary on the voluntary path and no retained old
prefix/tail. The underlying event log and files remain intact. The model is told
to recover from its notes; a frozen host memory snapshot is not automatically refreshed.

The settings boundary is two sibling options:

```json
{
  "llm_profile_ref": "main",
  "condenser": {
    "condenser_kind": "agent_reset",
    "warning_thresholds": [0.75, 0.80, 0.85, 0.90]
  },
  "hard_condenser": {
    "condenser_kind": "llm_summarizing",
    "llm_profile_ref": "summary"
  }
}
```

`materializeCondenser` creates reset mode without profile or metadata lookup.
`materializeHardCondenser` resolves only the explicit fallback reference; omitted
or null settings produce no fallback. It accepts retry/scaling controls, not
ordinary cut/token/event limits. The host persists independent secret-free profile
bindings; main-profile changes must not silently replace the fallback.

Only a caught typed main-provider context-window error activates that optional
fallback. The Agent calls `hardContextReset` directly on the eligible old View,
preserves pending/rejected-request input, and commits an environment notice before
the generated summary. This mode uses no pipeline and does not first invoke an
ordinary prefix/tail summary. Other provider errors keep their own handling.
Failed or interrupted recovery preserves history; restoration must not blindly
repeat paid work. `LocalConversation.condense()` rejects this mode with the typed
`AgentControlledCondensationError` because host maintenance has no genuine tool
call. Standard summarizer maintenance remains supported.

The tool is EXT-SDK-004; the opt-in lifecycle/event/replay differences are
DEV-SDK-012. SDK review and merge remain prerequisites for server vendoring and
host integration; this SDK change does not enable a product deployment.

Hooks are lifecycle-sidecar processes. Hook results can allow/block and attach additional context. They are represented as hook execution results/events rather than as confirmation gates.

MCP wrappers turn MCP tool specs into SDK tool-like definitions. `MCPToolAction` sanitizes argument payloads, `MCPToolExecutor` calls a connected MCP client with timeout handling, and `MCPToolObservation` converts MCP text/image blocks into SDK content.

## Remote/runtime boundaries

The TypeScript package is a library. It can talk to a remote agent server through `RemoteConversation` and `RemoteWorkspace`, but it does not contain the Python `openhands-agent-server` implementation.

A caller choosing a remote runtime should keep these boundaries:

- local package code owns schemas, settings, examples, and client-side orchestration;
- agent-server owns process execution and remote files;
- credentials stay in secret stores/keyrings and are passed only to the service that needs them.

`FileStore.lock()` remains available for synchronous local persistence parity, but its retry wait blocks the Node.js event loop when lock files are contended. `FileStore.lockAsync()` provides the non-blocking counterpart for hot server/runtime paths; `EventLog.appendAsync()`, `ConversationState.appendEventAsync()`, and `LocalConversation.sendMessageAsync()` route through it.

## Accepted deviations from Python

These are deliberate for the current product direction:

- no ACP runtime execution;
- no security analyzer/risk scoring implementation;
- no human confirmation policy/gates;
- no Python Cipher or plaintext/encrypted-at-rest storage split;
- no marketplace/plugin runtime unless requested later.

Compatibility shims may still exist for persisted data or downstream migration, but they should be documented as ignored or mapped metadata rather than revived as full subsystems.

## Testing and examples

Tests are the executable parity spec. Important suites live next to their modules under `src/**/__tests__/`.

Runnable examples in `examples/` cover:

- real OpenAI profile completion through `examples/_shared/exampleProfile.ts` when `OPENAI_API_KEY` is set;
- graceful local skips for real-LLM examples when no key is present;
- concrete tools;
- settings/profiles/secrets;
- pause/resume state and parallel execution;
- skills/context;
- hooks;
- MCP wrappers;
- guarded remote workspace usage.

Before release, run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run typecheck:examples
npm run test:examples
npm pack --dry-run
```
