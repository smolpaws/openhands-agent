import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { dropRetiredToolSwitches, foldRetiredToolSwitches } from '../tool/defaults.js';
import { persistedToolSpecsSchema } from '../tool/spec-validation.js';
import { condenserSettingsSchema, hardCondenserSettingsSchema } from '../settings/condenser-settings.js';

export const AGENT_PROFILE_SCHEMA_VERSION = 4;

// Pydantic's summary integer accepts booleans and decimal integer strings, but
// not Number()'s hex/exponent/empty-string coercions. Keep stored profiles strict.
const summaryRevisionSchema = z.preprocess(value => {
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'string') {
    const normalized = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
    if (/^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$/u.test(normalized)) {
      value = Number(normalized.replaceAll('_', ''));
    }
  }
  return Object.is(value, -0) ? 0 : value;
}, z.number().int()).nullable().default(null);

/** Stored-profile summary; parsing does not resolve references or instantiate an agent. */
export const agentProfileInfoSchema = z.object({
  id: z.string().nullable().default(null),
  name: z.string(),
  agent_kind: z.string().default('openhands'),
  revision: summaryRevisionSchema,
  llm_profile_ref: z.string().nullable().default(null),
  mcp_server_refs: z.array(z.string()).nullable().default(null),
});

export const agentProfileListResponseSchema = z.object({
  profiles: z.array(agentProfileInfoSchema),
  active_agent_profile_id: z.string().nullable().default(null),
});

export type AgentProfileInfo = z.infer<typeof agentProfileInfoSchema>;
export type AgentProfileListResponse = z.infer<typeof agentProfileListResponseSchema>;

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
  secret_refs: z.array(z.string()).nullable().default(null),
} as const;

const openHandsAgentProfileObjectSchema = z
  .object({
    ...agentProfileBaseFields,
    agent_kind: z.literal('openhands').default('openhands'),
    llm_profile_ref: z.string().min(1),
    agent: z.string().default('CodeActAgent'),
    tools: persistedToolSpecsSchema.nullable().default(null),
    persona: z.string().min(1).max(65536).nullable().default(null),
    system_message_suffix: z.string().nullable().default(null),
    disabled_skills: z.array(z.string()).default([]),
    public_skills: z.array(z.string()).nullable().default(null),
    condenser: z.unknown().default({ condenser_kind: 'llm_summarizing', enabled: true }),
    hard_condenser: hardCondenserSettingsSchema.nullable().optional(),
    verification: profileVerificationSettingsSchema.default(defaultProfileVerificationSettings),
    enable_classify_and_switch_llm_tool: z.boolean().default(false),
    meta_profile_ref: z.string().min(1).nullable().default(null),
    tool_concurrency_limit: z.number().int().min(1).default(1),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.hard_condenser === undefined || profile.hard_condenser === null) return;
    const condenser = condenserSettingsSchema.safeParse(profile.condenser);
    if (!condenser.success || condenser.data.condenser_kind !== 'agent_reset' || !condenser.data.enabled) {
      context.addIssue({ code: 'custom', path: ['hard_condenser'], message: 'hard_condenser requires an enabled agent_reset condenser' });
    }
  });

function rejectRemovedToolSwitches(data: unknown): unknown {
  if (isRecord(data) && ('enable_sub_agents' in data || 'enable_switch_llm_tool' in data)) {
    throw new Error('Retired tool switches were removed; select tools instead.');
  }
  return data;
}

export const openHandsAgentProfileSchema = z.preprocess(rejectRemovedToolSwitches, openHandsAgentProfileObjectSchema);

export const acpAgentProfileSchema = z
  .object({
    ...agentProfileBaseFields,
    agent_kind: z.literal('acp').default('acp'),
    acp_server: acpServerKindSchema.default('claude-code'),
    acp_model: z.string().nullable().default(null),
    acp_session_mode: z.string().nullable().default(null),
    acp_prompt_timeout: z.number().positive().default(1800),
    acp_startup_timeout: z.number().positive().default(90),
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

  let migrated = { ...data };
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
  if (version === 0) throw new Error('No migration registered for AgentProfile schema_version 0.');
  if (version > AGENT_PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `AgentProfile schema_version ${version} is newer than supported version ${AGENT_PROFILE_SCHEMA_VERSION}.`,
    );
  }
  // v1 -> v2 (upstream #4030): the shipped default profile recorded `tools: []`
  // explicitly; from v2 that tri-state collapses to `null` (SDK default).
  if (version === 1) {
    if (
      (migrated.agent_kind ?? 'openhands') === 'openhands'
      && migrated.name === 'default'
      && (migrated.revision ?? 0) === 0
      && Array.isArray(migrated.tools)
      && migrated.tools.length === 0
    ) {
      migrated.tools = null;
    }
    migrated.schema_version = 2;
  }
  if (version < 3) {
    if ((migrated.agent_kind ?? 'openhands') === 'openhands') migrated = foldRetiredToolSwitches(migrated);
    else { delete migrated.enable_sub_agents; delete migrated.enable_switch_llm_tool; }
  } else if (version === 3) {
    migrated = dropRetiredToolSwitches(migrated);
  }
  migrated.schema_version = AGENT_PROFILE_SCHEMA_VERSION;
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
