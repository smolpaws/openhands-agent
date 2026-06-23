# Transpile Plan — Python OpenHands agent-sdk → idiomatic TypeScript

> Source of truth for the roadmap is the beads issue **`openhands-agent-jad`**.
> This doc mirrors it in Markdown for easy reading. Keep them in sync.

## Objective

Produce `@smolpaws/openhands-agent`: a fresh, idiomatic TypeScript implementation of the
OpenHands Python `agent-sdk` (local source: `~/repos/agent-sdk`, upstream
`OpenHands/software-agent-sdk`). We transpile *anew* — we do **not** copy the outdated TS
attempt in `oh-tab/packages/agent-sdk`. That older code is reference-only (tooling, tests).

## Pinned upstream target

Python `OpenHands/software-agent-sdk` main @
**`966340979be26c2162e9ab8805557b715e1f1a78`** (2026-06-23). We transpile against exactly this
commit and catch up to newer upstream in deliberate batches, not by chasing HEAD.

## Source scope (Python core `openhands-sdk/openhands/sdk`, ~59k LOC, 93 pydantic files)

| Module | Files | ~LOC | Notes |
|--------|-------|------|-------|
| llm | 40 | 10364 | LiteLLM-backed; biggest + riskiest |
| conversation | 29 | 8378 | Local + Remote conversation, state, event loop |
| agent | 9 | 7685 | The agent loop / step logic |
| context | 25 | 3301 | Condenser, skills context, agent context |
| settings | 5 | 3127 | Settings models |
| skills | 9 | 2586 | Skill discovery/validation |
| workspace | 10 | 2528 | Local/Remote/Apple workspace |
| tool | 11 | 2360 | Tool base + registry |
| security | 15 | 2084 | Confirmation, risk, analyzer |
| utils | 16 | 2004 | Shared helpers |
| event | 19 | 1923 | Event model hierarchy |
| hooks | 6 | 1669 | Lifecycle hooks |
| plugin | 7 | 1471 | Plugin system |
| critic | 12 | 1446 | Critic models |
| git | 6 | 1355 | Git integration |
| profiles | 5 | 1267 | LLM profiles |
| subagent | 4 | 1011 | Delegation |
| extensions | 8 | 988 | |
| mcp | 6 | 750 | MCP client |
| marketplace | 4 | 649 | |
| observability | 3 | 447 | |
| io | 5 | 431 | |
| logger | 3 | 330 | |
| testing | 2 | 339 | test helpers |
| secret | ? | 155 | secret handling |

Plus `openhands-tools` (~16k LOC): concrete tools (terminal, file editor, browser, etc.).
`openhands-agent-server` is out of scope for now (possible later sibling package).

## Principles

1. **Idiomatic TS, not literal port.** Respect the architecture (event/conversation/agent
   separation, tool abstraction) but use TS idioms: discriminated unions over class hierarchies
   where natural, `readonly`, narrow types, no Python-isms.
2. **Type enforcement is non-negotiable.** `strict` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes` + `verbatimModuleSyntax`. `no-explicit-any` is an error.
3. **Runtime validation = zod v4.** The pydantic equivalent. Pydantic `BaseModel` → zod schema +
   `z.infer` type. zod v4's native `z.toJSONSchema()` covers the spots Python uses
   `model_json_schema()` (tool/settings schemas) — no separate `zod-to-json-schema` dep.
4. **No code copy.** Read Python for behavior, write TS fresh. Port tests conceptually too.
5. **Tooling parity with oh-tab** unless justified: tsup (ESM+CJS), vitest, eslint
   type-checked, tsc strict, target ES2022.
6. **Wire-protocol compatibility.** TS types must serialize to the same JSON the Python SDK and
   agent-server expect. Round-trip serialization tests are the correctness anchor.

## Decisions (resolved 2026-06-23 with Engel)

1. **zod v4** (4.4.3). Native JSON Schema; drop `zod-to-json-schema`. Done.
2. **Single package** for starters; split into npm workspaces later.
3. **LLM: thin abstraction, fat clients.** `LLMClient` is a deliberately thin interface; most
   logic lives inside each client. **Do not over-abstract.** Four clients, each owning its API's
   correctness + performance (request building, streaming, prompt caching, error mapping):
   - OpenAI / OpenAI-compatible (chat completions)
   - Anthropic Messages
   - Gemini (new interactions API)
   - OpenAI Responses API

   The shared surface is *extracted from what clients actually share*, built last — not designed
   up front. Live-test scripts live in `scripts/live/` (NOT CI), keys from a GitHub environment
   named `llm`, run on demand to confirm each API still works.
4. **Pin upstream** at `9663409` (above). Local `~/repos/agent-sdk` synced to it.

## Phased roadmap

Each phase is a bead (see `bd list`). Dependencies chained so `bd ready` surfaces the next
workable phase.

- **P1 — Foundations:** utils, logger, io, event model. Low-dependency leaves first; establishes
  the zod patterns and the event discriminated-union shape everything builds on.
- **P2 — Types & settings:** settings models, profiles. Validates the zod approach at scale.
  Serialization round-trip tests. (deps: P1)
- **P3 — Tool abstraction + registry:** base Tool, schema gen via `z.toJSONSchema()`, then one
  concrete tool end-to-end. (deps: P1)
- **P4 — LLM layer:** the four clients (one sub-bead each, done end-to-end), the live-test
  harness + `llm` environment, then the minimal shared interface extracted last. (deps: P1)
- **P5 — Conversation + agent loop:** LocalConversation, RemoteConversation, ConversationState,
  agent step loop, stuck detection. (deps: P3, P4)
- **P6 — Context & condenser, skills:** context-window management, condensation, skill
  discovery/validation. (deps: P5)
- **P7 — Surrounding subsystems:** security, hooks, critic, subagent, git, mcp. (deps: P5)
- **P8 — Concrete tools** (`openhands-tools` equivalent): terminal, file editor, browser,
  grep/glob, task tracker, etc. May become a separate package later. (deps: P3)
- **P9 — Packaging, examples, docs, release 0.1.0.** (deps: P6, P7, P8)

## Reference materials

- Python source: `~/repos/agent-sdk/openhands-sdk/openhands/sdk` and `openhands-tools`
- Old TS attempt (reference only, do not copy): `~/repos/oh-tab/packages/agent-sdk`
- Wire protocol: agent-server API + `OpenHands/typescript-client`
