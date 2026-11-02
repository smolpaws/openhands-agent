import { describe, expect, it } from 'vitest';
import { validateAgentSettings, openHandsAgentSettingsSchema, AGENT_SETTINGS_SCHEMA_VERSION } from '../index.js';
import { validateAgentProfile } from '../../profiles/index.js';
const base = { llm_profile_ref: 'main' };

describe('v8 settings and v3 profile migration (upstream #41443fc)', () => {
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
