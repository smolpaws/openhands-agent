import type { SecretStore } from '../secrets/index.js';
import { createAnthropicClientFromProfile } from './anthropic.js';
import type { LLMClient } from './client.js';
import { createGeminiClientFromProfile } from './gemini.js';
import type { LLMProfile } from './index.js';
import { createOpenAIChatClientFromProfile, createOpenAIResponsesClientFromProfile, type CreateLlmClientOptions } from './openai.js';

export type DetectedLlmProvider = 'anthropic' | 'gemini' | 'openai' | 'openrouter' | 'litellm_proxy';

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
  if (normalized.includes('anthropic.com')) {
    return 'anthropic';
  }
  if (normalized.includes('generativelanguage.googleapis.com') || normalized.includes('ai.google.dev')) {
    return 'gemini';
  }
  if (normalized.includes('openrouter.ai')) {
    return 'openrouter';
  }
  if (normalized.includes('litellm') || normalized.includes('llm-proxy')) {
    return 'litellm_proxy';
  }
  return 'openai';
}

function isDetectedLlmProvider(providerId: string): providerId is DetectedLlmProvider {
  return providerId === 'anthropic' || providerId === 'gemini' || providerId === 'openai' || providerId === 'openrouter' || providerId === 'litellm_proxy';
}
