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
- optional `AgentContext` and `Condenser`;
- the per-step orchestration method `step(state)`.

A step performs:

1. build a `View` from `ConversationState.events`;
2. optionally condense the view;
3. render context/system prompt suffixes;
4. call `LLMClient.complete(messages, tools)` with the agent's usable `ToolDefinition`s;
5. dispatch the result with `dispatchLlmResponse()`.

This matches the pinned Python Agent, which passes its resolved `tools_map` values through `make_llm_completion()`. The TypeScript `LLMClient` remains a thin transport boundary: it receives executable tool definitions but does not reshape them. Provider clients that support native tools own their wire format and derive schemas from `ToolDefinition` helpers; Agent and server code must not construct provider-specific tool DTOs.

`LocalConversation` owns the local run loop around an `Agent` and `ConversationState`. `RemoteConversation` mirrors the public shape for an agent-server-backed runtime. `ConversationState` is the append-only event log plus execution status.

`dispatchLlmResponse()` preserves every returned tool call as an `ActionEvent`. `ParallelToolExecutor` then runs pending batches with a configurable concurrency limit, so adding tool definitions to completion does not collapse or bypass multi-tool dispatch. This is distinct from Python's confirmation gates: pending/parallel actions are core execution machinery and are retained; confirmation/security policy execution is deliberately not ported.

`StuckDetector` scans recent events for repeated action/observation loops, repeated action/error loops, or agent monologues after the last user turn.

## LLM layer

The neutral LLM model lives in `src/llm/index.ts`:

- `Content` is `TextContent | ImageContent`.
- `Message` normalizes string/null/list content into a consistent content array.
- `MessageToolCall` captures tool call IDs, response-item IDs, function names, JSON arguments, and origin (`completion` or `responses`).
- `reduceTextContent()` and `contentToString()` provide compatibility helpers.

Provider clients live next to the neutral model:

- `OpenAIChatClient` for chat completions and compatible proxies.
- `OpenAIResponsesClient` for the Responses API.
- `AnthropicMessagesClient` for Anthropic Messages.
- `GeminiClient` for Gemini.

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
- Anthropic Messages owns Anthropic content blocks, prompt caching, and extended-thinking details.
- Gemini owns GenerateContent parts, function-call parts, `thoughtSignature` round-tripping, and Gemini thinking config.

For OpenAI, Chat Completions wraps the schema produced from `ToolDefinition.toResponsesTool()` in its nested function-tool shape, while Responses uses the helper's native top-level shape. Both omit the wire-level `tools` field when the supplied list is empty. These are provider-client concerns; the shared completion interface carries `ToolDefinition`s without a parallel DTO layer.

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

Condensers operate on `View` objects. A condenser either returns a smaller `View` or a `Condensation` event. `PipelineCondenser` runs condensers in sequence and short-circuits when one emits a condensation.

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
