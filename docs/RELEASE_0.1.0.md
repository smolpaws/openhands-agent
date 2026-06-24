# Release 0.1.0

First local release candidate for `@smolpaws/openhands-agent`, a fresh idiomatic TypeScript transpilation of the OpenHands Python `agent-sdk`.

## Included

- Strict TypeScript + zod v4 runtime schemas for events, tools, settings, profiles, context, and surrounding subsystems.
- Profile-first LLM layer for OpenAI chat completions, OpenAI Responses, Anthropic Messages, and Gemini.
- Agent and conversation loop: local/remote conversations, pending tool-call queue, parallel tool execution, and stuck detection.
- Context/condenser/skills support.
- Hooks, critics, file-based subagent definitions/registry, git helpers, and MCP tool wrappers.
- Concrete tools: terminal, file editor, glob, grep, task tracker, and injectable browser adapter.
- Examples in `examples/`.

## Intentional deviations from Python

The package does not port Python security analyzers, risk scoring, confirmation gates, Python Cipher, or Python secret-storage branching. Persistent secrets remain reference-only and are resolved through the TypeScript secret-store abstraction.

## Verification

Before the release commit:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm pack --dry-run
```
