# LLM usage and cost accounting

`Agent.step` saves one accounting record after each completed LLM call and before dispatching its message or tools. It also preserves available accounting metadata when a provider response fails message validation or terminates with an error. `conversation.state.stats` projects those records into per-usage histories and accumulated metrics. A response requesting several tools contributes one record. Restarting reads the same records; it does not charge them again.

This implements the pinned Python SDK's accounting concepts with explicit native differences under [DEV-SDK-007](TRANSPILE_CONTRACT.md#dev-sdk-007--native-accounting-with-explicit-measurement-coverage). It does not expose the complete Python mutable `Metrics`, `LLMRegistry`, or `LLMResponse.metrics` API. [Port evidence and remaining boundaries](../transpile/llm-metrics.md) identify the source behavior.

## Reading the data

```ts
const stats = conversation.state.stats;
const usage = stats.usage_to_metrics['profile:my-profile'];
const latest = usage?.records.at(-1);

// latest?.usage: normalized counts plus the provider's original usage object.
// latest?.cost: reported or calculated amount with its currency and provenance.
// usage?.accumulated_token_usage: complete totals, or null for unknown fields.
// usage?.known_token_usage and usage?.known_costs: measured subtotals.
```

The default usage ID is `profile:{profileId}`. An explicit `Agent` option `usageId` supplies another accounting bucket. Every record preserves its requested model, returned model when available, profile/provider IDs, provider response ID, local record ID, completion timestamp and latency. A bucket containing several returned models has `model_name: "mixed"`; the records retain their individual identities.

| Surface | Meaning |
|---|---|
| `records` | One delta per completed call, including raw provider usage and cost provenance. |
| `token_usages`, `costs`, `response_latencies` | Per-call projections; a missing value remains visible. |
| `accumulated_token_usage` | Field-by-field totals over the accounting period; `null` if coverage is incomplete. |
| `known_token_usage`, `known_costs` | Sums of available measurements, with costs grouped by currency/unit. |
| `accumulated_cost` | Total in USD only when every call has a USD amount and history is measured; otherwise `null`. Check `cost_sources` for calculated amounts. |
| `coverage` | Recorded completion count, missing usage/cost/field counts, and whether earlier history is unmeasured. Conversation coverage also reports invalid records and the first recorded timestamp. |

`per_turn_token` follows the upstream name but means the **latest completion's** prompt plus completion tokens, not the sum of every LLM call triggered by one user message. `context_window` remains unknown when no authoritative value is recorded. `metricsSnapshot(stats)` combines usage buckets; `statsSnapshot(stats)` preserves their keys. Both omit detailed record/history lists for compact responses.

## Provider counters

Provider clients return normalized optional fields on `LLMCompletionResponse.usage`. `providerUsage` preserves the provider usage object, including additional detail fields; `raw` is the full diagnostic completion and is not the accounting store. Missing usage is `null`; a missing individual counter is absent, not a synthetic zero.

- OpenAI Chat/Responses input totals already contain cache reads; completion totals already contain reasoning tokens. Those details are subsets, not extra tokens to add again.
- DeepSeek reports cache hits and misses separately. Cache misses are ordinary input, not cache writes. Alternate spellings for cached tokens are aliases, not additive counters.
- Anthropic's uncached input, cache-read input and cache-creation input are separate buckets. The normalized prompt count requires all three counters, including explicit zeros; it remains unknown if any component is absent. The provider object retains its original breakdown, including cache-creation detail when supplied.
- Gemini Interactions reports thought tokens separately from visible output. The normalized completion count requires both counters, including an explicit zero thought count; it remains unknown if either is absent. Internal tool-use tokens remain a separate field; retain the reported total rather than forcing it to equal prompt plus completion.

The accumulated cache-hit rate is cache reads divided by inclusive prompt tokens, only when both totals are complete and consistent. No tokenization of stored messages is used to invent provider usage.

## Costs and estimates

A recognized provider cost wins over an estimate, including a reported zero. Preserve its original unit: for example, an OpenRouter credit amount is stored as `credits` and is not relabeled USD. Subtotals with different units are never added together. Subscription token usage does not imply an API bill.

The current calculated-price adapter is deliberately limited to direct DeepSeek Flash endpoints and documented model aliases. Every estimate retains `source: "calculated"`, currency, the pricing source URL, verification date, served-model family, tariff band and all applied rates. An unexpected returned model, missing or inconsistent counters, or a request crossing a tariff boundary yields unknown cost. No per-call decimal rounding is applied before accumulation.

The [DeepSeek quote checked on 2026-09-15](https://api-docs.deepseek.com/quick_start/pricing/) identifies the current Flash family as DeepSeek-V4.1-Flash and accepts the older `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` names. Its published USD rates per million tokens are:

| Band | Cached input | Uncached input | Output |
|---|---:|---:|---:|
| Peak | 0.006 | 0.30 | 1.20 |
| Off-peak | 0.003 | 0.15 | 0.60 |

Peak windows are weekdays 01:00–04:00 and 06:00–10:00 UTC. Other hours use the off-peak quote. The retained date is part of the estimate: prices may change, and a quote is not proof of the actual debit or an account-specific discount. Update the quote and tests after verifying pricing changes; do not silently reinterpret old recorded estimates using new rates.

## Persistence and coverage

The SDK's EventLog stores versioned `ConversationStateUpdateEvent` values with key `llm_usage`. Projection deduplicates by the independent local record ID, retaining distinct calls even if the provider reuses its response ID. These accounting events never enter the LLM message context. Persisted deltas avoid repeatedly writing growing cumulative histories. The accounting payload retains explicit null values on disk, including unknown cost/usage and null fields in provider details; ordinary event serialization still follows its existing omission rules.

A host implementing a fork with fresh accounting appends `createMetricsResetEvent()` after the copied history. Keeping the copied accounting records without a reset preserves the source's measured period. The reset starts an accounting period; it does not delete messages or rewrite provider responses. This is a host composition primitive, not a `LocalConversation.fork()` implementation.

Earlier conversations may contain responses without accounting records. Their full totals remain unknown, while new records supply useful measured subtotals. Empty usage is not evidence that a historical call was free. Importing Python `base_state.stats` into this native ledger is not implemented; restoring a Python event transcript does not recover its separate metric file.

Automatic attribution covers main completions in `Agent.step` and each condenser completion attempt made within that step. Condenser records use usage ID `condenser` and retain the independent condenser profile/model; hard-reset retries are separate attempts even when response IDs repeat. Missing usage and cost on a failed request remain null, not zero. Persistence failures stop the operation without repeating its completion callback. Standalone condensers need an explicit `onCompletion` callback to choose a conversation. A standalone `LLMClient.complete()` call returns usage but has no conversation to persist it into. Prompt-hook LLM calls are likewise not automatically attributed. A host that connects such calls must save exactly one `createLlmUsageEvent()` to the intended conversation, using its own usage ID where needed. Provider-response errors can retain received accounting metadata; network errors without that metadata cannot recover usage or prove zero provider spend.
