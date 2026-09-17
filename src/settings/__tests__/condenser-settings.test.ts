import { describe, expect, it, vi } from 'vitest';

import { NoOpCondenser } from '../../context/condenser.js';
import { LLMSummarizingCondenser } from '../../context/llm-summarizing-condenser.js';
import { defaultCondenser } from '../../context/llm-summarizing-condenser.js';
import type { LLMClient } from '../../llm/client.js';
import { llmProfileSchema } from '../../llm/index.js';
import { condenserSettingsSchema, materializeCondenser, validateAgentSettings } from '../index.js';

function client(id: string, limit: number | null = null): LLMClient {
  return {
    profile: llmProfileSchema.parse({ profileId: id, providerId: 'openai', model: 'test-model' }),
    effectiveMaxInputTokens: limit,
    complete: vi.fn().mockRejectedValue(new Error('No LLM calls expected')),
  };
}

// PORT: tests/sdk/test_settings.py condenser cases at the shared pin.
// DEV-SDK-004: resolve a separate saved profile instead of copying the main LLM.
describe('validated condenser settings', () => {
  it('loads the old discriminator-free settings with class defaults', () => {
    const settings = validateAgentSettings({ llm_profile_ref: 'agent', condenser: { enabled: true, max_size: 100, max_tokens: 5000 } });
    expect(settings).toMatchObject({ condenser: {
      condenser_kind: 'llm_summarizing', enabled: true, max_size: 100, max_tokens: 5000,
      keep_first: 2, minimum_progress: 0.1, hard_context_reset_max_retries: 5,
      hard_context_reset_context_scaling: 0.8,
    } });
  });

  it('keeps old default settings loadable without inventing a profile selection', () => {
    const settings = validateAgentSettings({ llm_profile_ref: 'agent' });
    expect(settings).toMatchObject({ condenser: { condenser_kind: 'llm_summarizing', enabled: true, max_size: 240, keep_first: 2 } });
    expect(settings.condenser).not.toHaveProperty('llm_profile_ref');
    expect(settings.condenser).not.toHaveProperty('max_tokens');
  });

  it.each(['no_op', 'noop'])('loads %s as canonical no_op', (kind) => {
    expect(condenserSettingsSchema.parse({ condenser_kind: kind })).toEqual({ condenser_kind: 'no_op', enabled: true });
  });

  it('preserves omitted versus explicit null max_tokens through JSON', () => {
    const omitted = condenserSettingsSchema.parse({});
    const explicitNull = condenserSettingsSchema.parse({ max_tokens: null });
    expect(condenserSettingsSchema.parse(JSON.parse(JSON.stringify(omitted)))).not.toHaveProperty('max_tokens');
    expect(condenserSettingsSchema.parse(JSON.parse(JSON.stringify(explicitNull)))).toHaveProperty('max_tokens', null);
  });

  it.each([
    { max_size: 19 }, { max_size: 20.5 }, { keep_first: -1 }, { keep_first: 1.5 },
    { max_tokens: 0 }, { max_tokens: -1 }, { max_tokens: 2.5 },
    { minimum_progress: 0 }, { minimum_progress: 1 },
    { hard_context_reset_max_retries: 0 }, { hard_context_reset_max_retries: 1.5 },
    { hard_context_reset_context_scaling: 0 }, { hard_context_reset_context_scaling: 1 },
    { llm_profile_ref: ' ' }, { condenser_kind: 'unknown' },
    { llm: { model: 'raw-model' } }, { api_key: 'synthetic-test-key' },
    { condenser_kind: 'no_op', keep_first: 2 },
  ])('rejects invalid or raw settings %j', (invalid) => {
    expect(() => condenserSettingsSchema.parse(invalid)).toThrow();
    expect(() => validateAgentSettings({ llm_profile_ref: 'agent', condenser: invalid })).toThrow();
  });
});

