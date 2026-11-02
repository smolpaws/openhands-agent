import { describe, expect, it } from 'vitest';
import { validateAgentSettings, openHandsAgentSettingsSchema, acpAgentSettingsSchema, agentSettingsSchema, AGENT_SETTINGS_SCHEMA_VERSION } from '../index.js';
import { validateAgentProfile, openHandsAgentProfileSchema, agentProfileSchema, AGENT_PROFILE_SCHEMA_VERSION } from '../../profiles/index.js';
const base = { llm_profile_ref: 'main' };

describe('retired tool-switch migrations (upstream #41443fc and #33d8aa29)', () => {
  it('reports removed fields through the exported schemas without throwing from safeParse', () => {
    for (const schema of [openHandsAgentSettingsSchema, agentSettingsSchema]) {
      const result = schema.safeParse({ ...base, enable_sub_agents: true });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('Removed agent settings');
    }
    const acp = acpAgentSettingsSchema.safeParse({ llm: { api_key: 'REDACT_ME_TEST_VALUE' } });
    expect(acp.success).toBe(false);
    if (!acp.success) expect(acp.error.message).not.toContain('REDACT_ME_TEST_VALUE');
    for (const schema of [openHandsAgentProfileSchema, agentProfileSchema]) {
      const result = schema.safeParse({ ...base, name: 'p', enable_switch_llm_tool: false });
      expect(result.success).toBe(false);
    }
  });

  // Adapted from test_saved_v8_retired_switches_are_discarded_without_crashing.
  it.each([null, [], [{ name: 'terminal', params: {} }]])('preserves v8 tool selection while dropping saved switches: %j', tools => {
    const settings = validateAgentSettings({
      ...base, schema_version: 8, tools, enable_sub_agents: true, enable_switch_llm_tool: false,
    }, { persisted: true });
    expect(settings.tools).toEqual(tools);
    expect(settings).not.toHaveProperty('enable_sub_agents');
    expect(settings).not.toHaveProperty('enable_switch_llm_tool');
    expect(validateAgentSettings(JSON.parse(JSON.stringify(settings)), { persisted: true })).toEqual(settings);
  });

  // Adapted from test_v3_persisted_payload_discards_retired_switches.
  it.each([null, [], [{ name: 'terminal', params: {} }]])('preserves v3 profile tool selection while dropping saved switches: %j', tools => {
    const profile = validateAgentProfile({
      ...base, name: 'p', schema_version: 3, tools, enable_sub_agents: true, enable_switch_llm_tool: false,
    });
    expect(profile.tools).toEqual(tools);
    expect(profile.schema_version).toBe(AGENT_PROFILE_SCHEMA_VERSION);
    expect(profile).not.toHaveProperty('enable_sub_agents');
    expect(profile).not.toHaveProperty('enable_switch_llm_tool');
    expect(validateAgentProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it.each(['enable_sub_agents', 'enable_switch_llm_tool'])('rejects current %s input, including explicit current versions', switchName => {
    for (const schema_version of [undefined, null, AGENT_SETTINGS_SCHEMA_VERSION]) {
      expect(() => validateAgentSettings({ ...base, schema_version, [switchName]: true })).toThrow('Removed agent settings');
    }
    for (const schema_version of [undefined, null, AGENT_PROFILE_SCHEMA_VERSION]) {
      expect(() => validateAgentProfile({ ...base, name: 'p', schema_version, [switchName]: true })).toThrow('Retired tool switches');
    }
  });

  // Adapted from test_saved_acp_llm_is_discarded_without_leaking_credentials.
  it.each([undefined, null, 6, 7, 8])('drops stored ACP credentials at legacy version %s', schema_version => {
    const settings = validateAgentSettings({
      agent_kind: 'acp', schema_version, acp_model: 'sonnet',
      llm: { model: 'ignored', api_key: 'REDACT_ME_TEST_VALUE' }, enable_sub_agents: true,
    }, { persisted: true });
    expect(settings).toMatchObject({ agent_kind: 'acp', acp_model: 'sonnet', schema_version: AGENT_SETTINGS_SCHEMA_VERSION });
    expect(settings).not.toHaveProperty('llm');
    expect(settings).not.toHaveProperty('enable_sub_agents');
    expect(JSON.stringify(settings)).not.toContain('REDACT_ME_TEST_VALUE');
  });

  it('distinguishes bare new requests from legacy persisted empty lists', () => {
    expect(validateAgentSettings({ ...base, tools: [] }).tools).toEqual([]);
    expect(validateAgentSettings({ ...base, tools: [] }, { persisted: true }).tools).toBeNull();
    expect(validateAgentSettings({ ...base, schema_version: 7, tools: [] }).tools).toBeNull();
    expect(validateAgentSettings({ ...base, schema_version: 8, tools: [] }, { persisted: true }).tools).toEqual([]);
  });
  it('rejects removed switches on requests and preserves parameterized aliases', () => {
    expect(() => openHandsAgentSettingsSchema.parse({ ...base, tools: [], enable_sub_agents: true })).toThrow('Removed agent settings');
    expect(() => validateAgentSettings({ ...base, enable_switch_llm_tool: false })).toThrow('Removed agent settings');
    const explicit = validateAgentSettings({ ...base, tools: [{ name: 'ClassifyAndSwitchLLMTool', params: { active_meta_profile: 'chosen' } }, { name: 'route_task_to_model', params: { active_meta_profile: 'ignored' } }] });
    expect(explicit.tools).toEqual([{ name: 'route_task_to_model', params: { active_meta_profile: 'chosen' } }]);
  });
  it('migrates v2 profiles and never reinterprets current empty tools', () => {
    const old = validateAgentProfile({ ...base, name: 'custom', schema_version: 2, tools: [], enable_switch_llm_tool: false });
    expect(old.schema_version).toBe(4);
    expect(old.tools).toEqual(['terminal', 'file_editor', 'task_tracker', 'browser_tool_set'].map(name => ({ name, params: {} })));
    expect(validateAgentProfile({ ...base, name: 'new', tools: [] }).tools).toEqual([]);
    expect(() => validateAgentProfile({ ...base, name: 'invalid', schema_version: 0 })).toThrow('No migration');
  });
  it('rejects removed settings on requests and drops them from persisted legacy storage', () => {
    expect(() => validateAgentSettings({ ...base, enable_switch_llm_tool: false })).toThrow('Removed agent settings');
    expect(() => validateAgentSettings({ agent_kind: 'acp', llm: { api_key: 'secret' } })).toThrow('Removed agent settings');
    const acp6 = validateAgentSettings({ agent_kind: 'acp', schema_version: 6, llm: { api_key: 'secret' } });
    expect(JSON.stringify(acp6)).not.toContain('secret');
    const v7 = validateAgentSettings({ ...base, schema_version: 7, enable_switch_llm_tool: false });
    expect(v7.schema_version).toBe(AGENT_SETTINGS_SCHEMA_VERSION);
    const acp8 = validateAgentSettings({ agent_kind: 'acp', schema_version: 8, llm: {} }, { persisted: true });
    expect(JSON.stringify(acp8)).not.toContain('llm');
  });
  it('drops ACP llm, rejects it on OpenHands, and keeps persona bounded and OpenHands-only', () => {
    const acp = validateAgentSettings({ agent_kind: 'acp', schema_version: 6, llm: { api_key: 'secret' } });
    expect(JSON.stringify(acp)).not.toContain('secret');
    expect(() => validateAgentSettings({ ...base, llm: { api_key: 'secret' } })).toThrow();
    expect(validateAgentSettings({ ...base, persona: 'My agent' }).persona).toBe('My agent');
    expect(() => validateAgentSettings({ ...base, persona: '' })).toThrow();
    expect(() => validateAgentProfile({ ...base, name: 'p', persona: 'x'.repeat(65537) })).toThrow();
    expect(() => validateAgentSettings({ agent_kind: 'acp', persona: 'x' })).toThrow();
  });
  it('does not persist an unsupported structured-response contract', () => {
    expect(() => validateAgentSettings({ ...base, tools: [{ name: 'finish', params: { response_schema: { type: 'object' } } }] })).toThrow('response_schema');
    expect(() => validateAgentProfile({ ...base, name: 'p', tools: [{ name: 'think', params: { response_schema: { type: 'object' } } }] })).toThrow('response_schema');
  });
  it('rejects unsafe explicit router params before persistence and preserves unrelated host params', () => {
    const bad = [{ name: 'ClassifyAndSwitchLLMTool', params: { meta_profile_llms: { main: { api_key: 'secret' } } } }];
    expect(() => validateAgentSettings({ ...base, tools: bad })).toThrow();
    expect(() => validateAgentProfile({ ...base, name: 'unsafe', tools: bad })).toThrow();
    expect(validateAgentSettings({ ...base, tools: [{ name: 'custom', params: { marker: 'kept' } }] }).tools).toEqual([{ name: 'custom', params: { marker: 'kept' } }]);
  });
});
