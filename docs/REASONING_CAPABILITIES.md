# Reasoning and thinking capability investigation

Status: investigation/design note, not implemented API.
Date: 2026-06-06.

## Intent

The current TypeScript SDK exposes a single `reasoningEffort` field on `LLMProfile` with OpenAI-style `low | medium | high` values. That field is too magical for the real provider APIs. OpenAI, Anthropic, Gemini, OpenRouter, and LiteLLM-compatible transports expose different controls, accepted values, defaults, model-family behavior, and error surfaces.

The replacement should expose provider/model-family-native capability discovery and validation. It must not silently map every provider into OpenAI labels.

## Current TypeScript inventory

The actual SDK path is `src/llm/`, not `packages/agent-sdk/src/sdk/llm/` in this repository.

| Concrete API/client | Current file | Notes |
| --- | --- | --- |
| OpenAI Responses API | `src/llm/openai.ts` / `OpenAIResponsesClient` | Uses `/responses`; sends `reasoning.effort` and `reasoning.summary`. |
| OpenAI-compatible Chat Completions | `src/llm/openai.ts` / `OpenAIChatClient` | Uses `/chat/completions`; direct OpenAI chat, OpenRouter, LiteLLM proxy, and OpenAI-compatible proxies currently share this transport. |
| Anthropic Messages API | `src/llm/anthropic.ts` / `AnthropicMessagesClient` | Uses `/v1/messages`; current code derives `thinking: { type: 'enabled', budget_tokens }` from legacy `reasoningEffort`. |
| Gemini GenerateContent API | `src/llm/gemini.ts` / `GeminiClient` | Uses `:generateContent`; current code maps legacy `reasoningEffort` to `generationConfig.thinkingConfig.thinkingLevel`. Gemini Interactions is not implemented yet. |

`src/llm/factory.ts` resolves `providerId` / `baseUrl` to Anthropic, Gemini, OpenAI Responses, or OpenAI-compatible Chat. For `openrouter` and `litellm_proxy`, the current transport is OpenAI-compatible Chat, but the upstream model family may still be Anthropic, Gemini, or OpenAI.

## Primary-source evidence

### OpenAI

Source: <https://platform.openai.com/docs/guides/reasoning>

Relevant quotes:

- "Start with gpt-5.6 for most reasoning workloads."
- "Reasoning models work better with the Responses API . While the Chat Completions API is still supported, you’ll get improved model intelligence and performance by using Responses."
- "The reasoning.effort parameter guides the model on how much to think when performing a task. Supported values are model-dependent and can include none , minimal , low , medium , high , and xhigh ."
- "Defaults are also model-dependent rather than universal. gpt-5.5 defaults to medium reasoning effort."
- "Reasoning summaries While we don’t expose the raw reasoning tokens emitted by the model, you can view a summary of the model’s reasoning using the summary parameter."
- "Different models support different reasoning summary settings."

### Anthropic

Sources:

- <https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking>
- <https://docs.anthropic.com/en/docs/build-with-claude/effort>
- <https://docs.anthropic.com/en/docs/build-with-claude/task-budgets>

Relevant quotes:

- "Extended thinking is available on all current Claude models. How you enable it depends on the model"
- "Claude Fable 5 Claude Mythos 5 Not supported (400 error) Adaptive thinking , always on; use effort to control depth"
- "Claude Opus 4.8 Not supported (400 error) Adaptive thinking with effort"
- "Claude Sonnet 5 Not supported (400 error) Adaptive thinking with effort"
- "Claude Haiku 4.5 Supported N/A"
- "With adaptive thinking, the model decides when and how much to think on each request."
- "To turn on extended thinking, add a thinking object with type set to enabled and a budget_tokens value."
- "On models where manual extended thinking is deprecated or not supported (see Supported models ), use type: \"adaptive\" instead as described in Adaptive thinking ."
- "The effort parameter is supported by Claude Fable 5, Claude Mythos 5 , Claude Opus 4.8, Claude Mythos Preview , Claude Opus 4.7, Claude Opus 4.6, Claude Sonnet 5, Claude Sonnet 4.6, and Claude Opus 4.5."
- "By default, Claude uses high effort"
- "Setting effort to \"high\" produces exactly the same behavior as omitting the effort parameter entirely."
- "Effort levels Level Description Typical use case max Absolute maximum capability with no constraints on token spending."
- "xhigh Extended capability for long-horizon work. Available on Claude Fable 5, Claude Mythos 5, Claude Opus 4.8, Claude Opus 4.7, and Claude Sonnet 5."
- "Task budgets complement the effort parameter : effort controls how thoroughly Claude reasons about each step, while task budgets cap the total work Claude can do across an agentic loop."

