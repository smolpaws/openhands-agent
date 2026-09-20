import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AgentResetCondenser } from '../../context/agent-reset-condenser.js';
import { LLMSummarizingCondenser } from '../../context/llm-summarizing-condenser.js';
import type { LLMClient } from '../../llm/client.js';
import { llmProfileSchema } from '../../llm/index.js';
import * as settings from '../index.js';

function client(profileId: string): LLMClient {
  return {
    profile: llmProfileSchema.parse({ profileId, providerId: 'openai', model: 'fixture' }),
    complete: vi.fn().mockRejectedValue(new Error('No completion expected')),
    resolveRuntimeMetadata: vi.fn().mockRejectedValue(new Error('No metadata lookup expected')),
  };
}

const agentReset = { condenser_kind: 'agent_reset' };
const hardFallback = { condenser_kind: 'llm_summarizing', llm_profile_ref: 'summary' };
const agentInput = { llm_profile_ref: 'main', condenser: agentReset };

// Target extension: voluntary reset has no LLM; hard fallback is explicitly and
// independently selected, without inheriting ordinary proactive condenser controls.
describe('agent-controlled condenser settings', () => {
  it('defaults advisory thresholds and preserves optional versus null fallback through JSON', () => {
    const absent = settings.validateAgentSettings(agentInput);
    expect(absent).toMatchObject({ schema_version: 5, condenser: {
      condenser_kind: 'agent_reset', enabled: true, warning_thresholds: [0.75, 0.8, 0.85, 0.9],
    } });
    expect(absent).not.toHaveProperty('hard_condenser');
    expect(settings.validateAgentSettings(JSON.parse(JSON.stringify(absent)))).toEqual(absent);
    const disabled = settings.validateAgentSettings({ ...agentInput, hard_condenser: null });
    expect(disabled).toHaveProperty('hard_condenser', null);
    expect(settings.validateAgentSettings(JSON.parse(JSON.stringify(disabled)))).toEqual(disabled);
  });

  it('round-trips custom warning thresholds and the independent hard profile and retry controls', () => {
    const configured = settings.validateAgentSettings({ ...agentInput,
      condenser: { ...agentReset, warning_thresholds: [0.5, 0.9, 1] },
      hard_condenser: { ...hardFallback, hard_context_reset_max_retries: 2, hard_context_reset_context_scaling: 0.6 },
    });
    expect(settings.validateAgentSettings(JSON.parse(JSON.stringify(configured)))).toEqual(configured);
    expect(settings.agentSettingsSchema.parse(configured)).toEqual(configured);
    expect(configured).toMatchObject({ hard_condenser: {
      ...hardFallback, hard_context_reset_max_retries: 2, hard_context_reset_context_scaling: 0.6,
    } });
  });

  it.each([[], [0], [-0.1], [1.01], [75, 80], [0.9, 0.8], [0.8, 0.8], [Number.NaN], [Number.POSITIVE_INFINITY], ['0.75'], null].map(value => [value]))(
    'rejects invalid advisory thresholds %j', warning_thresholds => {
      expect(() => settings.validateAgentSettings({ ...agentInput, condenser: { ...agentReset, warning_thresholds } })).toThrow();
    },
  );

  it.each(['llm_profile_ref', 'max_tokens', 'max_size', 'keep_first'])(
    'rejects inapplicable reset field %s', field => {
      expect(() => settings.validateAgentSettings({ ...agentInput, condenser: { ...agentReset, [field]: 20 } })).toThrow();
    },
  );

  it('loads ordinary defaults unchanged without adding the optional new field', () => {
    const original = settings.defaultAgentSettings('main');
    expect(original).toMatchObject({ schema_version: 5, condenser: {
      condenser_kind: 'llm_summarizing', enabled: true, max_size: 1000, keep_first: 2,
    } });
    expect(original).not.toHaveProperty('hard_condenser');
    expect(original.condenser).not.toHaveProperty('warning_thresholds');
    expect(settings.validateAgentSettings({ llm_profile_ref: 'main', hard_condenser: null })).toHaveProperty('hard_condenser', null);
  });

  it.each([undefined, {}, { condenser_kind: 'llm_summarizing' }, { condenser_kind: 'no_op' }, { ...agentReset, enabled: false }])(
    'rejects a configured hard fallback without enabled agent_reset: %j', condenser => {
      expect(() => settings.validateAgentSettings({ llm_profile_ref: 'main', condenser, hard_condenser: hardFallback })).toThrow();
    },
  );

  it('exposes the additive settings through the JSON schema without changing the version', () => {
    const schema = z.toJSONSchema(settings.openHandsAgentSettingsSchema);
    expect(schema.properties).toHaveProperty('hard_condenser');
    expect(schema.required).not.toContain('hard_condenser');
    expect(settings.AGENT_SETTINGS_SCHEMA_VERSION).toBe(5);
  });
});

