# Documentation

This directory captures the working documentation for `@smolpaws/openhands-agent`, the idiomatic TypeScript transpilation of the OpenHands Python `agent-sdk`.

## Current docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — main component architecture and data flow.
- [`TRANSPILE_PLAN.md`](TRANSPILE_PLAN.md) — upstream target, parity principles, accepted deviations, and remaining roadmap.
- [`RELEASE_0.2.0.md`](RELEASE_0.2.0.md) — current 0.2.0 release notes.
- [`RELEASE_0.1.0.md`](RELEASE_0.1.0.md) — first local release candidate notes.

## Repository entry points

- Public package entry point: [`../src/index.ts`](../src/index.ts)
- Runnable examples: [`../examples/`](../examples/)
- Beads issue source: [`../.beads/issues.jsonl`](../.beads/issues.jsonl)

## Verification commands

Run these before cutting a release:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run typecheck:examples
npm run test:examples
npm pack --dry-run
```
