import { describe, expect, it } from 'vitest';

import {
  AGENT_SETTINGS_SCHEMA_VERSION,
  CONVERSATION_SETTINGS_SCHEMA_VERSION,
  acpAgentSettingsSchema,
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
