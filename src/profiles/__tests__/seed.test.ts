import { describe, expect, it } from 'vitest';
import { AgentContext } from '../../context/agent-context.js';
import { validateAgentSettings } from '../../settings/index.js';
import { buildSeedProfile } from '../seed.js';
import { validateAgentProfile } from '../index.js';

describe('native default profile seed', () => {
  it('preserves the context deny list without freezing inline skill names or raw secrets', () => {
    const settings = validateAgentSettings({ llm_profile_ref: 'ignored', tools: [], persona: 'Tester',
      condenser: { enabled: false }, enable_classify_and_switch_llm_tool: true, active_meta_profile: 'routing',
      tool_concurrency_limit: 4, verification: { critic_enabled: true, critic_model_name: 'critic' } });
    const context = new AgentContext({ disabledSkills: ['beta', 'missing'], systemMessageSuffix: 'Keep the suffix', secrets: { TOKEN: 'not-persisted' } });
    const profile = buildSeedProfile(settings, 'selected', { context });
    expect(profile).toMatchObject({ schema_version: 4, name: 'default', llm_profile_ref: 'selected', tools: [], persona: 'Tester',
      disabled_skills: ['beta', 'missing'], system_message_suffix: 'Keep the suffix', public_skills: null,
      mcp_server_refs: null, enable_classify_and_switch_llm_tool: true, meta_profile_ref: 'routing', tool_concurrency_limit: 4,
      verification: { critic_enabled: true, critic_model_name: 'critic' } });
    expect(JSON.stringify(profile)).not.toContain('not-persisted');
    expect(JSON.stringify(profile)).not.toContain('TOKEN');
    expect(validateAgentProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    expect(buildSeedProfile(settings, null, { name: 'custom' })).toMatchObject({ name: 'custom', llm_profile_ref: 'default', disabled_skills: [] });
  });

  it('preserves native hard fallback settings, omission and explicit null', () => {
    const ordinary = validateAgentSettings({ llm_profile_ref: 'main', condenser: { enabled: false } });
    expect(buildSeedProfile(ordinary, 'main')).not.toHaveProperty('hard_condenser');
    const withNull = validateAgentSettings({ ...ordinary, hard_condenser: null });
    expect(buildSeedProfile(withNull, 'main')).toHaveProperty('hard_condenser', null);
    const reset = validateAgentSettings({ llm_profile_ref: 'main', condenser: { condenser_kind: 'agent_reset' },
      hard_condenser: { condenser_kind: 'llm_summarizing', llm_profile_ref: 'summary' } });
    const seeded = buildSeedProfile(reset, 'main');
    expect(seeded).toHaveProperty('hard_condenser', reset.hard_condenser);
    expect(validateAgentProfile(JSON.parse(JSON.stringify(seeded)))).toEqual(seeded);
    expect(() => validateAgentProfile({ name: 'invalid', llm_profile_ref: 'main', hard_condenser: { condenser_kind: 'llm_summarizing', llm_profile_ref: 'summary' } })).toThrow();
  });

  it('seeds ACP metadata as a quoted command without enabling ACP execution', () => {
    const settings = validateAgentSettings({ agent_kind: 'acp', acp_command: ['my tool', "a'b", ''], acp_args: ['--flag'], acp_model: 'chosen' });
    const profile = buildSeedProfile(settings, null);
    expect(profile).toMatchObject({ agent_kind: 'acp', name: 'default', acp_command: "'my tool' 'a'\"'\"'b' ''", acp_args: ['--flag'], acp_model: 'chosen', mcp_server_refs: null });
    expect(profile).not.toHaveProperty('public_skills');
    expect(profile).not.toHaveProperty('llm_profile_ref');
    expect(buildSeedProfile(validateAgentSettings({ agent_kind: 'acp' }), null)).toMatchObject({ acp_command: null, acp_args: null });
  });
});
