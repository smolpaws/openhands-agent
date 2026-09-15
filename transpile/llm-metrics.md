# LLM accounting port evidence

This change keeps the canonical pin in [`upstream.json`](upstream.json) unchanged. Core per-response accumulation and restored continuity are **PORT** work. Explicit missingness, currency/provenance, and the native metric API/storage contract are **DEVIATION: DEV-SDK-007**. Provider-specific parsing remains ordinary native-provider compatibility; it does not require a Python pin advance.

## Pinned source behavior

Paths below are relative to the pinned `OpenHands/software-agent-sdk` repository, not moving `main`:

| Source | Behavior used here |
|---|---|
| `openhands-sdk/openhands/sdk/llm/utils/metrics.py` | Per-call token/cost/latency lists and accumulated totals; snapshot histories omitted; latest-call `per_turn_token`. |
| `openhands-sdk/openhands/sdk/llm/utils/telemetry.py` | Normalize response usage, prefer authoritative provider cost, then notify stats consumers. |
| `openhands-sdk/openhands/sdk/conversation/conversation_stats.py` | Bucket by usage ID; restore metrics without adding previous spend again; combine buckets. |
| `openhands-sdk/openhands/sdk/conversation/state.py` | Persist full stats in `base_state.json`; retain them on reload. |
| `openhands-sdk/openhands/sdk/llm/llm.py` | Synchronize restored LLM/telemetry metric references. |
| `openhands-sdk/openhands/sdk/llm/llm_response.py` | Expose a cumulative metric snapshot for the completion, not a delta suitable for summation. |
| `openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py` | Fork resets metrics by default; preserving them requires an independent copy. |
| `openhands-sdk/openhands/sdk/event/conversation_state.py` | Extensible state-update carrier; compact `stats` serialization. |

The native implementation uses one immutable accounting delta under `llm_usage`, with `llm_metrics_reset` as an explicit accounting boundary. `ConversationState.stats` is a projection of those deltas. This fits the existing TS EventLog persistence model; it does not reproduce Python's separate `base_state.json` metric store. Compact snapshot helpers avoid embedding full growing histories in state updates.

The record is created once before response dispatch, so parallel tool actions share one paid completion. Available usage on a failed provider response also survives the error path. A local accounting UUID is distinct from the provider response ID, preventing accidental deduplication of distinct calls with reused provider IDs. Unknown fields, invalid records and unmeasured earlier history retain visible coverage limits. Raw usage details and any dated cost quote stay attached to that call.

Disk evidence exposed another boundary: the existing event serializer recursively omitted nulls. Applying that to the new accounting payload removed required unknown-value fields and changed nested provider detail. EventLog now preserves the complete `llm_usage` payload, including explicit nulls, while other event families keep their existing serialization behavior. In-memory projection alone was insufficient evidence for durable accounting.

## Test and review basis

`src/conversation/__tests__/metrics.test.ts` adapts accumulation/restore and snapshot-independence behavior from `tests/sdk/llm/test_llm_metrics.py` and `tests/sdk/conversation/test_conversation_stats.py`. Initial tests failed because the previous SDK discarded response usage instead of exposing persistent stats. The existing source also identifies relevant cases in `tests/sdk/conversation/test_stats_update_event_snapshot.py`, `tests/sdk/conversation/local/test_fork.py`, and the restore/telemetry regression tests in `tests/sdk/llm/test_llm.py`.

`src/llm/__tests__/provider-usage.test.ts` exercises native response shapes. `src/llm/__tests__/pricing.test.ts` covers the dated DeepSeek quote, cache arithmetic, zero/unknown values, aliases/endpoints, returned-model checks and tariff boundaries; positive pricing cases failed against a null-returning implementation before the helper was added. Live DeepSeek tests supplement deterministic evidence. A passing live request is not a Python/TypeScript differential oracle or a reconciliation against a provider invoice.

Relevant upstream reports were inspected without importing their unmerged implementations:

- [DeepSeek cache hits, issue #4491 / PR #4490](https://github.com/OpenHands/software-agent-sdk/issues/4491): native `prompt_cache_hit_tokens` must survive normalization. This is relevant beyond LiteLLM.
- [Typed usage normalization, issue #4975](https://github.com/OpenHands/software-agent-sdk/issues/4975): normalize once at the external boundary so consumers use the same counts.
- [Cache fallback regression, PR #5019](https://github.com/OpenHands/software-agent-sdk/pull/5019): Python private LiteLLM fields are not native wire fields; cover each actual provider payload instead.
- [Span costs, issue #4817](https://github.com/OpenHands/software-agent-sdk/issues/4817), and [ACP costs, issue #4382](https://github.com/OpenHands/software-agent-sdk/issues/4382): avoid separate conflicting price calculations, missing-as-zero costs and adding estimates on top of authoritative cost. Their Laminar/ACP mechanisms are outside this direct-client implementation.

## Scope limits

This is a data projection API, not complete Python `Metrics`, `LLMRegistry`, or `LLMResponse.metrics` parity. Python `base_state.stats` import, automatic auxiliary/standalone LLM attribution and a general model-pricing catalog remain unimplemented. Hosts own fork/reset composition. Missing historical counts cannot be recovered from text; provider invoices remain authoritative for billed spend. See [LLM metrics](../docs/LLM_METRICS.md) for the current fields and interpretation.
