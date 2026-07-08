#!/usr/bin/env node

import {
  MacOSKeychainSecretStore,
  createClientFromProfile,
  llmProfileSchema,
  textContent,
} from '../../dist/index.mjs';

const providerId = process.env.LLM_PROVIDER_ID ?? 'openai';
const profileId = process.env.LLM_PROFILE_ID ?? `live-${providerId}`;
const model = process.env.LLM_MODEL;
const baseUrl = process.env.LLM_BASE_URL ?? null;
const openAiApiMode = process.env.OPENAI_API_MODE ?? 'chat_completions';
const useProfileKeyOverride = process.env.LLM_USE_PROFILE_KEY_OVERRIDE === 'true';

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
  useProfileKeyOverride,
});
const store = new MacOSKeychainSecretStore();
const client = await createClientFromProfile(profile, store);
const result = await client.complete([{ role: 'user', content: [textContent('Reply with exactly: ok')] }]);

console.log(JSON.stringify({ providerId, profileId, model, text: result.message.content, usage: result.usage }, null, 2));
