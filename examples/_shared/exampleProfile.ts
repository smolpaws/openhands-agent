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
  return readProviderApiKey(profile.providerId, env) !== null;
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
  const apiKey = readProviderApiKey(profile.providerId, env);
  if (apiKey === null) {
    return null;
  }

  const store = new InMemorySecretStore([[llmProviderSecretRef(profile.providerId), apiKey]]);
  return createLlmClientFromProfile(profile, store);
}

export function explainSkippedExample(name: string): void {
  const profile = buildExampleLlmProfile();
  console.log(`${name}: set ${providerApiKeyEnvName(profile.providerId)} to run this example against a real ${profile.providerId} LLM profile.`);
}

function readProviderApiKey(providerId: string, env: NodeJS.ProcessEnv): string | null {
  const value = env[providerApiKeyEnvName(providerId)]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function providerApiKeyEnvName(providerId: string): string {
  return `${providerId.replace(/[^a-zA-Z0-9]/gu, '_').toUpperCase()}_API_KEY`;
}
