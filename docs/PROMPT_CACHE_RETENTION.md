# GPT-5.6 prompt-cache retention evidence

Status: implemented for direct OpenAI GPT-5.6 request builders.
Date: 2026-06-06.

## Decision

For direct OpenAI GPT-5.6 profiles, the TypeScript SDK sends `prompt_cache_retention: "24h"` by default on both Responses and Chat Completions request bodies. Profiles can set `promptCacheRetention: "disabled"` to omit the field, or `promptCacheRetention: "24h"` to persist the choice explicitly.

The SDK only applies this to known-safe direct OpenAI GPT-5.6 routes:

- `providerId: "openai"`
- model IDs beginning with `gpt-5.6` or `openai/gpt-5.6`
- default OpenAI API base URL or `https://api.openai.com/...`

It deliberately omits the field for LiteLLM/OpenRouter aliases and ChatGPT subscription/Codex endpoints until those routes have direct evidence. `promptCacheKey` is persisted on profiles and sent only on the same known-safe routes.

## Official documentation snapshot

Source: <https://platform.openai.com/docs/guides/prompt-caching>

Relevant official-doc points captured during implementation:

- Prompt caching is automatic for eligible recent models, but GPT-5.6 and later report cache writes through `cache_write_tokens`.
- `prompt_cache_key` helps route requests with shared long prefixes to the same cache; OpenAI recommends stable keys for shared prefixes.
- For GPT-5.6 and later, the public guide describes `prompt_cache_options.ttl`, currently supporting only `30m`.
- The same guide says legacy `prompt_cache_retention` is deprecated for GPT-5.6 and later and remains the retention policy field for earlier models.

The live API currently accepts `prompt_cache_retention: "24h"` for GPT-5.6 despite that deprecation wording, so this SDK change is intentionally gated to direct OpenAI GPT-5.6 evidence rather than generalized to proxies.

## Live probe evidence

Environment:

- OpenAI API key available.
- Model: `gpt-5.6`.
- All probes used small output limits and `reasoning.effort` / `reasoning_effort` set to `none` where accepted.

### Field acceptance

| API | Request field | Result | Notes |
| --- | --- | --- | --- |
| Responses | `prompt_cache_retention: "24h"` | 200 | Response echoed `prompt_cache_retention: "24h"`; short prompt had zero cache writes. |
| Chat Completions | `prompt_cache_retention: "24h"` | 200 | Response did not echo the field, but usage included cache detail fields. |
| Responses | `prompt_cache_options: { ttl: "24h" }` | 400 | Error: `Invalid value: '24h'. Supported values are: '30m'.` |
| Chat Completions | `prompt_cache_options: { ttl: "24h" }` | 400 | Same invalid-value error. |
| Responses | `prompt_cache_options: { ttl: "30m" }` | 200 | Response still echoed `prompt_cache_retention: "24h"` in this probe. |
| Chat Completions | `prompt_cache_options: { ttl: "30m" }` | 200 | Accepted. |

### 5,412-token repeated prefix cache proof

Responses API with identical input text and a stable `prompt_cache_key`:

| Run | Input tokens | Cache write tokens | Cached tokens | Response field |
| --- | ---: | ---: | ---: | --- |
| 1 | 5,412 | 5,409 | 0 | `prompt_cache_retention: "24h"` |
| 2 | 5,412 | 0 | 5,409 | `prompt_cache_retention: "24h"` |
| 3 | 5,412 | 0 | 5,409 | `prompt_cache_retention: "24h"` |

Chat Completions with identical input text and the same stable key pattern:

| Run | Prompt tokens | Cache write tokens | Cached tokens |
| --- | ---: | ---: | ---: |
| 1 | 5,412 | 5,409 | 0 |
| 2 | 5,412 | 0 | 5,409 |
| 3 | 5,412 | 0 | 5,409 |

A varying suffix inside one raw Responses `input` string wrote the cache again on run 2 instead of producing a cache hit. The implementation therefore only exposes the retention/key request fields; callers still need stable rendered prefixes or explicit future breakpoint support to reliably reuse cache across changing turns.

## Implementation notes

- `promptCacheRetention` is part of `llmProfileSchema` so persisted profiles round-trip the option.
- `null` means SDK default. For direct GPT-5.6 OpenAI requests, that default is `24h`.
- `disabled` omits `prompt_cache_retention`; automatic provider prompt caching may still occur.
- `promptCacheKey` is optional and only sent where the retention route is known-safe.
- Unsupported models/routes strip both prompt-cache fields from OpenAI-compatible request bodies instead of guessing.