### Gemini

Sources:

- <https://ai.google.dev/gemini-api/docs/thinking>
- <https://ai.google.dev/api/generate-content>

Relevant quotes:

- "Gemini models engage in dynamic thinking by default, automatically adjusting the amount of reasoning effort based on the complexity of the request."
- "You can control this behavior using the thinking_level parameter."
- "Model Default Thinking Levels Supported gemini-3.1-pro-preview On (high) low, medium, high gemini-3.1-flash-lite-image On (minimal) minimal, high gemini-3-flash-preview On (high) minimal, low, medium, high gemini-3-pro-preview On (high) low, high gemini-3.5-flash On (medium) minimal, low, medium, high gemini-2.5-pro On low, medium, high gemini-2.5-flash On low, medium, high gemini-2.5-flash-lite Off low, medium, high"
- "Thought signatures are encrypted representations of the model's internal reasoning. They are required to maintain reasoning continuity across multi-turn interactions."
- "The Interactions API makes handling thought signatures much simpler than the generateContent API."
- "ThinkingConfig Config for thinking features. Fields includeThoughts boolean Indicates whether to include thoughts in the response."
- "thinkingBudget integer The number of thoughts tokens that the model should generate."
- "thinkingLevel enum ( ThinkingLevel ) Optional. Controls the maximum depth of the model's internal reasoning process before it produces a response."
- "Recommended for Gemini 3 or later models. Use with earlier models results in an error."
- "Enums THINKING_LEVEL_UNSPECIFIED Default value. MINIMAL Little to no thinking. LOW Low thinking level. MEDIUM Medium thinking level. HIGH High thinking level."

### LiteLLM / OpenAI-compatible proxy routing

Sources:

- <https://docs.litellm.ai/docs/proxy/configs>
- <https://docs.litellm.ai/docs/providers/openai>
- <https://docs.litellm.ai/docs/providers/anthropic>
- <https://docs.litellm.ai/docs/providers/gemini>

Relevant quotes:

- "model_name : the name to pass TO litellm from the external client litellm_params.model : the model string passed to the litellm.completion() function"
- "E.g.: model=vllm-models will route to openai/facebook/opt-125m ."
- "The `openai/` prefix will call openai.chat.completions.create"
- "Provider Route on LiteLLM anthropic/ (add this prefix to the model name, to route any requests to Anthropic - e.g. anthropic/claude-3-5-sonnet-20240620 )."
- "reasoning_effort is automatically mapped to output_config={\"effort\": ...} for Claude 4.6 and Opus 4.5 models (see Effort Parameter )"
- "Provider Route on LiteLLM gemini/"
- "If you just want to use an API key (like OpenAI), use the gemini/ prefix. Models without a prefix default to Vertex AI which requires full GCP authentication."
- "Gemini 3+ Models - thinking_level Parameter"


## Live probe evidence

Environment available for this investigation:

- OpenAI API key: available.
- Gemini API key: available.
- Anthropic API key: not available, so Anthropic live tests were not run.
- LiteLLM proxy key/base URL: not available, so LiteLLM live tests were not run.

All live probes used tiny prompts such as `Reply with exactly OK.` and low output caps.

### OpenAI GPT-5.6

Date: 2026-06-06.

#### Responses API, `POST /v1/responses`

| `reasoning.effort` sent | Result | Notes |
| --- | --- | --- |
| omitted | 200 | Response metadata reported `reasoning.effort: "medium"`. |
| `none` | 200 | Accepted. |
| `minimal` | 400 | `Unsupported value: 'minimal' is not supported with the 'gpt-5.6' model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.` |
| `low` | 200 | Accepted. |
| `medium` | 200 | Accepted. |
| `high` | 200 | Accepted. |
| `xhigh` | 200 | Accepted; response metadata preserved `reasoning.effort: "xhigh"`. |
| `max` | 200 | Accepted; response metadata preserved `reasoning.effort: "max"`. This is not listed in the public reasoning guide's generic value list and appears Responses-specific in this probe. |
| `invalid` | 400 | `Invalid value: 'invalid'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', and 'xhigh'.` |

Summary values for GPT-5.6 Responses:

