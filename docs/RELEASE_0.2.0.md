# Release 0.2.0

`0.2.0` is the first documentation-backed parity release for `@smolpaws/openhands-agent`. It builds on the 0.1.0 local release candidate with smolpaws integration seams, additional Python SDK parity tests, expanded examples, and architecture documentation.

## Highlights

- Added smolpaws compatibility helper exports:
  - `isMessageEvent`
  - `isConversationStateUpdateEvent`
  - `reduceTextContent`
- Proved workspace/settings seams with tests for:
  - `LocalWorkspace`/`RemoteWorkspace` factory instances
  - canonical `OpenHandsAgentSettings` field parity
- Added profile-selected LLM field hygiene:
  - `RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED`
  - `clearRawLlmFieldsWhenProfileSelected()`
- Added focused Python SDK parity coverage for implemented surfaces:
  - deprecated `TextContent.enable_truncation` compatibility
  - deprecated message serialization-control fields
  - OpenAI assistant tool-call messages with empty content
  - `eventsToMessages()` user-message merge guards
  - parallel action thought guard behavior
- Expanded runnable TypeScript examples:
  - `examples/agent-settings.ts`
  - `examples/conversation-patterns.ts`
  - `examples/mcp.ts`
  - `examples/remote-workspace.ts`
- Updated README and docs for current parity status, example inventory, and component architecture.

## Included SDK surfaces

The 0.2.0 package includes:

- strict TypeScript and zod v4 runtime schemas for events, messages, settings, profiles, tools, and surrounding subsystems;
- profile-first LLM clients for OpenAI chat completions, OpenAI Responses, Anthropic Messages, and Gemini;
- agent and conversation loop with local/remote conversations, append-only state, pending/parallel tool execution, pause/resume, restore, and stuck detection;
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
- `npm test` — passed, 35 files / 186 tests
- `npm run build` — passed
- `npm run typecheck:examples` — passed
- `npm run test:examples` — passed

## Upgrade notes from 0.1.0

- Package metadata moves to `0.2.0`.
- Consumers using profile-selected settings should call `clearRawLlmFieldsWhenProfileSelected()` before persisting mixed profile/raw LLM forms.
- Consumers relying on OpenAI tool-call serialization now get Python-compatible omission of empty assistant content.
- Documentation now treats the docs directory as the primary architecture/release reference.
