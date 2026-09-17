# Release 0.4.0

`0.4.0` brings the conversation, provider, and maintenance work since `0.3.4` into a new minor release of `@smolpaws/openhands-agent`. Its main additions are durable LLM accounting, saved-profile switching, OpenAI subscription authentication, automatic Anthropic caching, and correct provider context when user input arrives during a running step.

The release retains the canonical Python SDK pin `50080b58d35b4824fda25fca2345d80bcd08aeff` (v1.47.0). Nine recorded, bounded upstream intervals advanced the SDK from the previous release's baseline; this release preparation does not advance that pin. The [transpilation contract](TRANSPILE_CONTRACT.md) remains the compatibility authority, including its explicit deviations and deferrals.

## Highlights

- **Conversation causality and continuation.** Concurrent user arrivals remain in their original durable order, while outgoing requests place completed tool results before the new input. Request-boundary records also handle input arriving during a plain assistant response. Response-level thought and signed reasoning attach only to the first action of a parallel tool batch, preventing duplicate replay. Plain assistant text ends a turn; reasoning-only responses receive the upstream-style continuation handling.
- **Saved-profile switching.** The optional `switch_llm` builtin accepts a saved profile name through a host callback. `LocalConversation.onStepBoundary` lets the host activate an accepted selection after the current tool batch. Cross-profile request projection omits incompatible opaque reasoning without rewriting history, losing visible context, or resetting metrics. Host applications still own profile storage and durable selection.
- **Usage and cost accounting.** Native provider counters are normalized once and persisted as per-completion records, including available usage from malformed provider responses. Conversation statistics survive restoration and distinguish reported zero, unknown measurements, known subtotals, and complete totals. Cache/reasoning counters, provider payloads, and reported versus calculated cost provenance remain available. See [LLM metrics](LLM_METRICS.md).
- **OpenAI subscription authentication.** The SDK exports a private OAuth credential store, device and browser PKCE login, refresh handling, and subscription Responses transport. Explicit subscription profiles resolve fresh credentials before requests and preserve streamed text and tools. This is implemented SDK functionality with deterministic and recorded host-level evidence; it does not establish live subscription coverage for every model. See [subscription evidence](../transpile/subscription-auth.md).
- **Anthropic prompt caching.** Ordinary agent requests now select cache breakpoints on supported native and compatible proxy routes. `cachingPrompt` controls opt-out. Optional `anthropicCacheTtl` selects `5m` or `1h`; omission stays absent in the profile and retains the five-minute wire behavior. Live Haiku evidence covers cache writes, reads, restored continuation, and explicit one-hour counters. OpenAI cache retention remains a separate option.
- **Host integration and upstream ports.** Added outbound message/media intents, task-scheduler tool intents, host execution context, skill-path filtering, hook and subagent improvements, error classification, observability span names, and more robust git/workspace helpers. Messaging and scheduling tools record intent; the host owns delivery and scheduling. The exec-based terminal now has a bounded default timeout, and file-editor fallback preserves replacement whitespace.
- **Reproducible maintenance and real-LLM regression testing.** The package includes the canonical upstream manifest and bounded review evidence. The repository's `llm-tests` label runs real README read/edit, parallel-tool input ordering, finish, restoration, and accounting checks, alongside existing cache/reasoning/example scenarios. Model, route, scenario, and enablement live in one configuration file; all live GitHub runs use environment `LLM`.

## Upgrade notes from 0.3.4

