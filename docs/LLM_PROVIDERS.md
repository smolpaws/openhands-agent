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

Keep a normalization specific to one wire protocol beside its parser or builder. Use a small named pure helper when a capability decision has real reuse or enough behavior to test separately. `provider-quirks.ts` is for those decisions, not a registry of arbitrary hooks, network calls, or whole response parsers. Split helpers by provider when actual coupling or size warrants it; a new quirk does not require a new class, plugin, or public configuration switch.

Apply a rule to the narrowest justified scope. Tolerance that is valid for the Chat Completions wire format can live in its parser without a DeepSeek-name check. A model-specific parameter restriction needs a tested model/endpoint decision. A gateway's transport and the model family behind it are different facts; model-name heuristics must not select credentials or silently change transports.

## Normalize without losing meaning

The DeepSeek `tool_calls[].index` regression is the concrete example: the Chat Completions parser accepts and strips unconsumed extra keys on the tool call and its nested `function`, while still validating the ID, function name, and arguments. See the [client regression](../src/llm/__tests__/openai-client.test.ts). The agent receives ordinary typed tool calls; it needs no DeepSeek branch.

This is targeted tolerance at provider ingress, not a reason to loosen all schemas. Required fields and consumed values remain validated. Keep internal message/profile schemas strict. Do not silently discard a tool call, suppress a provider error, change tool arguments, or guess a fallback model to make a response parse.

Some provider fields are semantically necessary: reasoning content, signed thinking blocks, and response-item IDs may be needed on the next request. Preserve and replay them through the existing typed message fields. An ignored field and a continuation field need different treatment. The completion's `raw` response is diagnostic data; it does not substitute for durable typed replay metadata. Sanitize captured fixtures and never add credentials or private conversation data to the repository.

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

A host may persist an incoming user message before an outstanding tool observation. Provider
request builders use `tool-result-order.ts` to keep a completed assistant/tool exchange adjacent,
then include intervening user messages in their original relative order. This changes only the
request view: durable arrival order, message contents and completed side effects remain intact.
Only complete batches are reordered; missing results are never invented. See
[`transpile/interleaved-tool-results.md`](../transpile/interleaved-tool-results.md) for source
comparison and regression evidence.
