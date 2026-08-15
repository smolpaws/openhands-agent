# @smolpaws/openhands-agent

Idiomatic TypeScript transpilation of the OpenHands Python `agent-sdk`.

The durable maintenance rules live in [`docs/TRANSPILE_CONTRACT.md`](docs/TRANSPILE_CONTRACT.md). The current target architecture lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The planned generated drift/oracle system is specified in [`docs/DRIFT_TOOLING.md`](docs/DRIFT_TOOLING.md). Release notes under `docs/RELEASE_*.md` contain historical status and verification evidence.

## Compatibility

The package preserves the observable OpenHands SDK contract while using TypeScript-native implementation choices such as strict types, zod schemas, discriminated unions, and provider-native LLM clients.

Intentional policy differences are small and explicit in the transpilation contract. In particular, the current product direction does not reproduce security analyzers/risk scoring, confirmation gates, ACP runtime execution, Python's secret-persistence model, plugin runtime, or marketplace runtime. Product/REST LLM configuration is profile-first and persistent secrets are references resolved through `SecretStore`.

The SDK and TypeScript agent-server advance against the same pinned upstream commit in bounded `OLD_PIN..NEW_PIN` batches. Upstream changes are classified before coding and compatibility work remains tests-first/red-green.

## Main surfaces

- zod-backed events, messages, tools, settings, profiles, and serialization
- local/remote conversation state, durable event logs, restore, pause/resume, and stuck detection
- agent loop with pending/parallel tool actions and cancellation
- OpenAI-compatible Chat Completions, OpenAI Responses, Anthropic Messages, and Gemini Interactions clients
- profile-based client construction and secret references
- contexts, condensers, skills, hooks, critics, subagents, git, MCP, and observability helpers
- local/remote workspaces
- concrete terminal, file-editor, glob, grep, task-tracker, finish, and browser-adapter tools

## Install

```sh
npm install @smolpaws/openhands-agent
```

## Development

```sh
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
```

Provider live smokes are opt-in. They prove that a provider API still accepts our requests; they are not Python/TypeScript parity tests.

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
  profile: llmProfileSchema.parse({
    profileId: 'example',
    providerId: 'mock',
    model: 'mock',
  }),
  async complete() {
    return {
      message: messageSchema.parse({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'finish-1',
          name: 'finish',
          arguments: JSON.stringify({ message: 'Hello from TypeScript OpenHands.' }),
          origin: 'completion',
        }],
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

## Documentation

- [`docs/TRANSPILE_CONTRACT.md`](docs/TRANSPILE_CONTRACT.md) — scope, compatibility policy, deviations, and upstream update procedure
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current TypeScript architecture
- [`docs/DRIFT_TOOLING.md`](docs/DRIFT_TOOLING.md) — generated drift reports, pin provenance, and differential-oracle design
- [`docs/`](docs/) — provider research and release evidence

## Work tracking

Beads/issues track implementation work. They are not the compatibility contract or source of truth for what parity means.

## License

MIT
