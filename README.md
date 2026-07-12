# @smolpaws/openhands-agent

Idiomatic TypeScript transpilation of the [OpenHands](https://github.com/OpenHands/software-agent-sdk) Python `agent-sdk`.

## Status

`0.3.1` is the async persistence patch release of the fresh TypeScript transpilation. It covers the core SDK surfaces needed to build and run agent loops locally, adds durable local conversation history with non-blocking async FileStore locks for contended runtime paths, and documents the main architecture in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md):

- zod-backed event, tool, settings, profile, and serialization models
- profile-first LLM clients for OpenAI chat completions, OpenAI Responses, Anthropic, Gemini, and OpenAI-compatible profiles
- local/remote conversation state, disk-backed event logs, agent loop, pending tool-call queue, parallel execution, restore, and stuck detection
- context, condensers, skills, hooks, critics, file-based subagents, git helpers, MCP wrappers
- concrete tools: terminal, file editor, glob, grep, task tracker, and injectable browser adapter

Intentional deviations from Python remain: no ACP runtime, security analyzers, risk scoring, confirmation gates, Python Cipher, or Python secret-storage split. The Python `SecretRegistry` surface maps to the current TypeScript `SecretStore`/keyring model.

## Python SDK parity

This package is tracking the Python `agent-sdk` architecture while staying idiomatic TypeScript. The implemented surfaces currently include focused parity coverage for:

- LLM message/content serialization, OpenAI chat completions/Responses, Anthropic, and Gemini request/response mapping
- event schemas and `eventsToMessages` conversion, including parallel tool-call batching behavior
- conversation state, local/remote conversations, pause/resume, restore, parallel execution, and stuck detection
- settings/profiles, profile-selected LLM field hygiene, provider/profile-scoped API key references, and keyring-backed secret storage
- tools, workspace abstractions, git helpers, hooks, skills/context, MCP wrappers, critics, and file-based subagents

Accepted deviations are deliberate and should not be treated as missing work unless the product needs them later: ACP runtime execution, security/confirmation policy execution, and Python's older `SecretRegistry` API.

## Goals

- **Idiomatic TypeScript.** Not a literal line-by-line port. We respect the Python SDK's architectural choices and adapt them to TS conventions.
- **Type enforcement.** Strict TypeScript everywhere; runtime validation via [zod v4](https://github.com/colinhacks/zod) (replacing pydantic), using its native `z.toJSONSchema()` for tool/settings schema generation.
- **Fresh transpilation.** We do **not** copy existing code. The earlier TS attempt in `oh-tab` is outdated and serves only as a reference for tooling/tests.
- **Lower-risk secret handling.** Do not port Python's plaintext/local plus encrypted-at-rest remote secret stack. Persist secret references only; store actual secret values in the OS keyring under the `openhands` service. LLM API keys are provider-scoped by default, with per-profile overrides for cases like multiple proxy profiles for the same provider.
- **Tooling parity with `oh-tab`.** Same npm/build/test stack (tsup, vitest, eslint type-checked) unless there's a good reason to diverge.

## Tooling

| Concern | Choice |
|---------|--------|
| Language | TypeScript 5.9, `strict` + extra safety flags |
| Runtime validation | zod v4 (pydantic equivalent; native JSON Schema) |
| Bundler | tsup (ESM + CJS) |
| Tests | vitest |
| Lint | eslint with `recommended-type-checked` |

## Install

```sh
npm install @smolpaws/openhands-agent
```

For local development in this repo:

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run test:examples
```

## Quick start

```ts
import {
  Agent,
  ConversationState,
  FinishTool,
  LocalConversation,
  llmProfileSchema,
  messageSchema,
  type LLMClient,
} from '@smolpaws/openhands-agent';

const llm: LLMClient = {
  profile: llmProfileSchema.parse({ profileId: 'example', providerId: 'mock', model: 'mock' }),
  async complete() {
    return {
      message: messageSchema.parse({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'finish-1',
            name: 'finish',
            arguments: JSON.stringify({ message: 'Hello from TypeScript OpenHands.' }),
            origin: 'completion',
          },
        ],
      }),
      usage: null,
      raw: {},
    };
  },
};

const state = new ConversationState();
const conversation = new LocalConversation({
  agent: new Agent({ llm, tools: [FinishTool.create()] }),
  state,
});

conversation.sendMessage('Say hello and finish.');
await conversation.run();
console.log(state.executionStatus);
```

## Examples

Runnable TypeScript examples live in [`examples/`](examples/) and are checked by `npm run test:examples`. Real-LLM examples use [`examples/_shared/exampleProfile.ts`](examples/_shared/exampleProfile.ts): by default set `OPENAI_API_KEY` to run them against an OpenAI LLM profile, or set `LLM_PROVIDER_ID`/`LLM_PROVIDER` and the matching `<PROVIDER>_API_KEY` env var to exercise another provider. The helper stores keys under `llmProviderSecretRef(profile.providerId)`, optionally overrides the model with `OPENAI_MODEL` or `LLM_MODEL`, and skips gracefully when no provider key is present.

| Example | Covers |
|---------|--------|
| [`hello-world.ts`](examples/hello-world.ts) | Real OpenAI profile completion through the shared env-backed example profile helper |
| [`tools.ts`](examples/tools.ts) | Concrete terminal, file editor, glob, grep, and task tracker tools |
| [`profiles-and-secrets.ts`](examples/profiles-and-secrets.ts) | Provider/profile-scoped LLM API key references and secret store usage |
| [`agent-settings.ts`](examples/agent-settings.ts) | Agent settings/profile validation and profile-selected raw LLM field cleanup |
| [`conversation-patterns.ts`](examples/conversation-patterns.ts) | Real profile completion, pause/resume status, parallel tool execution, manual observation parsing, and stuck detection |
| [`skills-and-context.ts`](examples/skills-and-context.ts) | Agent context, static skills, and keyword-triggered skill suffixes |
| [`hooks.ts`](examples/hooks.ts) | Hook config and pre-tool-use hook execution |
| [`mcp.ts`](examples/mcp.ts) | MCP tool definitions, action argument sanitization, and observations |
| [`remote-workspace.ts`](examples/remote-workspace.ts) | Guarded remote workspace usage against an agent-server |

## Issue tracking

Work is tracked with [Beads](https://github.com/steveyegge/beads) (`bd`). The source of truth is `.beads/issues.jsonl`.

```sh
bd list --status open
bd show openhands-agent-1
```

## License

MIT