describe('independent hard condenser settings', () => {
  it('has only an explicit profile and hard-reset retry defaults', () => {
    expect(settings.hardCondenserSettingsSchema.parse(hardFallback)).toEqual({
      ...hardFallback, hard_context_reset_max_retries: 5, hard_context_reset_context_scaling: 0.8,
    });
  });

  it.each([
    {}, { condenser_kind: 'llm_summarizing' }, { llm_profile_ref: 'summary' },
    { ...hardFallback, llm_profile_ref: '' }, { ...hardFallback, llm_profile_ref: ' ' },
    { ...hardFallback, condenser_kind: 'agent_reset' }, { ...hardFallback, condenser_kind: 'no_op' },
    { ...hardFallback, enabled: false }, { ...hardFallback, max_tokens: null },
    { ...hardFallback, max_size: 1000 }, { ...hardFallback, keep_first: 0 },
    { ...hardFallback, minimum_progress: 0.1 }, { ...hardFallback, api_key: 'synthetic-fixture' },
    { ...hardFallback, hard_context_reset_max_retries: 0 },
    { ...hardFallback, hard_context_reset_max_retries: 1.5 },
    { ...hardFallback, hard_context_reset_context_scaling: 0 },
    { ...hardFallback, hard_context_reset_context_scaling: 1 },
  ])('rejects missing profile, ordinary controls and invalid retry limits: %j', invalid => {
    expect(() => settings.validateAgentSettings({ ...agentInput, hard_condenser: invalid })).toThrow();
  });
});

describe('agent-controlled settings materialization', () => {
  it.each([undefined, [0.6, 0.9]].map(value => [value]))('creates reset mode without resolving any profile or main metadata: %j', async warning_thresholds => {
    const main = client('main');
    const resolveClient = vi.fn().mockRejectedValue(new Error('No profile lookup expected'));
    const condenser = await settings.materializeCondenser({ ...agentReset, ...(warning_thresholds ? { warning_thresholds } : {}) },
      { resolveClient, agentLlm: main, defaultProfileRef: 'must-not-be-used' });
    expect(condenser).toBeInstanceOf(AgentResetCondenser);
    expect(condenser).toMatchObject({ warningThresholds: warning_thresholds ?? [0.75, 0.8, 0.85, 0.9] });
    expect(resolveClient).not.toHaveBeenCalled();
    expect(main.resolveRuntimeMetadata).not.toHaveBeenCalled();
    expect(main.complete).not.toHaveBeenCalled();
  });

  it('does not construct a disabled reset condenser', async () => {
    const resolveClient = vi.fn();
    expect(await settings.materializeCondenser({ ...agentReset, enabled: false }, { resolveClient })).toBeNull();
    expect(resolveClient).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('omitted/null hard fallback makes no profile or metadata lookup: %j', async data => {
    const main = client('main');
    const resolveClient = vi.fn();
    expect(await settings.materializeHardCondenser(data, { resolveClient, agentLlm: main, defaultProfileRef: 'unused' })).toBeNull();
    expect(resolveClient).not.toHaveBeenCalled();
    expect(main.resolveRuntimeMetadata).not.toHaveBeenCalled();
  });

  it('resolves only the explicit independent fallback and never inherits the main token budget', async () => {
    const main = { ...client('main'), effectiveMaxInputTokens: 400_000 };
    const summary = client('summary');
    const resolveClient = vi.fn().mockResolvedValue(summary);
    const condenser = await settings.materializeHardCondenser({ ...hardFallback,
      hard_context_reset_max_retries: 3, hard_context_reset_context_scaling: 0.5,
    }, { resolveClient, agentLlm: main, defaultProfileRef: 'wrong-profile' });
    expect(resolveClient).toHaveBeenCalledExactlyOnceWith('summary');
    expect(condenser).toBeInstanceOf(LLMSummarizingCondenser);
    expect(condenser).toMatchObject({ llm: summary, maxTokens: null,
      hardContextResetMaxRetries: 3, hardContextResetContextScaling: 0.5,
    });
    expect(main.resolveRuntimeMetadata).not.toHaveBeenCalled();
    expect(main.complete).not.toHaveBeenCalled();
    expect(summary.complete).not.toHaveBeenCalled();
  });

  it('cannot fill a missing explicit fallback reference from a host default', async () => {
    const resolveClient = vi.fn();
    await expect(settings.materializeHardCondenser({ condenser_kind: 'llm_summarizing' },
      { resolveClient, defaultProfileRef: 'host-summary', agentLlm: client('main') })).rejects.toThrow();
    expect(resolveClient).not.toHaveBeenCalled();
  });

  it('propagates fallback resolution failures without borrowing the main client', async () => {
    const failure = new Error('Fallback profile unavailable');
    const resolveClient = vi.fn().mockRejectedValue(failure);
    await expect(settings.materializeHardCondenser(hardFallback, {
      resolveClient, defaultProfileRef: 'other', agentLlm: client('main'),
    })).rejects.toBe(failure);
    expect(resolveClient).toHaveBeenCalledExactlyOnceWith('summary');
  });
});
