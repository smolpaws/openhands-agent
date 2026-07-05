import {
  InMemorySecretStore,
  createLlmClientFromProfile,
  llmProfileSchema,
  llmProviderSecretRef,
  type LLMClient,
  type LLMProfile,
} from '@smolpaws/openhands-agent';

const DEFAULT_PROFILE_ID = 'examples-openai';
const DEFAULT_MODEL = 'gpt-5-nano';

export function hasExampleLlmCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENAI_API_KEY ?? '').trim().length > 0;
}

export function buildExampleLlmProfile(env: NodeJS.ProcessEnv = process.env): LLMProfile {
  return llmProfileSchema.parse({
    profileId: env.LLM_PROFILE?.trim() || DEFAULT_PROFILE_ID,
    providerId: 'openai',
    model: env.OPENAI_MODEL?.trim() || env.LLM_MODEL?.trim() || DEFAULT_MODEL,
  });
}

export async function getExampleLlmClient(env: NodeJS.ProcessEnv = process.env): Promise<LLMClient | null> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return null;
  }

  const profile = buildExampleLlmProfile(env);
  const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), apiKey]]);
  return createLlmClientFromProfile(profile, store);
}

export function explainSkippedExample(name: string): void {
  console.log(`${name}: set OPENAI_API_KEY to run this example against a real OpenAI LLM profile.`);
}
