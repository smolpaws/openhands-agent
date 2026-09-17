import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { llmProfileSchema, type LLMProfile } from '../index.js';

const nativeProfile = llmProfileSchema.parse({ profileId: 'haiku', providerId: 'anthropic', model: 'claude-haiku-4-5' });
const proxyProfile = llmProfileSchema.parse({ profileId: 'fable', providerId: 'litellm_proxy', model: 'anthropic/claude-fable-5-1' });

describe('Anthropic cache duration in saved profiles', () => {
  it.each([
    ['anthropic', 'claude-haiku-4-5'], ['litellm_proxy', 'anthropic/claude-fable-5-1'],
    ['openai', 'gpt-5.4'], ['deepseek', 'deepseek-v4-flash'], ['gemini', 'gemini-2.5-pro'],
    ['litellm_proxy', 'openai/gpt-5.4'],
  ])('leaves an omitted Anthropic TTL absent when parsing and restoring a %s %s profile', (providerId, model) => {
    const input = { profileId: 'without-ttl', providerId, model };
    expect(llmProfileSchema.parse(input)).not.toHaveProperty('anthropicCacheTtl');
    // A normalized profile remains usable by typed SDK callers without this provider option.
    const withoutTtl: LLMProfile = llmProfileSchema.omit({ anthropicCacheTtl: true }).parse(input);
    const serialized = JSON.stringify(withoutTtl);
    expect(serialized).not.toContain('anthropicCacheTtl');
    expect(llmProfileSchema.parse(JSON.parse(serialized))).not.toHaveProperty('anthropicCacheTtl');
  });

  it('describes an optional duration with no schema-inserted default', () => {
    const schema = z.toJSONSchema(llmProfileSchema);
    expect(schema.required).not.toContain('anthropicCacheTtl');
    expect(schema.properties?.anthropicCacheTtl).toEqual({ type: 'string', enum: ['5m', '1h'] });
  });

  it('round-trips an explicit duration independently of OpenAI retention', () => {
    for (const anthropicCacheTtl of ['5m', '1h'] as const) {
      const profile = llmProfileSchema.parse({ ...proxyProfile, anthropicCacheTtl, promptCacheRetention: '24h' });
      expect(llmProfileSchema.parse(JSON.parse(JSON.stringify(profile)))).toMatchObject({ anthropicCacheTtl, promptCacheRetention: '24h' });
    }
    for (const anthropicCacheTtl of ['24h', 'disabled', '', null]) {
      expect(llmProfileSchema.safeParse({ ...nativeProfile, anthropicCacheTtl }).success).toBe(false);
    }
  });
});
