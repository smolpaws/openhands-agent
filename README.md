# @smolpaws/openhands-agent

Idiomatic TypeScript transpilation of the [OpenHands](https://github.com/OpenHands/software-agent-sdk) Python `agent-sdk`.

## Status

🚧 Early scaffolding. The transpilation plan is tracked in [beads](#issue-tracking) — see the first issue for the full roadmap.

## Goals

- **Idiomatic TypeScript.** Not a literal line-by-line port. We respect the Python SDK's architectural choices and adapt them to TS conventions.
- **Type enforcement.** Strict TypeScript everywhere; runtime validation via [zod](https://github.com/colinhacks/zod) (replacing pydantic).
- **Fresh transpilation.** We do **not** copy existing code. The earlier TS attempt in `oh-tab` is outdated and serves only as a reference for tooling/tests.
- **Tooling parity with `oh-tab`.** Same npm/build/test stack (tsup, vitest, eslint type-checked) unless there's a good reason to diverge.

## Tooling

| Concern | Choice |
|---------|--------|
| Language | TypeScript 5.9, `strict` + extra safety flags |
| Runtime validation | zod + zod-to-json-schema (pydantic equivalent) |
| Bundler | tsup (ESM + CJS) |
| Tests | vitest |
| Lint | eslint with `recommended-type-checked` |

## Issue tracking

Work is tracked with [Beads](https://github.com/steveyegge/beads) (`bd`). The source of truth is `.beads/issues.jsonl`.

```sh
bd list --status open
bd show openhands-agent-1
```

## License

MIT
