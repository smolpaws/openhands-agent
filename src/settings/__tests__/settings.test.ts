import { describe, expect, it } from 'vitest';

import {
  AGENT_SETTINGS_SCHEMA_VERSION,
  CONVERSATION_SETTINGS_SCHEMA_VERSION,
  RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED,
  acpAgentSettingsSchema,
  clearRawLlmFieldsWhenProfileSelected,
  conversationSettingsSchema,
  defaultAgentSettings,
  openHandsAgentSettingsSchema,
  validateAgentSettings,
} from '../index.js';

describe('ConversationSettings', () => {
  it('parses persisted conversation settings without confirmation/security fields', () => {
    const settings = conversationSettingsSchema.parse({ max_iterations: 42 });

    expect(settings.schema_version).toBe(CONVERSATION_SETTINGS_SCHEMA_VERSION);
    expect(settings.max_iterations).toBe(42);
    expect(() => conversationSettingsSchema.parse({ confirmation_mode: true })).toThrow();
    expect(() => conversationSettingsSchema.parse({ security_analyzer: 'llm' })).toThrow();
  });

  it('validates observability metadata and tags', () => {
    expect(conversationSettingsSchema.parse({ observability_metadata: { repo: 'OpenHands/sdk' } }).observability_metadata)
      .toEqual({ repo: 'OpenHands/sdk' });
    expect(conversationSettingsSchema.parse({ observability_tags: ['sdk', 'local'] }).observability_tags)
      .toEqual(['sdk', 'local']);

    expect(() => conversationSettingsSchema.parse({ observability_metadata: { '': 'missing-key' } })).toThrow();
    expect(() => conversationSettingsSchema.parse({ observability_metadata: [] })).toThrow();
    expect(() => conversationSettingsSchema.parse({ observability_tags: [1, 2] })).toThrow();
  });
});

describe('AgentSettings', () => {
  it('parses profile-first OpenHands agent settings', () => {
    const settings = openHandsAgentSettingsSchema.parse({
      llm_profile_ref: 'default',
      tools: [{ name: 'TerminalTool' }],
      enable_sub_agents: true,
      enable_switch_llm_tool: false,
      tool_concurrency_limit: 3,
    });

    expect(settings.schema_version).toBe(AGENT_SETTINGS_SCHEMA_VERSION);
    expect(settings.agent_kind).toBe('openhands');
    expect(settings.agent).toBe('CodeActAgent');
    expect(settings.llm_profile_ref).toBe('default');
    expect(settings.tools).toEqual([{ name: 'TerminalTool' }]);
    expect(settings.tool_concurrency_limit).toBe(3);
    expect(JSON.stringify(settings)).not.toMatch(/api[_-]?key|"llm"/iu);
  });

  it('keeps OpenHandsAgentSettings aligned with canonical Python agent fields at the profile seam', () => {
    const settings = openHandsAgentSettingsSchema.parse({
      agent_kind: 'openhands',
      llm_profile_ref: 'cat-prod',
      agent: 'CodeActAgent',
      tools: [{ name: 'TerminalTool' }],
      enable_sub_agents: true,
      enable_switch_llm_tool: false,
      tool_concurrency_limit: 2,
      mcp_config: { mcpServers: {} },
      condenser: { condenser_kind: 'noop' },
      verification: {},
    });

    expect(Object.keys(settings).sort()).toEqual([
      'agent',
      'agent_kind',
      'condenser',
      'enable_sub_agents',
      'enable_switch_llm_tool',
      'llm_profile_ref',
      'mcp_config',
      'schema_version',
      'tool_concurrency_limit',
      'tools',
      'verification',
    ]);
    expect(settings.llm_profile_ref).toBe('cat-prod');
    expect(settings.mcp_config).toEqual({ mcpServers: {} });
    expect(JSON.stringify(settings)).not.toMatch(/api[_-]?key|agent_context|"llm"/iu);
  });

  it('clears raw LLM fields when a profile is selected', () => {
    const llm = clearRawLlmFieldsWhenProfileSelected({
      profileId: ' default ',
      provider: 'openai',
      model: 'gpt-5',
      openaiApiMode: 'responses',
      baseUrl: 'https://api.example.test',
      apiVersion: '2024-01-01',
      timeout: 60,
      temperature: 0.1,
      topP: 0.9,
      topK: 40,
      maxInputTokens: 1000,
      maxOutputTokens: 2000,
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      inputCostPerToken: 0.1,
      outputCostPerToken: 0.2,
      encrypted_reasoning: 'kept',
    });

    expect(RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED).toEqual([
      'provider',
      'model',
      'openaiApiMode',
      'baseUrl',
      'apiVersion',
      'timeout',
      'temperature',
      'topP',
      'topK',
      'maxInputTokens',
      'maxOutputTokens',
      'reasoningEffort',
      'reasoningSummary',
      'inputCostPerToken',
      'outputCostPerToken',
    ]);
    for (const field of RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED) {
      expect(llm[field]).toBeUndefined();
    }
    expect(llm.profileId).toBe(' default ');
    expect(llm.encrypted_reasoning).toBe('kept');
  });

  it('leaves raw LLM fields untouched without a selected profile', () => {
    const llm = { profileId: ' ', provider: 'openai', model: 'gpt-5' };

    expect(clearRawLlmFieldsWhenProfileSelected(llm)).toBe(llm);
    expect(llm).toEqual({ profileId: ' ', provider: 'openai', model: 'gpt-5' });
  });

  it('defaults a missing discriminator to OpenHands and rejects cross-variant fields', () => {
    expect(validateAgentSettings({ llm_profile_ref: 'default' }).agent_kind).toBe('openhands');
    expect(() => validateAgentSettings({ agent_kind: 'openhands', llm_profile_ref: 'default', acp_server: 'codex' })).toThrow();
    expect(() => validateAgentSettings({ agent_kind: 'acp', llm_profile_ref: 'default' })).toThrow();
  });

  it('parses ACP agent settings without embedded credentials', () => {
    const settings = acpAgentSettingsSchema.parse({
      agent_kind: 'acp',
      acp_server: 'codex',
      acp_command: ['codex-acp'],
      acp_args: ['--flag'],
      acp_model: 'gpt-5.5/medium',
    });

    expect(settings.acp_server).toBe('codex');
    expect(settings.acp_command).toEqual(['codex-acp']);
    expect(settings.acp_args).toEqual(['--flag']);
    expect(settings.acp_prompt_timeout).toBe(1800);
    expect(JSON.stringify(settings)).not.toMatch(/api[_-]?key|secrets|agent_context|"llm"/iu);
  });

  it('returns profile-first defaults', () => {
    expect(defaultAgentSettings('default').llm_profile_ref).toBe('default');
    expect(defaultAgentSettings('default').enable_switch_llm_tool).toBe(true);
  });
});