| `reasoning.summary` sent | Result | Notes |
| --- | --- | --- |
| omitted | 200 | Response metadata reported `summary: null`. |
| `auto` | 200 | Response metadata normalized to `summary: "detailed"`. |
| `concise` | 200 | Accepted. |
| `detailed` | 200 | Accepted. |
| `invalid` | 400 | `Invalid value: 'invalid'. Supported values are: 'concise', 'detailed', and 'auto'.` |

#### Chat Completions API, `POST /v1/chat/completions`

| `reasoning_effort` sent | Result | Notes |
| --- | --- | --- |
| omitted | 200 | No `reasoning` metadata is returned in the chat response. |
| `none` | 200 | Accepted. |
| `minimal` | 400 | `Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.` |
| `low` | 200 | Accepted. |
| `medium` | 200 | Accepted. |
| `high` | 200 | Accepted. |
| `xhigh` | 200 | Accepted. |
| `max` | 400 | `Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.` |
| `invalid` | 400 | Unsupported value error; supported list was `none`, `low`, `medium`, `high`, `xhigh`. |

Decision: GPT-5.6 Responses and GPT-5.6 Chat Completions should not share the exact same effort union. Responses accepts `max` in this live probe; Chat Completions rejects it. Both reject `minimal` for GPT-5.6 even though OpenAI's generic docs say model-dependent values can include `minimal`.

### Gemini Interactions API

