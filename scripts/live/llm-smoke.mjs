#!/usr/bin/env node

import {
  MacOSKeychainSecretStore,
  createAnthropicClientFromProfile,
  createGeminiClientFromProfile,
  createLlmClientFromProfile,
  createOpenAIResponsesClientFromProfile,
  llmProfileSchema,
  textContent,
} from '../../dist/index.mjs';

const providerId = process.env.LLM_PROVIDER_ID ?? 'openai';
const profileId = process.env.LLM_PROFILE_ID ?? `live-${providerId}`;
const model = process.env.LLM_MODEL;
const baseUrl = process.env.LLM_BASE_URL ?? null;
const openAiApiMode = process.env.OPENAI_API_MODE ?? 'chat_completions';

if (model === undefined || model.length === 0) {
  throw new Error('Set LLM_MODEL to the model to smoke-test. API keys are read from the OS keyring only.');
}

const profile = llmProfileSchema.parse({
  profileId,
  providerId,
  model,
  baseUrl,
  openAiApiMode,
  maxOutputTokens: 32,
});
const store = new MacOSKeychainSecretStore();
const client = await createClient(profile, store);
const result = await client.complete([{ role: 'user', content: [textContent('Reply with exactly: ok')] }]);

console.log(JSON.stringify({ providerId, profileId, model, text: result.message.content, usage: result.usage }, null, 2));

async function createClient(profile, store) {
  if (profile.providerId === 'anthropic') {
    return createAnthropicClientFromProfile(profile, store);
  }
  if (profile.providerId === 'gemini') {
    return createGeminiClientFromProfile(profile, store);
  }
  if (profile.openAiApiMode === 'responses') {
    return createOpenAIResponsesClientFromProfile(profile, store);
  }
  return createLlmClientFromProfile(profile, store);
}
