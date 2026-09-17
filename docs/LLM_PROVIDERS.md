# LLM provider implementation

This SDK talks to providers directly. The Python SDK can obtain compatibility behavior from LiteLLM; here, provider quirks are part of our implementation responsibility even when there is no corresponding Python SDK change. The [transpilation contract](TRANSPILE_CONTRACT.md#provider-compatibility-without-litellm) governs whether a change preserves compatibility or introduces a deliberate difference.

## Ownership and placement

The shared interface is [`LLMClient.complete(messages, tools)`](../src/llm/client.ts). Provider clients are adapters behind that interface: callers supply a profile, messages, and tools without having to know which provider needs a wire-format adjustment.

| Concern | Owner |
|---|---|
| Profile-based client selection and secret resolution | [`factory.ts`](../src/llm/factory.ts) and the provider factories |
| Chat Completions / Responses request builders, response parsers, and continuation serialization | [`openai.ts`](../src/llm/openai.ts) |
| Anthropic Messages protocol | [`anthropic.ts`](../src/llm/anthropic.ts) |
| Gemini Interactions protocol | [`gemini.ts`](../src/llm/gemini.ts) |
| Reusable model/endpoint capability decisions | Pure helpers in [`provider-quirks.ts`](../src/llm/provider-quirks.ts) |
| Typed messages and metadata that must survive conversation persistence/replay | [`index.ts`](../src/llm/index.ts), with provider serializers consuming those fields |
| Per-response usage normalization and raw usage detail | The owning provider response parser |
| Per-call accounting records, coverage and accumulated projections | [`metrics.ts`](../src/llm/metrics.ts), persisted by `Agent.step` |
| Dated native price estimates | Pure [`pricing.ts`](../src/llm/pricing.ts) helper |

Keep a normalization specific to one wire protocol beside its parser or builder. Use a small named pure helper when a capability decision has real reuse or enough behavior to test separately. `provider-quirks.ts` is for those decisions, not a registry of arbitrary hooks, network calls, or whole response parsers. Split helpers by provider when actual coupling or size warrants it; a new quirk does not require a new class, plugin, or public configuration switch.

Apply a rule to the narrowest justified scope. Tolerance that is valid for the Chat Completions wire format can live in its parser without a DeepSeek-name check. A model-specific parameter restriction needs a tested model/endpoint decision. A gateway's transport and the model family behind it are different facts; model-name heuristics must not select credentials or silently change transports.

## Normalize without losing meaning

The DeepSeek `tool_calls[].index` regression is the concrete example: the Chat Completions parser accepts and strips unconsumed extra keys on the tool call and its nested `function`, while still validating the ID, function name, and arguments. See the [client regression](../src/llm/__tests__/openai-client.test.ts). The agent receives ordinary typed tool calls; it needs no DeepSeek branch.

This is targeted tolerance at provider ingress, not a reason to loosen all schemas. Required fields and consumed values remain validated. Keep internal message/profile schemas strict. Do not silently discard a tool call, suppress a provider error, change tool arguments, or guess a fallback model to make a response parse.

Some provider fields are semantically necessary: reasoning content, signed thinking blocks, and response-item IDs may be needed on the next request. Preserve and replay them through the existing typed message fields. An ignored field and a continuation field need different treatment. The completion's `raw` response is diagnostic data; it does not substitute for durable typed replay metadata. Sanitize captured fixtures and never add credentials or private conversation data to the repository.

Usage needs the same care. Preserve missing versus zero counters, retain `providerUsage`, and normalize inclusive input/output totals without adding cache/reasoning subsets twice. Provider-reported cost keeps its unit and takes precedence over any dated estimate. Usage records, accumulated totals, coverage gaps and the attribution boundary are documented in [LLM metrics](LLM_METRICS.md).

## DeepSeek reasoning history after a profile switch

DeepSeek's [thinking-mode tool documentation](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls) requires reasoning content on historical assistant messages when tools are enabled, including assistant turns without tool calls. Omitting it can make a subsequent request fail with HTTP 400. The [Chat Completions schema](https://api-docs.deepseek.com/api/create-chat-completion/) describes the field as a nullable string and does not require nonempty text.

A conversation switched from a model that did not expose reasoning may legitimately have no `reasoning_content` for some assistant turns. The DeepSeek Chat Completions adapter supplies an empty string in that case while preserving any recorded nonempty reasoning exactly. This is outgoing provider normalization, not invented reasoning or a modification of stored events. Keep the rule limited to DeepSeek reasoning requests; unrelated OpenAI-compatible models must not acquire unsupported fields. The provider regression covers both tool-call and ordinary assistant history and is separate from DEV-SDK-008's removal of foreign signed/encrypted continuation. See the [profile-switch evidence](../transpile/profile-switch.md) for the observed cross-provider failure and verification.

## Anthropic prompt caching

Supported Anthropic models use explicit prefix caching by default through both native
Messages and compatible Chat Completions gateways, including the eval proxy. Set the
profile's `cachingPrompt: false` to disable it. Model capabilities select cache semantics;
the profile's provider still selects credentials and transport.

The optional, Anthropic-specific `anthropicCacheTtl` selects `'5m'` or `'1h'` for every
explicit breakpoint in that profile's requests, on both transports. Omission leaves
the field absent in saved profiles and keeps Anthropic's five-minute wire behavior.
One hour emits
`cache_control: {type: 'ephemeral', ttl: '1h'}`; five minutes retains `{type: 'ephemeral'}`.
The same duration applies to automatic and caller-selected markers. A single duration
avoids mixed-TTL ordering constraints. One-hour writes have a higher provider charge;
cache hits refresh the lifetime. See [Anthropic's cache documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
Other providers do not receive a default TTL field. Their request serializers ignore
this option if explicitly supplied. It does not enable caching for unsupported models
or override `cachingPrompt: false`.

Provider request preparation marks the static system block and the latest user/tool
content. Keep dynamic system context in a separate block. Tool-result markers belong on
the outer native `tool_result` block, or on the outer Chat Completions tool message for
the gateway to translate. Request preparation must not mutate persisted messages or
accumulate old automatic markers. Gemini and ordinary OpenAI requests must not inherit
Anthropic fields; OpenAI cache retention remains a separate option.

Tests must use ordinary unmarked agent messages and inspect both transports. A cache
smoke must also assert a provider-reported cache read after the initial write; request
success alone proves nothing about caching. With one hour selected, require the provider's
`ephemeral_1h_input_tokens` write counter too. Run the Haiku test described in the
[live test instructions](../scripts/live/README.md). The
[port evidence](../transpile/anthropic-cache.md) records pinned Python behavior, legacy
comparison, provider constraints and the regression this restores.

## Evidence for a quirk

1. Record the observed failure, affected protocol/model/endpoint, and the relevant provider payload, documentation, or upstream dependency behavior. A provider fixture is sufficient to start when the Python SDK has no matching test.
2. Add a failing test through the provider client's interface with injected `FetchLike`. Assert the outgoing request and returned typed message, as relevant. For continuation changes, test the next tool/reasoning request too.
3. Implement the smallest change in the owning client or helper. Cover the nearby failure case: harmless extras should work, but malformed required fields must still fail. For a capability gate, test a matching and a nonmatching profile so the rule does not leak to other providers.
4. Run the affected client suite, typecheck, lint, and build; run the full SDK suite and relevant wire/parity checks before merge. Live provider smokes supplement deterministic fixtures; they are not a substitute for them or proof of Python/TypeScript parity.

Test the observable result rather than exporting a private parser just for a test. Keep the rationale next to the implementation and the regression fixture. Update this guide when ownership changes; do not grow a second hand-maintained provider capability matrix here. [`REASONING_CAPABILITIES.md`](REASONING_CAPABILITIES.md) and [`PROMPT_CACHE_RETENTION.md`](PROMPT_CACHE_RETENTION.md) contain focused research; current code/tests and fresh evidence decide current behavior.

## OpenAI ChatGPT subscriptions

Choose a normal profile with `providerId: "openai"`, `authType: "subscription"`, `subscriptionVendor: "openai"`, and a model from `OPENAI_CODEX_MODELS`. The factory selects Responses streaming and the Codex endpoint; it does not look up an API key or persist OAuth tokens in the profile. Serialized profiles restore the same auth path after restart. The same model with `authType: "api_key"` continues to use ordinary API credentials.

`OpenAISubscriptionAuth` owns device start/poll, PKCE browser login, refresh, status helpers and logout. `CredentialStore` shares Python's `openai_oauth.json` format in `OH_PERSISTENCE_DIR/auth` (default `~/.openhands/auth`), with directory mode 0700 and atomic file writes at mode 0600. Relative persistence directories are anchored at module initialization and `~/` is expanded. This store belongs to OpenHands; the SDK never reads Codex CLI credentials.

Hosts can inject `{subscriptionAuth}` into `createClientFromProfile` to share the lifecycle with their login routes. `pollDeviceLogin(code, {persist: false})` lets the server validate its pending session before saving credentials. `login({authMethod: "browser", onAuthorize})` binds a localhost PKCE callback; `login({authMethod: "device_code", onDeviceCode})` waits for device approval. The host presents `CONSENT_BANNER` and the private login URL/code through its own UI before initiating login. Authentication never starts implicitly when an agent runs.

Each completion rechecks expiry with the upstream 60-second buffer, preserves a refresh token when a refresh omits its replacement, verifies account claims against OpenAI's cached JWKS, and computes request headers afresh. Concurrent calls sharing an auth instance coalesce refreshes; logout/new login prevents a late refresh from overwriting credentials. Errors omit token response bodies.

The subscription endpoint requires `stream: true` and `store: false`. It omits temperature, output limits, reasoning/include and cache-retention fields. Long system context moves into the first user message behind the upstream minimal instruction. Previous reasoning references are omitted, because the endpoint does not persist them. The SSE reader retains `response.output_item.done` items when the final response has empty output, preserving text and tool calls. These quirks belong here because the TypeScript client implements the protocol directly rather than inheriting LiteLLM's behavior.

### User messages arriving during tool execution

Run `npm run live:deepseek-flash` for real-provider overlap and restored-history
coverage. See [live test setup](../scripts/live/README.md) for the GitHub `LLM`
environment and local credentials. This is separate from deterministic parity tests.

A host may persist an incoming user message before an outstanding tool observation. Provider
request builders use `tool-result-order.ts` to keep a completed assistant/tool exchange adjacent,
then include intervening user messages in their original relative order. This changes only the
request view: durable arrival order, message contents and completed side effects remain intact.
Only complete batches are reordered; missing results are never invented. See
[`transpile/interleaved-tool-results.md`](../transpile/interleaved-tool-results.md) for source
comparison and regression evidence.