Date: 2026-06-06. Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions`.

| Model | Omitted/default | Accepted `thinking_level` values | Rejected values observed | Notes |
| --- | --- | --- | --- | --- |
| `gemini-3.5-flash` | 200; `total_thought_tokens: 65` | `minimal`, `low`, `medium`, `high` | `xhigh`, `off` | Default docs say medium. `minimal` produced `total_thought_tokens: 0` in the probe. |
| `gemini-3.1-pro-preview` | not probed omitted in selected script | `low`, `medium`, `high` | `minimal` | Error: `'minimal' is not a supported thinking level for this model. Allowed values are: high, low, medium.` |
| `gemini-3.1-flash-lite` | not probed omitted in selected script | `minimal`, `low`, `medium`, `high` | none among tested levels | `minimal` produced `total_thought_tokens: 0` in the probe. |
| `gemini-3.1-flash-lite-image` | not probed omitted in selected script | `low`, `high` | `minimal`, `medium` | Live result differs from the generic docs quote that listed `minimal, high`; the API error said allowed values are `high, low`. |
| `gemini-3-flash-preview` | not probed omitted in selected script | `minimal`, `low`, `medium`, `high` | none among tested levels | All four documented levels accepted. |
| `gemini-3-pro-preview` | 404 for actual generation | `low`, `high` validation still surfaced for some bad levels | `minimal`, `medium`, `xhigh`, `off` | The endpoint reported the model is no longer available despite docs/model-list visibility. Do not rely on static model names alone. |
| `gemini-2.5-flash` | 200; `total_thought_tokens: 17` | `minimal`, `low`, `medium`, `high` | `xhigh`, `off` | Live Interactions accepted `minimal` even though the docs table lists 2.5 Flash as `low, medium, high`. Treat docs and live API as potentially drifting. |

Decision: Gemini needs model-specific capability tables and/or live refresh. The public docs and live API can diverge, especially around preview and older models. Interactions should become the target API for new Gemini reasoning continuity because Google says it handles thought signatures more simply than `generateContent`.

### Gemini GenerateContent API

Date: 2026-06-06. Model: `gemini-3.5-flash`. Endpoint: `:generateContent`.

| `generationConfig.thinkingConfig` | Result | Notes |
| --- | --- | --- |
| omitted | 200 | Usage reported `thoughtsTokenCount: 63`; no thought parts were returned because `includeThoughts` was omitted. |
| `thinkingLevel: "MINIMAL", includeThoughts: true` | 200 | No thought parts; no `thoughtsTokenCount`. |
| `thinkingLevel: "LOW", includeThoughts: true` | 200 | One thought part returned. |
| `thinkingLevel: "MEDIUM", includeThoughts: true` | 200 | One thought part returned. |
| `thinkingLevel: "HIGH", includeThoughts: true` | 200 | One thought part returned. |
| `thinkingLevel: "XHIGH", includeThoughts: true` | 400 | Invalid enum value. |
| `thinkingBudget: 0, includeThoughts: true` | 200 | No thought parts; no `thoughtsTokenCount`. |
| `thinkingBudget: 64, includeThoughts: true` | 200 | No thought parts; no `thoughtsTokenCount` in this probe. |

Decision: GenerateContent has a different wire shape from Interactions (`thinkingLevel` enum names vs `thinking_level` lower-case values). Do not hide this behind one generic field.

### Anthropic and LiteLLM live-test gap

Anthropic and LiteLLM credentials/base URLs were not available in this environment, so this investigation records official docs only for those providers. Before implementing final model-family tables for Claude and LiteLLM proxy aliases, run small live probes for:

- Claude Fable 5
- latest Opus (`Claude Opus 4.8` per current docs)
- latest two Sonnet generations (`Claude Sonnet 5`, `Claude Sonnet 4.6` per current docs)
- latest Haiku (`Claude Haiku 4.5` per current docs)
- LiteLLM proxy model aliases that resolve to Anthropic, OpenAI, and Gemini upstream families.

## Provider/model matrix for the proposed SDK surface

| Upstream API/family | Reasoning/thinking control | Values/config shape to expose | Current migration risk |
| --- | --- | --- | --- |
| OpenAI Responses / GPT-5.6 | `reasoning.effort`, `reasoning.summary` | effort: `none | low | medium | high | xhigh | max` for GPT-5.6 Responses based on live probe; summary: `auto | concise | detailed` | Current `reasoningEffort` omits `none`, `xhigh`, `max`; includes no model-specific validation. |
| OpenAI Chat Completions / GPT-5.6 | `reasoning_effort` | `none | low | medium | high | xhigh` for GPT-5.6 Chat based on live probe | Current code omits `none` and `xhigh`; must not send Responses-only `max` to Chat. |
| Anthropic modern adaptive models | `output_config.effort` and `thinking: { type: "adaptive" }` where applicable | `low | medium | high | xhigh | max`, with model restrictions: `xhigh` only on Fable 5, Mythos 5, Opus 4.8, Opus 4.7, Sonnet 5 per docs; `max` availability differs by model | Current code converts legacy `reasoningEffort` to manual `budget_tokens`, which is wrong for Fable 5, Opus 4.8, Sonnet 5, and deprecated for Sonnet/Opus 4.6. |
| Anthropic manual thinking models | `thinking: { type: "enabled", budget_tokens, display? }` | explicit token budget less than `max_tokens`; display: `summarized | omitted` where supported | Current code invents budget from legacy effort. Replace with explicit budget config. |
| Anthropic task budgets beta | `output_config.task_budget` plus beta header | `{ type: "tokens", total, remaining? }` and opt-in beta header | Useful for future agent loops; should not be folded into a simple effort enum. |
| Gemini Interactions | `generation_config.thinking_level`, `generation_config.thinking_summaries` | lower-case model-specific values such as `minimal | low | medium | high`; exact set depends on model | Not implemented. Should be target for Gemini reasoning continuity. |
| Gemini GenerateContent | `generationConfig.thinkingConfig` | enum values `MINIMAL | LOW | MEDIUM | HIGH`, optional `thinkingBudget`, optional `includeThoughts` | Current code maps OpenAI low/medium/high to upper-case; misses `MINIMAL` and model-specific validation. |
| LiteLLM proxy / OpenAI-compatible transport | transport remains OpenAI-compatible, but upstream model family comes from proxy alias/prefix/config | Resolve capabilities from upstream namespace: `anthropic/...`, `gemini/...`, `openai/...`, known `claude`/`gemini`/`gpt` aliases, or explicit profile metadata | Current factory treats `litellm_proxy` as generic OpenAI-compatible Chat, so it cannot expose native Anthropic/Gemini semantics. |


## Proposed API shape

Design goals:

1. Discover exact accepted values before saving a profile.
2. Validate invalid provider/model/value combinations before a network call whenever the SDK has a known table.
3. Keep transport separate from upstream model family: a LiteLLM/OpenRouter/OpenAI-compatible transport can still target Anthropic, Gemini, or OpenAI semantics.
4. Preserve serializable profiles.
5. Avoid hidden lossy mappings from OpenAI `reasoning_effort` to non-OpenAI providers.

### Capability discovery

Expose a pure capability function that does not require secrets:

```ts
export interface LLMCapabilityQuery {
  readonly providerId: string;
  readonly model: string;
  readonly baseUrl?: string | null;
  readonly openAiApiMode?: OpenAiApiMode;
  readonly upstreamProviderId?: 'openai' | 'anthropic' | 'gemini' | 'unknown';
}

