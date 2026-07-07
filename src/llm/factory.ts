import type { SecretStore } from '../secrets/index.js';
import { createAnthropicClientFromProfile } from './anthropic.js';
import type { LLMClient } from './client.js';
import { createGeminiClientFromProfile } from './gemini.js';
import type { LLMProfile } from './index.js';
import { createOpenAIChatClientFromProfile, createOpenAIResponsesClientFromProfile, type CreateLlmClientOptions } from './openai.js';

const DETECTED_LLM_PROVIDERS = ['anthropic', 'gemini', 'openai', 'openrouter', 'litellm_proxy'] as const;

export type DetectedLlmProvider = (typeof DETECTED_LLM_PROVIDERS)[number];

export async function createClientFromProfile(
  profile: LLMProfile,
  store: SecretStore,
  options: CreateLlmClientOptions = {},
): Promise<LLMClient> {
  const provider = resolveProviderFromProfile(profile);
  if (provider === 'anthropic') {
    return createAnthropicClientFromProfile(profile, store, options);
  }
  if (provider === 'gemini') {
    return createGeminiClientFromProfile(profile, store, options);
  }
  if (profile.openAiApiMode === 'responses') {
    return createOpenAIResponsesClientFromProfile(profile, store, options);
  }
  return createOpenAIChatClientFromProfile(profile, store, options);
}

export function resolveProviderFromProfile(profile: LLMProfile): DetectedLlmProvider {
  const providerId = profile.providerId.toLowerCase();
  if (isDetectedLlmProvider(providerId)) {
    return providerId;
  }
  return detectProviderFromBaseUrl(profile.baseUrl);
}

export function detectProviderFromBaseUrl(baseUrl?: string | null): DetectedLlmProvider {
  const normalized = (baseUrl ?? '').toLowerCase();
  if (normalized.includes('anthropic')) {
    return 'anthropic';
  }
  if (normalized.includes('generativelanguage.googleapis.com') || normalized.includes('ai.google.dev') || normalized.includes('gemini')) {
    return 'gemini';
  }
  if (normalized.includes('openrouter')) {
    return 'openrouter';
  }
  if (normalized.includes('litellm') || normalized.includes('llm-proxy')) {
    return 'litellm_proxy';
  }
  return 'openai';
}

function isDetectedLlmProvider(providerId: string): providerId is DetectedLlmProvider {
  return DETECTED_LLM_PROVIDERS.includes(providerId as DetectedLlmProvider);
}
