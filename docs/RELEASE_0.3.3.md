# Release 0.3.3

`0.3.3` is the native OpenAI tool-completion parity release for `@smolpaws/openhands-agent`. It follows `0.3.2` by closing the Agent-to-LLM tool propagation gap against pinned Python `966340979be26c2162e9ab8805557b715e1f1a78` and documenting the provider-owned serialization boundary needed by the TypeScript agent-server port.

## Highlights

- Restored Agent-to-LLM tool propagation parity:
  - `Agent.step()` now passes exactly the usable `ToolDefinition` instances to `LLMClient.complete()`
  - the shared `LLMClient` interface remains a thin transport boundary with an optional `tools` argument
  - non-usable tool definitions are not exposed to the model
- Added native OpenAI tool serialization:
  - Chat Completions wraps `ToolDefinition` schemas in OpenAI's nested function-tool shape
  - Responses uses the top-level function-tool shape
  - empty tool lists omit the provider `tools` request field
- Preserved multi-tool execution behavior:
  - returned tool calls still become ordered `ActionEvent`s
  - `ParallelToolExecutor` continues to run pending batches without reintroducing confirmation gates
- Added executable evidence:
  - red/green unit coverage for Agent tool propagation and OpenAI request serialization
  - a live `native-openai-tools.ts` example proving real read/edit/read/finish dispatch with `gpt-5-nano`
- Updated architecture and transpilation docs to mark tool passing as required Python parity rather than an accepted deviation.

## Verification

Run before publishing/tagging:

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
npm run typecheck:live
npm pack --dry-run
```

Verification result for the release commit:

- `npm test` — passed, 39 files / 244 tests
- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm run build` — passed
- `npm run typecheck:examples` — passed
- credential-free `npm run test:examples` — passed
- `npm run typecheck:live` — passed
- `npm pack --dry-run` — passed; tarball `smolpaws-openhands-agent-0.3.3.tgz`, package size 397.7 kB, unpacked size 1.9 MB, 72 files

## Live evidence

- `npm run live:openai-tools` against `gpt-5-nano` emitted native tool actions `read_file`, `edit_file`, `read_file`, and `finish`; tool executors ran and verified the README mutation.

## Upgrade notes from 0.3.2

- Package metadata moves to `0.3.3`.
- Existing `LLMClient` implementations remain source-compatible because the new `tools` argument is optional.
- OpenAI Chat Completions and Responses clients now receive and serialize native tool definitions when an Agent has usable tools.
- Anthropic and Gemini native tool-calling are still intentionally separate follow-up provider phases.
