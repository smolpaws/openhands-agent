# Anthropic prompt caching

Classification: the automatic-breakpoint repair is **PORT / provider compatibility**;
profile-selected duration is **DEVIATION / DEV-SDK-004**. Both use the unchanged canonical
pin in [`upstream.json`](upstream.json). Tracking: SmolPaws beads `smolpaws-i7d` (repair)
and `smolpaws-35d` (duration).

## Missed behavior

The September 16 Fable regression was a request-construction failure, not merely missing
metrics. The proxy returned explicit zero cache reads and writes. This SDK had a native
Anthropic serializer for manually supplied `cache_prompt` flags, but ordinary agent calls
never supplied the upstream automatic breakpoints. The Chat Completions serializer used
by the eval proxy dropped cache markers entirely. The capability list also omitted the
pinned Fable entry, and the native system serializer flattened static and dynamic blocks.
An isolated native smoke with manually marked text could not detect those omissions.

Legacy SmolPaws's installed `@smolpaws/agent-sdk` 0.10.0 already handled both transports.
Its `src/sdk/llm/openai-compatible.ts::toRequestBody` and
`src/sdk/llm/anthropic.ts::requestBody` selected a separate static system block and the
latest user/tool message automatically. This was inspected in the installed package's
published source map and bundle; it is comparison evidence, not this transpilation's
upstream authority.

## Pinned Python contract

At the canonical pin, `openhands-sdk/openhands/sdk/llm/llm.py` provides:

- `caching_prompt=True` by default; `is_caching_prompt_active()` combines the setting
  with the model's explicit-cache capability.
- `_begin_chat_messages()` makes a detached copy before `_apply_prompt_caching()`.
- The first system content block is marked. A second dynamic system block is explicitly
  unmarked, preserving the static prefix across conversations with different context.
- The final content item of the latest user or tool message is marked, extending the
  prefix during a conversation. Assistant thinking blocks and tool definitions receive
  no separate automatic breakpoint.
- Other explicit caller markers are preserved. Automatic selection is per request and
  does not accumulate flags in durable history.

`llm/message.py` serializes a marked text block with `cache_control: {type: "ephemeral"}`.
A marked multi-image content item places that field only on its final image. Tool messages
lift the marker to the outer Chat Completions message and remove it from nested result
content; LiteLLM then translates that to an Anthropic `tool_result` marker. The native
TypeScript adapter must perform the equivalent translation itself.

The TypeScript wire builders reject more than four explicit breakpoints with a clear
local error instead of sending a request that Anthropic will reject. They do not prune
caller-selected markers. Empty content is left unmarked.

