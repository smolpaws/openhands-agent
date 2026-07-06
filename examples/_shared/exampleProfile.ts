import {
  InMemorySecretStore,
  createLlmClientFromProfile,
  llmProfileSchema,
  llmProviderSecretRef,
  type LLMClient,
  type LLMProfile,
} from '@smolpaws/openhands-agent';

const DEFAULT_PROVIDER_ID = 'openai';
const DEFAULT_MODEL = 'gpt-5-nano';

export function hasExampleLlmCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const profile = buildExampleLlmProfile(env);
  return readExampleProviderApiKey(profile.providerId, env) !== null;
}

export function buildExampleLlmProfile(env: NodeJS.ProcessEnv = process.env): LLMProfile {
  const providerId = env.LLM_PROVIDER_ID?.trim() || env.LLM_PROVIDER?.trim() || DEFAULT_PROVIDER_ID;
  return llmProfileSchema.parse({
    profileId: env.LLM_PROFILE?.trim() || `examples-${providerId}`,
    providerId,
    model: env.OPENAI_MODEL?.trim() || env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  });
}

export async function getExampleLlmClient(env: NodeJS.ProcessEnv = process.env): Promise<LLMClient | null> {
  const profile = buildExampleLlmProfile(env);
  const store = createExampleLlmSecretStore(profile, env);
  if (store === null) {
    return null;
  }

  return createLlmClientFromProfile(profile, store);
}

export function createExampleLlmSecretStore(profile: LLMProfile, env: NodeJS.ProcessEnv = process.env): InMemorySecretStore | null {
  const apiKey = readExampleProviderApiKey(profile.providerId, env);
  if (apiKey === null) {
    return null;
  }
  return new InMemorySecretStore([[llmProviderSecretRef(profile.providerId), apiKey]]);
}

export function explainSkippedExample(name: string): void {
  const profile = buildExampleLlmProfile();
  console.log(`${name}: set ${providerApiKeyEnvName(profile.providerId)} to run this example against a real ${profile.providerId} LLM profile.`);
}

export function readExampleProviderApiKey(providerId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[providerApiKeyEnvName(providerId)]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

export function providerApiKeyEnvName(providerId: string): string {
  return `${providerId.replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()}_API_KEY`;
}
