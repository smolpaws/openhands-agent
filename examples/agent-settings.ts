import {
  clearRawLlmFieldsWhenProfileSelected,
  defaultAgentSettings,
  validateAgentProfile,
  validateAgentSettings,
} from '@smolpaws/openhands-agent';

const openHandsSettings = validateAgentSettings({
  llm_profile_ref: 'daily-driver',
  tools: [{ name: 'TerminalTool' }, { name: 'task_tool_set' }],
});

// Retired switches are accepted only when migrating legacy stored settings.
const migratedSettings = validateAgentSettings({
  schema_version: 7,
  llm_profile_ref: 'daily-driver',
  enable_sub_agents: true,
}, { persisted: true });

const acpProfile = validateAgentProfile({
  agent_kind: 'acp',
  name: 'codex-profile',
  acp_server: 'codex',
  acp_model: 'gpt-5.5',
});

const profileSelectedLlm = clearRawLlmFieldsWhenProfileSelected({
  profileId: 'daily-driver',
  provider: 'openai',
  model: 'ignored-when-profile-selected',
  temperature: 0.2,
});

console.log({
  defaultKind: defaultAgentSettings('daily-driver').agent_kind,
  openHandsToolCount: openHandsSettings.agent_kind === 'openhands' ? (openHandsSettings.tools?.length ?? 0) : 0,
  migratedDelegationSelected: migratedSettings.agent_kind === 'openhands' && migratedSettings.tools?.some(tool => tool.name === 'task_tool_set'),
  acpServer: acpProfile.agent_kind === 'acp' ? acpProfile.acp_server : null,
  rawModelCleared: profileSelectedLlm.model === undefined,
});
