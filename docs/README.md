# Documentation

These documents describe `@smolpaws/openhands-agent`, the idiomatic TypeScript transpilation of the OpenHands Python `agent-sdk`.

## Durable documents

- [`TRANSPILE_CONTRACT.md`](TRANSPILE_CONTRACT.md) — compatibility promise, scope, policy IDs, dispositions, and pin-advance rules.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — current TypeScript component architecture and runtime boundaries.
- [`DRIFT_TOOLING.md`](DRIFT_TOOLING.md) — design for the canonical pin, generated interval reports, weekly watcher, server OpenAPI oracle, and differential evidence.

## Focused research

- [`NATIVE_TOOLS_RESEARCH.md`](NATIVE_TOOLS_RESEARCH.md) — provider-native tool calling research.
- [`REASONING_CAPABILITIES.md`](REASONING_CAPABILITIES.md) — provider/model-specific reasoning controls.
- [`PROMPT_CACHE_RETENTION.md`](PROMPT_CACHE_RETENTION.md) — prompt-cache retention evidence and decisions.

These are research records. Check current source/tests and provider documentation before treating time-sensitive provider details as current.

## Historical evidence

`RELEASE_*.md` files record release-specific changes and verification. They are history, not the current compatibility contract.

## Repository entry points

- Public package entry point: [`../src/index.ts`](../src/index.ts)
- Runnable examples: [`../examples/`](../examples/)
- Work tracking: [`../.beads/issues.jsonl`](../.beads/issues.jsonl)

Beads/issues track work only; they do not define parity.

## Verification commands

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
npm pack --dry-run
```