export function getReasoningCapabilities(query: LLMCapabilityQuery): ReasoningCapabilities;
```

Also expose a client method delegating to the same resolver for Engel's desired `claudeProfile.reasoningOptions()`-style ergonomics:

```ts
export interface LLMClient {
  readonly profile: LLMProfile;
  complete(messages: readonly Message[]): Promise<LLMCompletionResponse>;
  reasoningOptions?(): ReasoningCapabilities;
}
```

A profile object can expose the same behavior without needing a network client:

```ts
export function reasoningOptionsForProfile(profile: LLMProfile): ReasoningCapabilities;
```

### Discriminated capability union

```ts
export type ReasoningCapabilities =
  | {
      readonly api: 'openai_responses';
      readonly effort: CapabilityEnum<OpenAIResponsesReasoningEffort>;
      readonly summary: CapabilityEnum<OpenAIReasoningSummary>;
      readonly wire: { readonly effort: 'reasoning.effort'; readonly summary: 'reasoning.summary' };
    }
  | {
      readonly api: 'openai_chat_completions';
      readonly effort: CapabilityEnum<OpenAIChatReasoningEffort>;
      readonly wire: { readonly effort: 'reasoning_effort' };
    }
  | {
      readonly api: 'anthropic_messages';
      readonly mode:
        | { readonly kind: 'adaptive'; readonly effort: CapabilityEnum<AnthropicEffort>; readonly display?: CapabilityEnum<AnthropicThinkingDisplay> }
        | { readonly kind: 'manual_budget'; readonly budgetTokens: CapabilityIntegerRange; readonly display?: CapabilityEnum<AnthropicThinkingDisplay> };
      readonly taskBudget?: CapabilityIntegerRange;
      readonly wire: { readonly thinking: 'thinking'; readonly outputConfig: 'output_config' };
    }
  | {
      readonly api: 'gemini_interactions';
      readonly thinkingLevel: CapabilityEnum<GeminiInteractionThinkingLevel>;
      readonly thinkingSummaries?: CapabilityEnum<'auto'>;
      readonly wire: { readonly generationConfig: 'generation_config'; readonly thinkingLevel: 'generation_config.thinking_level' };
    }
  | {
      readonly api: 'gemini_generate_content';
      readonly thinkingLevel: CapabilityEnum<GeminiGenerateContentThinkingLevel>;
      readonly thinkingBudget?: CapabilityIntegerRange;
      readonly includeThoughts: boolean;
      readonly wire: { readonly thinkingConfig: 'generationConfig.thinkingConfig' };
    }
  | {
      readonly api: 'unknown_openai_compatible';
      readonly reason: string;
      readonly recommendedAction: 'set_upstreamProviderId' | 'probe_live';
    };

export interface CapabilityEnum<T extends string> {
  readonly values: readonly T[];
  readonly defaultValue?: T;
  readonly unavailableValues?: Partial<Record<string, string>>;
  readonly source: 'static_docs' | 'live_probe' | 'model_error' | 'unknown';
}

export interface CapabilityIntegerRange {
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMaxField?: 'maxOutputTokens' | 'max_tokens';
  readonly source: 'static_docs' | 'live_probe' | 'unknown';
}
```

### Serializable profile config

Replace the cross-provider `reasoningEffort` / `reasoningSummary` fields with a discriminated `reasoning` object. Keep legacy fields temporarily as deprecated input-only fields during migration.

```ts
export type LLMReasoningConfig =
  | { readonly api: 'openai_responses'; readonly effort?: OpenAIResponsesReasoningEffort; readonly summary?: OpenAIReasoningSummary }
  | { readonly api: 'openai_chat_completions'; readonly effort?: OpenAIChatReasoningEffort }
  | {
      readonly api: 'anthropic_messages';
      readonly thinking?:
        | { readonly type: 'adaptive'; readonly effort?: AnthropicEffort; readonly display?: AnthropicThinkingDisplay }
        | { readonly type: 'enabled'; readonly budgetTokens: number; readonly display?: AnthropicThinkingDisplay };
      readonly taskBudget?: { readonly type: 'tokens'; readonly total: number; readonly remaining?: number };
    }
  | { readonly api: 'gemini_interactions'; readonly thinkingLevel?: GeminiInteractionThinkingLevel; readonly thinkingSummaries?: 'auto' }
  | { readonly api: 'gemini_generate_content'; readonly thinkingLevel?: GeminiGenerateContentThinkingLevel; readonly thinkingBudget?: number; readonly includeThoughts?: boolean };