describe('materializeCondenser', () => {
  it('builds enabled settings with a separate resolved profile and every configured limit', async () => {
    const agentLlm = client('agent');
    const condenserLlm = client('summary');
    const resolveClient = vi.fn().mockResolvedValue(condenserLlm);
    const condenser = await materializeCondenser({ llm_profile_ref: 'summary', max_size: 100, max_tokens: 5000,
      keep_first: 3, minimum_progress: 0.2, hard_context_reset_max_retries: 7, hard_context_reset_context_scaling: 0.6 },
    { resolveClient, agentLlm });
    expect(resolveClient).toHaveBeenCalledExactlyOnceWith('summary');
    expect(condenser).toBeInstanceOf(LLMSummarizingCondenser);
    expect(condenser).toMatchObject({ llm: condenserLlm, maxSize: 100, maxTokens: 5000, keepFirst: 3,
      minimumProgress: 0.2, hardContextResetMaxRetries: 7, hardContextResetContextScaling: 0.6 });
    expect(condenser.llm).not.toBe(agentLlm);
  });

  it('distinguishes the settings defaults from defaultCondenser', async () => {
    const llm = client('summary');
    const condenser = await materializeCondenser({ llm_profile_ref: 'summary' }, { resolveClient: async () => llm });
    expect(condenser).toMatchObject({ maxSize: 240, keepFirst: 2 });
    expect(defaultCondenser(llm)).toMatchObject({ maxSize: 80, keepFirst: 4 });
  });

  it.each([
    [{ enabled: false }, null],
    [{ condenser_kind: 'no_op', enabled: false }, null],
    [{ condenser_kind: 'no_op' }, 'noop'],
  ])('does not resolve profiles for disabled or no-op settings %j', async (settings, expected) => {
    const resolveClient = vi.fn().mockRejectedValue(new Error('Must not resolve'));
    const resolveRuntimeMetadata = vi.fn().mockRejectedValue(new Error('Must not inspect main LLM'));
    const result = await materializeCondenser(settings, { resolveClient, agentLlm: { ...client('agent'), resolveRuntimeMetadata } });
    if (expected === null) expect(result).toBeNull();
    else expect(result).toBeInstanceOf(NoOpCondenser);
    expect(resolveClient).not.toHaveBeenCalled();
    expect(resolveRuntimeMetadata).not.toHaveBeenCalled();
  });

  it.each([[undefined, 65536], [5000, 5000], [null, null]])('keeps Python max_tokens=%s inheritance', async (maxTokens, expected) => {
    const settings = condenserSettingsSchema.parse({ llm_profile_ref: 'summary', ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }) });
    const condenser = await materializeCondenser(settings, { resolveClient: async () => client('summary'), agentLlm: client('agent', 65536) });
    expect(condenser).toMatchObject({ maxTokens: expected });
  });

  it('keeps an unknown token limit unknown', async () => {
    const condenser = await materializeCondenser({ llm_profile_ref: 'summary' }, { resolveClient: async () => client('summary'), agentLlm: client('agent') });
    expect(condenser).toMatchObject({ maxTokens: null });
  });

  it('resolves deferred agent metadata only for an inherited limit', async () => {
    let limit: number | null = null;
    const resolveRuntimeMetadata = vi.fn(async () => { limit = 2048; });
    const agentLlm = { ...client('agent'), get effectiveMaxInputTokens() { return limit; }, resolveRuntimeMetadata };
    const condenser = await materializeCondenser({ llm_profile_ref: 'summary' }, { resolveClient: async () => client('summary'), agentLlm });
    expect(condenser).toMatchObject({ maxTokens: 2048 });
    expect(resolveRuntimeMetadata).toHaveBeenCalledOnce();
  });

  it('requires explicit profile selection and never silently reuses the main client', async () => {
    const resolveClient = vi.fn();
    await expect(materializeCondenser({}, { resolveClient, agentLlm: client('agent') })).rejects.toThrow(/condenser.*llm_profile_ref/iu);
    expect(resolveClient).not.toHaveBeenCalled();
  });

  it('uses an explicit host default but gives persisted profile selection precedence', async () => {
    const resolveClient = vi.fn(async (ref: string) => client(ref));
    await materializeCondenser({}, { resolveClient, defaultProfileRef: 'host-summary' });
    await materializeCondenser({ llm_profile_ref: 'saved-summary' }, { resolveClient, defaultProfileRef: 'host-summary' });
    expect(resolveClient.mock.calls).toEqual([['host-summary'], ['saved-summary']]);
  });

  it('propagates profile resolution failure without falling back to the main client', async () => {
    const failure = new Error('Saved condenser profile unavailable');
    const resolveClient = vi.fn().mockRejectedValue(failure);
    await expect(materializeCondenser({ llm_profile_ref: 'missing' }, { resolveClient, agentLlm: client('agent') })).rejects.toBe(failure);
    expect(resolveClient).toHaveBeenCalledExactlyOnceWith('missing');
  });

  it('rejects invalid retention combinations before resolving a client', async () => {
    const resolveClient = vi.fn();
    await expect(materializeCondenser({ llm_profile_ref: 'summary', max_size: 20, keep_first: 9 }, { resolveClient })).rejects.toThrow(/keep_first/u);
    expect(resolveClient).not.toHaveBeenCalled();
  });
});
