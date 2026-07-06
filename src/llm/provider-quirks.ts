import type { LLMProfile, ReasoningEffort } from './index.js';

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

export function hasExtendedThinking(profile: LLMProfile): boolean {
  return profile.reasoningEffort !== null;
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
