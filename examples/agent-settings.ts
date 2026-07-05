import {
  clearRawLlmFieldsWhenProfileSelected,
  defaultAgentSettings,
  validateAgentProfile,
  validateAgentSettings,
} from '@smolpaws/openhands-agent';

const openHandsSettings = validateAgentSettings({
  llm_profile_ref: 'daily-driver',
  tools: [{ name: 'TerminalTool' }],
  enable_sub_agents: true,
});

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
  openHandsToolCount: openHandsSettings.agent_kind === 'openhands' ? openHandsSettings.tools.length : 0,
  acpServer: acpProfile.agent_kind === 'acp' ? acpProfile.acp_server : null,
  rawModelCleared: profileSelectedLlm.model === undefined,
});
