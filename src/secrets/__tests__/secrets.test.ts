import { describe, expect, it } from 'vitest';

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