```

Initial type aliases from current evidence:

```ts
export type OpenAIResponsesReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OpenAIChatReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAIReasoningSummary = 'auto' | 'concise' | 'detailed';
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AnthropicThinkingDisplay = 'summarized' | 'omitted';
export type GeminiInteractionThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type GeminiGenerateContentThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
```

Model-specific capability records then narrow these unions. Example: GPT-5.6 Chat removes `max`; GPT-5.6 Responses removes `minimal`; Gemini 3.1 Pro removes `minimal`; Anthropic Sonnet 4.6 removes `xhigh` but keeps `max` per docs.

### Upstream-family resolution for OpenAI-compatible transports

Add explicit profile metadata so capability discovery does not depend only on fragile string heuristics:

```ts
export const upstreamProviderIdSchema = z.union([
  z.literal('openai'),
  z.literal('anthropic'),
  z.literal('gemini'),
  z.literal('unknown'),
]);
```

Resolution order:

1. `profile.upstreamProviderId` when present.
2. LiteLLM/OpenRouter namespace prefix in `profile.model`, e.g. `anthropic/...`, `gemini/...`, `openai/...`.
3. Known model-family patterns such as `claude-*`, `gemini-*`, `gpt-*`.
4. `providerId` / `baseUrl` fallback.
5. Unknown OpenAI-compatible capability requiring a live probe or explicit upstream provider.

### Validation and errors

Add:

```ts
export function validateReasoningConfig(profile: LLMProfile): void;
export function normalizeReasoningConfig(profile: LLMProfile): LLMProfile;
```

Error shape should include provider, transport API, upstream family, model, bad field, bad value, accepted values, and source of the capability table. Example:

```text
Invalid reasoning config for gpt-5.6 via openai_chat_completions: reasoning.effort="max" is not accepted. Accepted values: none, low, medium, high, xhigh. Source: live_probe 2026-06-06.
```

### Migration plan

1. Keep `reasoningEffort` and `reasoningSummary` in `llmProfileSchema` for one compatibility release, marked deprecated.
2. Add `reasoning` as the preferred field.
3. For OpenAI profiles only, migrate legacy fields losslessly where possible:
   - Chat: `low | medium | high` -> `reasoning: { api: 'openai_chat_completions', effort }`.
   - Responses: `low | medium | high` plus summary -> `reasoning: { api: 'openai_responses', effort, summary }`.
4. For Anthropic and Gemini, do not silently migrate legacy `reasoningEffort`. Return a warning/error requiring provider-native config because the current mapping invented budgets/levels and can be wrong by model.
5. Update builders to read only `profile.reasoning` after migration; legacy fields should pass through a migration helper at parse/load boundaries, not inside transport code.
6. Add table-driven unit tests for every matrix row above, then live probes behind manual scripts for OpenAI/Gemini and, once credentials are available, Anthropic/LiteLLM.

## Recommended implementation order

1. Add the capability resolver and tests without changing request builders.
2. Add `reasoning` to the serializable `LLMProfile` schema and migration helpers.
3. Update OpenAI builders first because live evidence is complete for GPT-5.6.
4. Add Gemini Interactions as a new concrete client/API target; do not retrofit Interactions semantics into `GeminiClient`/GenerateContent.
5. Update GenerateContent to use provider-native `reasoning.api: 'gemini_generate_content'` only.
6. Update Anthropic after live credentials are available for the requested model set.
7. Add LiteLLM/OpenRouter upstream-family capability resolution; require explicit `upstreamProviderId` when aliases are ambiguous.

## Remaining gaps

- Anthropic live probes were blocked by missing credentials.
- LiteLLM proxy live probes were blocked by missing proxy key/base URL.
- The current Gemini `gemini-3-pro-preview` docs/model-list visibility disagreed with Interactions availability; capability refresh should treat preview models as volatile.
- The OpenAI public guide lists `minimal` generically, but GPT-5.6 rejects it in both Responses and Chat in live probes; the final resolver must be model-specific, not provider-global.
- OpenAI Responses accepted `max` in live probing even though the generic guide quote listed `xhigh` but not `max`; this needs either another official source or a live-probe-backed capability entry.