`llm/utils/model_features.py::PROMPT_CACHE_MODELS` includes Fable. Its substring matching
covers provider-qualified names and version suffixes, including `claude-fable-5-1`.
[Upstream PR #3661](https://github.com/OpenHands/software-agent-sdk/pull/3661) explicitly
added Fable caching. Model catalogs and cache capability lists are separate surfaces:
adding a model to a catalog alone does not make its requests cacheable. Gemini remains
outside explicit breakpoint caching.

Relevant upstream tests to preserve are
`tests/sdk/llm/test_prompt_caching_cross_conversation.py`,
`tests/sdk/llm/test_message.py` (text, images, tool-result markers), and
`tests/sdk/llm/test_model_features.py`. Broader Python runtime metadata discovery,
capability overrides and cache-too-small provider retries are separate surfaces; this
repair does not claim to implement them.

## TypeScript ownership and evidence

Provider adapters own the request-only cache preparation and their respective wire
formats. Normal `LLMProfile` calls enable supported Anthropic caching by default;
`cachingPrompt: false` disables explicit markers. Preserve separate static/dynamic system
content, latest user/tool selection, input immutability and the gateway transport. A
Claude model behind `litellm_proxy` still uses that gateway's credentials and Chat
Completions endpoint; model detection must not silently reroute it to native Anthropic.

Deterministic regressions must cover the actual profile/client path for native and proxy
transports, Fable/Haiku capability selection, static/dynamic system separation, latest
user and tool results, images, explicit opt-out, unsupported providers and unchanged
input events. Test through ordinary unmarked messages; a manually marked smoke alone
does not establish automatic behavior. See the
[cache regressions](../src/llm/__tests__/anthropic-prompt-cache.test.ts)
and [live test instructions](../scripts/live/README.md).

The live Haiku smoke supplements those regressions. It must observe cache creation and
a positive cache read on a subsequent request with the same synthetic prefix, including
the proxy route used by SmolPaws. Inspect outgoing marker placement as well as returned
usage. Never treat HTTP success or a printed `cacheReadObserved: false` as a passing
cache test. Live viability evidence does not replace Python/TypeScript parity evidence.

On September 16, 2026, the real eval-proxy Haiku run failed before the fix and passed
after it. Its three ordinary Agent requests reported, respectively: 9,721 cache-write /
0 cache-read tokens; 110 write / 9,721 read; and, after restoring the event history,
110 write / 9,831 read. Each request carried two markers. Provider-exact accumulated
input was 29,502 tokens, including 19,552 cache reads and 9,941 cache writes; restoration
did not double-count the ledger. This used synthetic context and Haiku, with no Fable
calls or private conversation content.

## Provider constraints

[Anthropic's prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
(checked September 16, 2026) describes a prefix ordered as tools, system, then messages;
markers include everything before them. Explicit caching has a four-breakpoint limit
and a 20-block lookback. The default lifetime is five minutes. Haiku 4.5 requires a
4,096-token prefix; shorter prompts silently remain uncached. Thinking and empty text
blocks cannot carry explicit markers. Native `input_tokens` excludes cache reads and
writes, so inclusive input adds all three categories. Gateway usage must be normalized
according to its own response shape, retaining the raw counters.

The original automatic-breakpoint repair fixes missed in-scope behavior without advancing the upstream pin or adding a
`DEV-*`, `EXC-*` or `EXT-*` policy. Future transpilation reviews must inspect provider
capabilities and dependency-supplied wire behavior even when the TypeScript provider
adapter differs from Python's LiteLLM implementation.

## Profile-selected duration (DEV-SDK-004)

At the canonical pin, Python's `llm/message.py` emits `{type: "ephemeral"}` for text,
images and lifted tool results; `llm/llm.py` has no Anthropic cache-duration setting.
Its `prompt_cache_retention` is an OpenAI setting and is not an Anthropic TTL.
The target deliberately adds optional `LLMProfile.anthropicCacheTtl?: '5m' | '1h'`.
Omission stays absent through profile parsing, JSON persistence and restore for both
Anthropic and unrelated providers. The five-minute fallback belongs to Anthropic's
wire behavior, never to schema-inserted profile configuration. This is a profile-boundary deviation under
[DEV-SDK-004](../docs/TRANSPILE_CONTRACT.md#dev-sdk-004--profile-first-product-llm-boundary),
not an unported Python option or a claim of new parity.

Both native Messages and Anthropic-compatible Chat Completions apply the selected TTL
at every existing breakpoint. Five minutes keeps the previous wire payload unchanged;
one hour adds `ttl: "1h"`. Duration is request metadata, not a new content/event field.
Preserve input immutability, empty/thinking exclusions, tool-result marker lifting,
multi-image placement, opt-out and the four-breakpoint limit. Unrelated providers and
subscription requests receive no Anthropic marker. OpenAI retention remains independent.

The parameterized deterministic tests cover both durations through ordinary Agent
requests and the wire builders. Profile parsing rejects other values and JSON restore
preserves omission or an explicit duration. Typed callers may omit the field, and generated
schemas must mark it optional without a default. Sequential one-hour/five-minute requests must not share
mutable marker state. The server separately tests profile persistence and conversation
snapshot behavior; schema normalization must not backfill durations into existing profiles
or conversations.

The Haiku smoke accepts `ANTHROPIC_CACHE_TTL=1h`. When unset locally, the profile field
stays absent and requests keep five-minute wire behavior. It inspects each outgoing
marker and requires a positive one-hour write when selected, then cache reads across normal
and restored turns. Native evidence is `usage.cache_creation.ephemeral_1h_input_tokens`;
the eval proxy exposes `usage.prompt_tokens_details.cache_creation_token_details`.
Aggregate write counts alone do not prove duration. The GitHub **LLM** environment job
defaults to `1h`; it remains a manual, canonical-main live test. No one-hour live result
is implied by the deterministic tests.

On September 17, 2026, the isolated eval-proxy Haiku smoke passed with `1h` selected:
the cold request reported 9,719 one-hour cache-write tokens, the next request read
9,719 and wrote 110, and the restored turn read 9,829 and wrote 110. Every request had
two one-hour markers. Across three completions, inclusive input was 29,496 tokens,
output was 174, cache reads were 19,548, and all 9,939 cache-write tokens were explicitly
reported as one hour. Restored accounting matched exactly. This used only synthetic
test context and Haiku; it did not send a request to a live SmolPaws conversation.