- **Treat missing usage as unknown.** `LLMUsage.promptTokens`, `completionTokens`, and `totalTokens` are now optional instead of defaulting absent provider measurements to zero. Check coverage before presenting a total. The conversation metrics API is a target projection, not complete Python `Metrics` or `LLMRegistry` parity.
- **Review settings and profile shapes.** Agent settings are schema version 5; agent profiles are version 2. Use `validateAgentSettings` and `validateAgentProfile` for their defined migrations. OpenHands agent profiles now expose `tools` and `disabled_skills` rather than the old embedded `skills` field; old hand-authored payloads containing that removed field need updating. Supply full-content skills through `AgentContext`. `tools: null` selects SDK defaults, whereas an explicit empty list remains an explicit selection except for the documented migration of the untouched default profile.
- **Allow the new profile defaults.** `authType` defaults to `api_key`, `subscriptionVendor` to `null`, and `cachingPrompt` to `true`. `anthropicCacheTtl` is optional. Subscription selection must be explicit; native API-key and subscription authentication are not interchangeable.
- **Keep request history and stored history distinct.** New `llm_usage`, `llm_history_origin`, and `llm_request_boundary` state updates support accounting and request projection. Preserve them when copying event logs. Old histories without provenance retain the documented compatibility behavior; the SDK does not invent historical usage or reconstruct missing request boundaries.
- **Account for terminal deadlines.** Commands without an explicit timeout are killed after 300 seconds. A per-command `timeout: 0` disables that limit. Interactive input and resumable tmux sessions remain outside the exec-based executor's behavior.
- **Use the host switching boundary.** A successful `switch_llm` call accepts a selection for the next LLM call. Hosts must prepare and persist that selection before activation; it does not change tools already executing or automatically switch auxiliary models.

## Verification

The documented release checks, plus the current drift and live-harness checks, are:

```sh
npm test
npm run test:drift
npm run typecheck
npm run typecheck:drift
npm run lint
npm run build
npm run typecheck:examples
npm run test:examples
npm run typecheck:live
npm run test:live-harness
npm pack --dry-run
node --import tsx scripts/parity/check-packed-provenance.ts
```

Release verification passed: 611 SDK tests (one remote integration skipped), seven drift tests, and 44 offline live-harness tests; all listed type checks, lint, build, credential-free examples, package inspection, and packed-provenance checks passed. The built package was also checked through ESM, CommonJS, and a TypeScript consumer. The exported `VERSION` now matches the package version, `0.4.0`.

Credential-free example execution is distinct from the live evidence below: the native OpenAI/Gemini examples and remote-workspace example explicitly skip their external integrations without credentials or a remote server.

## Live evidence and remaining coverage

The September 17 live regression work attempted 33 enabled targets: **14 passed, 17 were unavailable, and two failed**. These are recorded pre-release runs with targeted reruns after the relevant harness corrections, not a claim that every provider was rerun for the version bump. Successful paths included native/OpenRouter DeepSeek, app-proxy DeepSeek Pro, eval Fable, OpenRouter Luna, native/OpenRouter/eval Gemini, and the DeepSeek accounting and Haiku cache regressions.

Two app-route findings remain open: Opus returned unexpected plain text in the separate in-flight-response probe after passing README and parallel-tool stages; DeepSeek v4.1 Flash failed the README-edit phase. Neither has an established root cause. Unavailable credentials, credit, and endpoints are not counted as passing tests.

For this release, all **nine** targets using `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` are explicitly disabled while subscription authentication is being enabled for the test setup. The other **24** targets remain enabled. This configuration pause does not remove the implemented OpenAI OAuth support or claim that the suite now tests subscription routes. APP/EVAL secrets are named `OPENHANDS_API_KEY_APP` and `OPENHANDS_API_KEY_EVAL`.

Native memory-index loading remains deferred; host-supplied full-content skills are already supported. The LLM-summarizing condenser implementation and further Python condenser/behavior-test ports remain follow-up work. The release does not claim those gaps are closed. See [context and memory evidence](../transpile/context-memory.md).

## Distribution

The GitHub release tag is `v0.4.0`. Its built package is `smolpaws-openhands-agent-0.4.0.tgz`, containing ESM/CommonJS entry points, declarations, examples, documentation, and upstream provenance.

```sh
npm install https://github.com/smolpaws/openhands-agent/releases/download/v0.4.0/smolpaws-openhands-agent-0.4.0.tgz
```

Repository development commands such as the live regression runner require a source checkout; they are not installed as package executables. SmolPaws' existing vendored SDK is not changed by publishing this release.
