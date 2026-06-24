import { describe, expect, it } from 'vitest';

import {
  AGENT_PROFILE_SCHEMA_VERSION,
  acpAgentProfileSchema,
  openHandsAgentProfileSchema,
  validateAgentProfile,
} from '../index.js';

describe('AgentProfile schemas', () => {
  it('round-trips an OpenHands agent profile', () => {
    const profile = openHandsAgentProfileSchema.parse({
      name: 'my-openhands',
      llm_profile_ref: 'default',
      revision: 3,
      mcp_server_refs: ['fetch'],
      system_message_suffix: 'be terse',
      enable_sub_agents: true,
      tool_concurrency_limit: 4,
    });
    const reloaded = validateAgentProfile(JSON.parse(JSON.stringify(profile)));

    expect(reloaded).toEqual(profile);
    expect(reloaded.agent_kind).toBe('openhands');
    expect(reloaded.agent).toBe('CodeActAgent');
    expect(reloaded.llm_profile_ref).toBe('default');
    expect(reloaded.revision).toBe(3);
    expect(reloaded.mcp_server_refs).toEqual(['fetch']);
    expect(reloaded.tool_concurrency_limit).toBe(4);
  });

  it('round-trips an ACP agent profile with defaults', () => {
    const profile = validateAgentProfile({ agent_kind: 'acp', name: 'minimal' });

    expect(profile.agent_kind).toBe('acp');
    if (profile.agent_kind !== 'acp') {
      throw new Error('expected ACP profile');
    }
    expect(profile.acp_server).toBe('claude-code');
    expect(profile.acp_model).toBeNull();
    expect(profile.acp_session_mode).toBeNull();
    expect(profile.acp_prompt_timeout).toBe(1800);
    expect(profile.acp_command).toBeNull();
    expect(profile.acp_args).toBeNull();
  });

  it('defaults a missing discriminator to OpenHands', () => {
    const profile = validateAgentProfile({ name: 'oh', llm_profile_ref: 'default' });

    expect(profile.agent_kind).toBe('openhands');
  });

  it('rejects cross-variant fields and unknown ACP providers', () => {
    expect(() => validateAgentProfile({ agent_kind: 'acp', name: 'acp', llm_profile_ref: 'default' })).toThrow();
    expect(() => validateAgentProfile({ agent_kind: 'openhands', name: 'oh', llm_profile_ref: 'default', acp_server: 'codex' })).toThrow();
    expect(() => validateAgentProfile({ agent_kind: 'acp', name: 'acp', acp_server: 'not-a-provider' })).toThrow();
  });

  it('preserves mcp_server_refs null versus empty list', () => {
    const useAll = validateAgentProfile({ name: 'a', llm_profile_ref: 'd', mcp_server_refs: null });
    const useNone = validateAgentProfile({ name: 'b', llm_profile_ref: 'd', mcp_server_refs: [] });
    const subset = validateAgentProfile({ name: 'c', llm_profile_ref: 'd', mcp_server_refs: ['fetch'] });

    expect(useAll.mcp_server_refs).toBeNull();
    expect(useNone.mcp_server_refs).toEqual([]);
    expect(subset.mcp_server_refs).toEqual(['fetch']);
    expect(validateAgentProfile(JSON.parse(JSON.stringify(useAll))).mcp_server_refs).toBeNull();
    expect(validateAgentProfile(JSON.parse(JSON.stringify(useNone))).mcp_server_refs).toEqual([]);
  });

  it('validates schema_version and preserves UUID identity', () => {
    const profile = validateAgentProfile({ name: 'oh', llm_profile_ref: 'd' });

    expect(profile.schema_version).toBe(AGENT_PROFILE_SCHEMA_VERSION);
    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    expect(validateAgentProfile({ ...profile, id: profile.id }).id).toBe(profile.id);
    expect(() => validateAgentProfile({ name: 'oh', llm_profile_ref: 'd', schema_version: AGENT_PROFILE_SCHEMA_VERSION + 1 })).toThrow(/newer than supported/u);
    expect(() => validateAgentProfile({ name: 'oh', llm_profile_ref: 'd', schema_version: '1' })).toThrow(/must be an integer/u);
    expect(() => validateAgentProfile({ name: 'oh', llm_profile_ref: 'd', schema_version: -1 })).toThrow(/non-negative/u);
  });

  it('persists no raw secret fields', () => {
    const openHands = openHandsAgentProfileSchema.parse({ name: 'oh', llm_profile_ref: 'default' });
    const acp = acpAgentProfileSchema.parse({ name: 'acp', acp_server: 'claude-code' });
    const leakedVerification = validateAgentProfile({
      name: 'oh',
      llm_profile_ref: 'default',
      verification: {
        critic_enabled: true,
        critic_model_name: 'gpt-5.5',
        critic_api_key: 'REDACT_ME_TEST_VALUE',
      },
    });

    expect(JSON.stringify(openHands)).not.toMatch(/api[_-]?key|"llm"/iu);
    expect(JSON.stringify(acp)).not.toMatch(/api[_-]?key|secrets|agent_context|"llm"/iu);
    expect(JSON.stringify(leakedVerification)).not.toContain('critic_api_key');
    expect(JSON.stringify(leakedVerification)).not.toContain('REDACT_ME_TEST_VALUE');
  });
});
