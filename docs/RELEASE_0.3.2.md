# Release 0.3.2

`0.3.2` is the provider-native LLM controls and GPT-5.6 prompt-cache retention release for `@smolpaws/openhands-agent`. It follows `0.3.1` by documenting the provider-specific reasoning surface and adding a narrowly gated direct-OpenAI GPT-5.6 prompt-cache retention path backed by live API probes.

## Highlights

- Added provider-native reasoning investigation docs:
  - provider/model matrix for OpenAI, Anthropic, Gemini, LiteLLM/OpenRouter, and ChatGPT subscription endpoints
  - proposed `ReasoningCapabilities` and serializable provider-specific reasoning config shapes
  - migration notes for moving beyond the current cross-provider `reasoningEffort` abstraction
  - review-driven fixes for Anthropic discriminator naming, OpenAI Responses `reasoning.mode`, and Gemini thinking-budget/level exclusivity
- Added GPT-5.6 prompt-cache profile fields:
  - `promptCacheRetention` with `24h` / `disabled` values and `null` SDK default
  - `promptCacheKey` for stable-prefix routing
  - persisted profile schema round-tripping and raw-settings cleanup when a profile is selected
- Wired direct OpenAI GPT-5.6 request builders:
  - Responses and Chat Completions default to `prompt_cache_retention: "24h"` for known-safe direct OpenAI GPT-5.6 routes
  - optional `prompt_cache_key` is sent on the same route-gated path
  - LiteLLM/OpenRouter aliases, ChatGPT subscription/Codex endpoints, provider-branded custom/internal proxies, unsupported models, and explicit `disabled` retention omit both prompt-cache request fields
- Documented prompt-cache evidence:
  - official OpenAI docs tension around GPT-5.6 `prompt_cache_options.ttl` versus observed `prompt_cache_retention: "24h"` acceptance
  - live OpenAI Responses and Chat Completions field-acceptance probes
  - repeated 5,412-token prefix proof showing first-run cache writes and subsequent cache hits
- Tightened review feedback:
  - bounded GPT-5.6 model matching so future names such as `gpt-5.60` do not accidentally inherit GPT-5.6 behavior
  - explicit regression coverage for custom proxy URLs remaining unsupported until directly verified

## Verification

Run before publishing/tagging:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run typecheck:examples
npm run test:examples
npm pack --dry-run
```

Verification result for the release commit:

- `npm test` — passed, 38 files / 240 tests
- `npm run typecheck` — passed
- `npm run lint` — passed
- `npm run build` — passed
- `npm run typecheck:examples` — passed
- `npm run test:examples` — passed
- `npm pack --dry-run` — passed; tarball `smolpaws-openhands-agent-0.3.2.tgz`, package size 394.2 kB, unpacked size 1.9 MB, 70 files

## Upgrade notes from 0.3.1

- Package metadata moves to `0.3.2`.
- Existing profiles continue to parse because new prompt-cache fields default to `null`.
- Direct OpenAI GPT-5.6 profiles now send `prompt_cache_retention: "24h"` by default. Set `promptCacheRetention: "disabled"` to omit that explicit field.
- `promptCacheKey` is optional and only sent on the same known-safe direct OpenAI GPT-5.6 route as retention.
- OpenAI-compatible proxies and aliases remain conservative: they do not receive prompt-cache fields until separately proven safe.
