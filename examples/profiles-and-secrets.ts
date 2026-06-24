import {
  InMemorySecretStore,
  getLlmApiKey,
  llmProfileSchema,
  llmProfileSecretRef,
  llmProviderSecretRef,
  resolveLlmProfileApiKeyRef,
} from '@smolpaws/openhands-agent';

const store = new InMemorySecretStore();
await store.set(llmProviderSecretRef('openai'), 'provider-key-from-secure-store');
await store.set(llmProfileSecretRef('eval-profile'), 'profile-key-from-secure-store');

const defaultProfile = llmProfileSchema.parse({
  profileId: 'daily-driver',
  providerId: 'openai',
  model: 'gpt-5.5',
});
const overrideProfile = llmProfileSchema.parse({
  profileId: 'eval-profile',
  providerId: 'openai',
  model: 'gpt-5.5',
  useProfileKeyOverride: true,
});

const defaultRef = await resolveLlmProfileApiKeyRef(defaultProfile, store);
const overrideRef = await resolveLlmProfileApiKeyRef(overrideProfile, store);
const overrideKey = await getLlmApiKey(
  { providerId: overrideProfile.providerId, profileId: overrideProfile.profileId, useProfileKeyOverride: overrideProfile.useProfileKeyOverride },
  store,
);

console.log({
  defaultAccount: defaultRef?.account,
  overrideAccount: overrideRef?.account,
  overrideKeyLoaded: overrideKey !== null,
});
