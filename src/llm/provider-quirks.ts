import type { LLMProfile, PromptCacheRetention, ReasoningEffort } from './index.js';

export const ANTHROPIC_THINKING_MIN_BUDGET = 1024;
export const ANTHROPIC_THINKING_MAX_BUDGET = 128000;

const PROMPT_CACHE_MODELS = [
  'claude-3-7-sonnet',
  'claude-sonnet-3-7-latest',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-haiku',
  'claude-3-opus',
  'claude-sonnet-4',
  'claude-opus-4',
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
] as const;

export function isGpt5Model(model: string | null | undefined): boolean {
  return model?.trim().toLowerCase().includes('gpt-5') === true;
}

export function isGpt56Model(model: string | null | undefined): boolean {
  const normalized = model?.trim().toLowerCase().replace(/^openai\//u, '') ?? '';
  return /^gpt-5\.6(?:[-.]|$)/u.test(normalized);
}

export function isOpenAISubscriptionEndpoint(profile: LLMProfile): boolean {
  const baseUrl = profile.baseUrl?.trim().toLowerCase() ?? '';
  return baseUrl.includes('chatgpt.com/backend-api/codex');
}

export function supportsOpenAIPromptCacheRetention(profile: LLMProfile): boolean {
  if (profile.providerId !== 'openai' || isOpenAISubscriptionEndpoint(profile) || !isGpt56Model(profile.model)) {
    return false;
  }
  const baseUrl = profile.baseUrl?.trim().toLowerCase();
  return baseUrl === undefined || baseUrl === '' || baseUrl.startsWith('https://api.openai.com/');
}

export function resolveOpenAIPromptCacheRetention(profile: LLMProfile): PromptCacheRetention | undefined {
  if (!supportsOpenAIPromptCacheRetention(profile) || profile.promptCacheRetention === 'disabled') {
    return undefined;
  }
  return profile.promptCacheRetention ?? '24h';
}

export function resolveOpenAIPromptCacheKey(profile: LLMProfile): string | undefined {
  if (!supportsOpenAIPromptCacheRetention(profile)) {
    return undefined;
  }
  return profile.promptCacheKey ?? undefined;
}


export function hasExtendedThinking(profile: LLMProfile): boolean {
  return profile.reasoningEffort !== null;
}

// Reasoning models emit a hidden reasoning/thinking segment alongside the answer,
// and some of them (DeepSeek dual-mode, Moonshot Kimi thinking, MiniMax-M2, ...)
// REQUIRE that segment to be echoed back on the next turn or the provider rejects
// the request (HTTP 400: "reasoning_content ... must be passed back"). See
// `isReasoningModel` for how we decide to send `reasoning_content` / `thinking_blocks`.
//
// NOTE: the Python SDK models this as an explicit per-model `send_reasoning_content`
// feature flag (SEND_REASONING_CONTENT_MODELS). We deliberately renamed it to a
// single `isReasoningModel` predicate: if a model reasons, we echo its reasoning by
// default rather than maintaining a separate "should we send it back" flag. Keep this
// list broader than the Python one on purpose.
const REASONING_MODELS = [
  'deepseek-reasoner',
  'deepseek-r1',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'kimi-k2-thinking',
  'kimi-k2.5',
  'kimi-k2.6',
  'kimi-k3',
  'minimax-m2',
  'glm-4.6',
  'qwen3',
  'qwq',
] as const;

/**
 * Whether the profile's model produces reasoning/thinking content that must be
 * threaded back to the provider on subsequent turns.
 *
 * Substring match, so an optional provider-qualified id (`deepseek/deepseek-v4-flash`)
 * resolves the same as the bare model name (`deepseek-v4-flash`).
 */
export function isReasoningModel(profile: LLMProfile): boolean {
  const model = profile.model.trim().toLowerCase();
  return REASONING_MODELS.some((candidate) => model.includes(candidate));
}

export function isAnthropicModel(profile: LLMProfile): boolean {
  if (profile.providerId === 'anthropic') {
    return true;
  }
  const model = profile.model.trim().toLowerCase();
  if (model.startsWith('anthropic/') || model.includes('claude')) {
    return true;
  }
  return profile.baseUrl?.toLowerCase().includes('anthropic.com') === true;
}

export function supportsThinkingBlocks(profile: LLMProfile): boolean {
  return isAnthropicModel(profile) && hasExtendedThinking(profile);
}

export function supportsPromptCaching(profile: LLMProfile): boolean {
  if (!isAnthropicModel(profile)) {
    return false;
  }
  const model = profile.model.trim().toLowerCase();
  return PROMPT_CACHE_MODELS.some((needle) => model.includes(needle));
}

export function getAnthropicThinkingBudget(profile: LLMProfile, maxTokens: number): number | undefined {
  if (!supportsThinkingBlocks(profile)) {
    return undefined;
  }
  if (maxTokens <= ANTHROPIC_THINKING_MIN_BUDGET) {
    throw new Error(
      `Anthropic extended thinking requires maxOutputTokens greater than ${ANTHROPIC_THINKING_MIN_BUDGET}; got ${maxTokens}.`,
    );
  }

  const targetBudget = Math.floor(maxTokens * 0.8);
  return Math.min(ANTHROPIC_THINKING_MAX_BUDGET, maxTokens - 1, Math.max(ANTHROPIC_THINKING_MIN_BUDGET, targetBudget));
}

export function normalizeGenerationParamsForModel(profile: LLMProfile): LLMProfile {
  if (isGpt5Model(profile.model)) {
    return { ...profile, temperature: null };
  }
  if (supportsThinkingBlocks(profile)) {
    return { ...profile, temperature: 1 };
  }
  return profile;
}

export function toGeminiThinkingLevel(reasoningEffort: ReasoningEffort | null): 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  if (reasoningEffort === null) {
    return undefined;
  }
  switch (reasoningEffort) {
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    case 'high':
      return 'HIGH';
  }
}
