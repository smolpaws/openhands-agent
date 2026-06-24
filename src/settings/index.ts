import { z } from 'zod';

import {
  acpServerKindSchema,
  profileVerificationSettingsSchema,
  type ProfileVerificationSettings,
} from '../profiles/index.js';

export const AGENT_SETTINGS_SCHEMA_VERSION = 4;
export const CONVERSATION_SETTINGS_SCHEMA_VERSION = 1;

const settingsSchemaVersion = (version: number) => z.literal(version).default(version);

export const observabilityMetadataSchema = z.record(z.string().min(1), z.unknown());
export const observabilityTagsSchema = z.array(z.string());

export const conversationSettingsSchema = z
  .object({
    schema_version: settingsSchemaVersion(CONVERSATION_SETTINGS_SCHEMA_VERSION),
    max_iterations: z.number().int().min(1).default(500),
    observability_metadata: observabilityMetadataSchema.nullable().default(null),
    observability_tags: observabilityTagsSchema.nullable().default(null),
  })
  .strict();

const agentSettingsBaseFields = {
  schema_version: settingsSchemaVersion(AGENT_SETTINGS_SCHEMA_VERSION),
  mcp_config: z.unknown().nullable().default(null),
} as const;

const defaultVerificationSettings: ProfileVerificationSettings = profileVerificationSettingsSchema.parse({});

export const openHandsAgentSettingsSchema = z
  .object({
    ...agentSettingsBaseFields,
    agent_kind: z.literal('openhands').default('openhands'),
    llm_profile_ref: z.string().min(1),
    agent: z.string().default('CodeActAgent'),
    tools: z.array(z.unknown()).default([]),
    enable_sub_agents: z.boolean().default(false),
    enable_switch_llm_tool: z.boolean().default(true),
    tool_concurrency_limit: z.number().int().min(1).default(1),
    condenser: z.unknown().default({ condenser_kind: 'llm_summarizing', enabled: true }),
    verification: profileVerificationSettingsSchema.default(defaultVerificationSettings),
  })
  .strict();

export const acpAgentSettingsSchema = z
  .object({
    ...agentSettingsBaseFields,
    agent_kind: z.literal('acp').default('acp'),
    acp_server: acpServerKindSchema.default('claude-code'),
    acp_command: z.array(z.string()).default([]),
    acp_args: z.array(z.string()).default([]),
    acp_model: z.string().nullable().default(null),
    acp_session_mode: z.string().nullable().default(null),
    acp_prompt_timeout: z.number().positive().default(1800),
  })
  .strict();

export const agentSettingsSchema = z.union([openHandsAgentSettingsSchema, acpAgentSettingsSchema]);

export type ConversationSettings = z.infer<typeof conversationSettingsSchema>;
export type OpenHandsAgentSettings = z.infer<typeof openHandsAgentSettingsSchema>;
export type ACPAgentSettings = z.infer<typeof acpAgentSettingsSchema>;
export type AgentSettings = OpenHandsAgentSettings | ACPAgentSettings;

export function validateAgentSettings(data: unknown): AgentSettings {
  const payload = applySettingsVersion(data, AGENT_SETTINGS_SCHEMA_VERSION, 'AgentSettings');
  const kind = payload.agent_kind ?? 'openhands';
  if (kind === 'acp') {
    return acpAgentSettingsSchema.parse(payload);
  }
  if (kind === 'llm' || kind === 'openhands') {
    return openHandsAgentSettingsSchema.parse({ ...payload, agent_kind: 'openhands' });
  }
  const renderedKind = typeof kind === 'string' ? kind : JSON.stringify(kind);
  throw new Error(`Unknown agent_kind: ${renderedKind ?? '<unserializable>'}`);
}

export function validateConversationSettings(data: unknown): ConversationSettings {
  return conversationSettingsSchema.parse(
    applySettingsVersion(data, CONVERSATION_SETTINGS_SCHEMA_VERSION, 'ConversationSettings'),
  );
}

export function defaultAgentSettings(llmProfileRef: string): OpenHandsAgentSettings {
  return openHandsAgentSettingsSchema.parse({ llm_profile_ref: llmProfileRef });
}

function applySettingsVersion(data: unknown, currentVersion: number, payloadName: string): Record<string, unknown> {
  if (!isRecord(data)) {
    throw new TypeError(`${payloadName} payload must be a mapping.`);
  }
  const migrated = { ...data };
  const version = migrated.schema_version;
  if (version === undefined || version === null) {
    migrated.schema_version = currentVersion;
    return migrated;
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new TypeError(`${payloadName} schema_version must be an integer, got ${typeof version}.`);
  }
  if (version < 0) {
    throw new Error(`${payloadName} schema_version must be non-negative.`);
  }
  if (version > currentVersion) {
    throw new Error(`${payloadName} schema_version ${version} is newer than supported version ${currentVersion}.`);
  }
  migrated.schema_version = currentVersion;
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
