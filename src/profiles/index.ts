import { randomUUID } from 'node:crypto';

import { z } from 'zod';

export const AGENT_PROFILE_SCHEMA_VERSION = 1;

export const acpServerKindSchema = z.union([
  z.literal('claude-code'),
  z.literal('codex'),
  z.literal('gemini-cli'),
  z.literal('custom'),
]);

export const criticModeSchema = z.union([z.literal('finish_and_message'), z.literal('all_actions')]);

export const profileVerificationSettingsSchema = z.object({
  critic_enabled: z.boolean().default(false),
  critic_mode: criticModeSchema.default('finish_and_message'),
  enable_iterative_refinement: z.boolean().default(false),
  critic_threshold: z.number().min(0).max(1).default(0.6),
  max_refinement_iterations: z.number().int().min(1).default(3),
  critic_server_url: z.string().nullable().default(null),
  critic_model_name: z.string().nullable().default(null),
});

const defaultProfileVerificationSettings = profileVerificationSettingsSchema.parse({});

const agentProfileBaseFields = {
  schema_version: z.literal(AGENT_PROFILE_SCHEMA_VERSION).default(AGENT_PROFILE_SCHEMA_VERSION),
  id: z.string().uuid().default(() => randomUUID()),
  name: z.string().min(1),
  revision: z.number().int().min(0).default(0),
  mcp_server_refs: z.array(z.string()).nullable().default(null),
} as const;

export const openHandsAgentProfileSchema = z
  .object({
    ...agentProfileBaseFields,
    agent_kind: z.literal('openhands').default('openhands'),
    llm_profile_ref: z.string().min(1),
    agent: z.string().default('CodeActAgent'),
    skills: z.array(z.unknown()).default([]),
    system_message_suffix: z.string().nullable().default(null),
    condenser: z.unknown().default({ condenser_kind: 'llm_summarizing', enabled: true }),
    verification: profileVerificationSettingsSchema.default(defaultProfileVerificationSettings),
    enable_sub_agents: z.boolean().default(false),
    tool_concurrency_limit: z.number().int().min(1).default(1),
  })
  .strict();

export const acpAgentProfileSchema = z
  .object({
    ...agentProfileBaseFields,
    agent_kind: z.literal('acp').default('acp'),
    acp_server: acpServerKindSchema.default('claude-code'),
    acp_model: z.string().nullable().default(null),
    acp_session_mode: z.string().nullable().default(null),
    acp_prompt_timeout: z.number().positive().default(1800),
    acp_command: z.string().nullable().default(null),
    acp_args: z.array(z.string()).nullable().default(null),
  })
  .strict();

export const agentProfileSchema = z.union([openHandsAgentProfileSchema, acpAgentProfileSchema]);

export type ACPServerKind = z.infer<typeof acpServerKindSchema>;
export type CriticMode = z.infer<typeof criticModeSchema>;
export type ProfileVerificationSettings = z.infer<typeof profileVerificationSettingsSchema>;
export type OpenHandsAgentProfile = z.infer<typeof openHandsAgentProfileSchema>;
export type ACPAgentProfile = z.infer<typeof acpAgentProfileSchema>;
export type AgentProfile = OpenHandsAgentProfile | ACPAgentProfile;

export function validateAgentProfile(data: unknown): AgentProfile {
  const payload = applyAgentProfileMigrations(data);
  const kind = payload.agent_kind ?? 'openhands';
  if (kind === 'acp') {
    return acpAgentProfileSchema.parse(payload);
  }
  if (kind === 'openhands') {
    return openHandsAgentProfileSchema.parse({ ...payload, agent_kind: 'openhands' });
  }
  const renderedKind = typeof kind === 'string' ? kind : JSON.stringify(kind);
  throw new Error(`Unknown agent_kind: ${renderedKind ?? '<unserializable>'}`);
}

function applyAgentProfileMigrations(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) {
    throw new TypeError('AgentProfile payload must be a mapping.');
  }

  const migrated = { ...data };
  const version = migrated.schema_version;
  if (version === undefined || version === null) {
    migrated.schema_version = AGENT_PROFILE_SCHEMA_VERSION;
    return migrated;
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || Object.is(version, -0)) {
    throw new TypeError(`AgentProfile schema_version must be an integer, got ${typeof version}.`);
  }
  if (version < 0) {
    throw new Error('AgentProfile schema_version must be non-negative.');
  }
  if (version > AGENT_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `AgentProfile schema_version ${version} is newer than supported version ${AGENT_PROFILE_SCHEMA_VERSION}.`,
    );
  }
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
