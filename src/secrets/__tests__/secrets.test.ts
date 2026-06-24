import { describe, expect, it } from 'vitest';

import { llmProfileSchema, resolveLlmProfileApiKeyRef } from '../../llm/index.js';

import {
  InMemorySecretStore,
  OPENHANDS_KEYRING_SERVICE,
  getLlmApiKey,
  llmProfileSecretRef,
  llmProviderSecretRef,
  resolveLlmApiKeyRef,
  secretRefSchema,
} from '../index.js';

describe('SecretRef', () => {
  it('serializes a keyring reference without a raw value', () => {
    const ref = secretRefSchema.parse({ account: 'llm-provider:openai' });

    expect(ref).toEqual({ service: OPENHANDS_KEYRING_SERVICE, account: 'llm-provider:openai' });
    expect(JSON.stringify(ref)).not.toContain('sk-');
  });

  it('builds provider-scoped and profile-scoped LLM refs', () => {
    expect(llmProviderSecretRef('litellm_proxy')).toEqual({
      service: 'openhands',
      account: 'llm-provider:litellm_proxy',
    });
    expect(llmProfileSecretRef('eval-proxy')).toEqual({
      service: 'openhands',
      account: 'llm-profile:eval-proxy:api-key',
    });
  });
});

describe('LLM API key resolution', () => {
  it('uses the provider key by default', async () => {
    const store = new InMemorySecretStore([
      [llmProviderSecretRef('litellm_proxy'), 'provider-key'],
      [llmProfileSecretRef('app-proxy'), 'profile-key'],
    ]);

    await expect(
      getLlmApiKey({ providerId: 'litellm_proxy', profileId: 'app-proxy' }, store),
    ).resolves.toBe('provider-key');
    await expect(
      resolveLlmApiKeyRef({ providerId: 'litellm_proxy', profileId: 'app-proxy' }, store),
    ).resolves.toEqual(llmProviderSecretRef('litellm_proxy'));
  });

  it('uses an enabled profile override when present', async () => {
    const store = new InMemorySecretStore([
      [llmProviderSecretRef('litellm_proxy'), 'provider-key'],
      [llmProfileSecretRef('eval-proxy'), 'eval-key'],
    ]);

    await expect(
      getLlmApiKey({ providerId: 'litellm_proxy', profileId: 'eval-proxy', useProfileKeyOverride: true }, store),
    ).resolves.toBe('eval-key');
    await expect(
      resolveLlmApiKeyRef({ providerId: 'litellm_proxy', profileId: 'eval-proxy', useProfileKeyOverride: true }, store),
    ).resolves.toEqual(llmProfileSecretRef('eval-proxy'));
  });

  it('falls back to the provider key when the enabled profile override is missing', async () => {
    const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'provider-key']]);

    await expect(
      getLlmApiKey({ providerId: 'openai', profileId: 'missing-profile-key', useProfileKeyOverride: true }, store),
    ).resolves.toBe('provider-key');
  });

  it('returns null when neither profile nor provider key exists', async () => {
    const store = new InMemorySecretStore();

    await expect(
      resolveLlmApiKeyRef({ providerId: 'anthropic', profileId: 'sonnet', useProfileKeyOverride: true }, store),
    ).resolves.toBeNull();
    await expect(
      getLlmApiKey({ providerId: 'anthropic', profileId: 'sonnet', useProfileKeyOverride: true }, store),
    ).resolves.toBeNull();
  });
});

describe('LLM profiles with secret references', () => {
  it('parses profile configuration without persisting raw API keys', () => {
    const profile = llmProfileSchema.parse({
      profileId: 'eval-proxy',
      providerId: 'litellm_proxy',
      model: 'anthropic/claude-sonnet-4-5',
      baseUrl: 'https://litellm.example.test',
      useProfileKeyOverride: true,
      temperature: 0.2,
      headers: { 'X-Team': 'evals' },
    });

    expect(profile.profileId).toBe('eval-proxy');
    expect(profile.providerId).toBe('litellm_proxy');
    expect(JSON.stringify(profile)).not.toContain('apiKey');
    expect(() =>
      llmProfileSchema.parse({
        profileId: 'bad-secret',
        providerId: 'openai',
        model: 'gpt-5.1',
        apiKey: 'sk-should-not-persist',
      }),
    ).toThrow();
  });

  it('resolves profile API keys through SecretRef lookup', async () => {
    const profile = llmProfileSchema.parse({
      profileId: 'eval-proxy',
      providerId: 'litellm_proxy',
      model: 'gpt-5.1',
      useProfileKeyOverride: true,
    });
    const store = new InMemorySecretStore([
      [llmProviderSecretRef('litellm_proxy'), 'provider-key'],
      [llmProfileSecretRef('eval-proxy'), 'profile-key'],
    ]);

    await expect(resolveLlmProfileApiKeyRef(profile, store)).resolves.toEqual(llmProfileSecretRef('eval-proxy'));
  });
});

