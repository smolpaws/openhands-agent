# @smolpaws/openhands-agent

Idiomatic TypeScript transpilation of the [OpenHands](https://github.com/OpenHands/software-agent-sdk) Python `agent-sdk`.

## Status

`0.1.0` is the first local release candidate of the fresh TypeScript transpilation. It covers the core SDK surfaces needed to build and run agent loops locally:

- zod-backed event, tool, settings, profile, and serialization models
- profile-first LLM clients for OpenAI chat completions, OpenAI Responses, Anthropic, and Gemini
- local/remote conversation state, agent loop, pending tool-call queue, parallel execution, and stuck detection
- context, condensers, skills, hooks, critics, file-based subagents, git helpers, MCP wrappers
- concrete tools: terminal, file editor, glob, grep, task tracker, and injectable browser adapter

Intentional deviations from Python remain: no security analyzers, risk scoring, confirmation gates, Python Cipher, or Python secret-storage split.

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
npm test
npm run build
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

More examples live in [`examples/`](examples/).

## Issue tracking

Work is tracked with [Beads](https://github.com/steveyegge/beads) (`bd`). The source of truth is `.beads/issues.jsonl`.

```sh
bd list --status open
bd show openhands-agent-1
```

## License

MIT
