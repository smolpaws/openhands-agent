import { z } from 'zod';

import { AgentResetCondenser } from '../context/agent-reset-condenser.js';
import { NoOpCondenser, type Condenser } from '../context/condenser.js';
import { contextWarningThresholdsSchema, DEFAULT_CONTEXT_WARNING_THRESHOLDS } from '../context/context-warnings.js';
import { LLMSummarizingCondenser } from '../context/llm-summarizing-condenser.js';
import type { LLMClient } from '../llm/client.js';

const profileReferenceSchema = z.string().trim().min(1);

export const llmSummarizingCondenserSettingsSchema = z.object({
  condenser_kind: z.literal('llm_summarizing').default('llm_summarizing'),
  enabled: z.boolean().default(true),
  llm_profile_ref: profileReferenceSchema.optional(),
  // DEV-SDK-011: align omitted settings with the class and standard factory.
  max_size: z.number().int().min(20).default(1000),
  // Absence inherits the agent limit at materialization; explicit null does not.
  max_tokens: z.number().int().positive().nullable().optional(),
  keep_first: z.number().int().nonnegative().default(2),
  minimum_progress: z.number().gt(0).lt(1).default(0.1),
  hard_context_reset_max_retries: z.number().int().positive().default(5),
  hard_context_reset_context_scaling: z.number().gt(0).lt(1).default(0.8),
}).strict();

export const noOpCondenserSettingsSchema = z.object({
  condenser_kind: z.literal('no_op'),
  enabled: z.boolean().default(true),
}).strict();

export const agentResetCondenserSettingsSchema = z.object({
  condenser_kind: z.literal('agent_reset'),
  enabled: z.boolean().default(true),
  warning_thresholds: contextWarningThresholdsSchema.default(() => [...DEFAULT_CONTEXT_WARNING_THRESHOLDS]),
}).strict();

/** Full-view error recovery has no ordinary token/event trigger or retained-prefix settings. */
export const hardCondenserSettingsSchema = z.object({
  condenser_kind: z.literal('llm_summarizing'),
  llm_profile_ref: profileReferenceSchema,
  hard_context_reset_max_retries: z.number().int().positive().default(5),
  hard_context_reset_context_scaling: z.number().gt(0).lt(1).default(0.8),
}).strict();

export const condenserSettingsSchema = z.preprocess((value) => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
    'condenser_kind' in value && value.condenser_kind === 'noop') {
    return { ...value, condenser_kind: 'no_op' };
  }
  return value;
}, z.union([llmSummarizingCondenserSettingsSchema, noOpCondenserSettingsSchema, agentResetCondenserSettingsSchema]));

export type LLMSummarizingCondenserSettings = z.infer<typeof llmSummarizingCondenserSettingsSchema>;
export type NoOpCondenserSettings = z.infer<typeof noOpCondenserSettingsSchema>;
export type AgentResetCondenserSettings = z.infer<typeof agentResetCondenserSettingsSchema>;
export type HardCondenserSettings = z.infer<typeof hardCondenserSettingsSchema>;
export type CondenserSettings = z.infer<typeof condenserSettingsSchema>;

export interface MaterializeCondenserOptions {
  /** Resolve a saved condenser profile using the host's profile and secret stores. */
  readonly resolveClient: (profileRef: string) => LLMClient | Promise<LLMClient>;
  /** Explicit host selection used only when the saved settings omit a profile. */
  readonly defaultProfileRef?: string;
  /** Used only to inherit the input-token limit, never as the summarizing client. */
  readonly agentLlm?: LLMClient | null;
}

/** Materialize profile-first condenser settings without choosing a store or a main-LLM fallback. */
export async function materializeCondenser(
  data: unknown,
  options: MaterializeCondenserOptions,
): Promise<Condenser | null> {
  const settings = condenserSettingsSchema.parse(data);
  if (!settings.enabled) return null;
  if (settings.condenser_kind === 'no_op') return new NoOpCondenser();
  if (settings.condenser_kind === 'agent_reset') return new AgentResetCondenser({ warningThresholds: settings.warning_thresholds });
  if (Math.floor(settings.max_size / 2) - settings.keep_first - 1 <= 0) {
    throw new RangeError('keep_first must be less than max_size // 2 to leave room for condensation');
  }

  const selectedRef = settings.llm_profile_ref ?? options.defaultProfileRef;
  if (selectedRef === undefined) {
    throw new Error('Enabled LLM condenser requires llm_profile_ref or an explicit host defaultProfileRef.');
  }
  const profileRef = profileReferenceSchema.parse(selectedRef);
  const llm = await options.resolveClient(profileRef);
  let maxTokens = settings.max_tokens;
  if (maxTokens === undefined) {
    await options.agentLlm?.resolveRuntimeMetadata?.();
    maxTokens = options.agentLlm?.effectiveMaxInputTokens ?? null;
  }
  return new LLMSummarizingCondenser({
    llm,
    maxSize: settings.max_size,
    maxTokens,
    keepFirst: settings.keep_first,
    minimumProgress: settings.minimum_progress,
    hardContextResetMaxRetries: settings.hard_context_reset_max_retries,
    hardContextResetContextScaling: settings.hard_context_reset_context_scaling,
  });
}

/** Materialize the separate emergency fallback; hosts invoke hardContextReset only after an actual provider context error. */
export async function materializeHardCondenser(
  data: unknown,
  options: MaterializeCondenserOptions,
): Promise<LLMSummarizingCondenser | null> {
  if (data === undefined || data === null) return null;
  const settings = hardCondenserSettingsSchema.parse(data);
  const llm = await options.resolveClient(settings.llm_profile_ref);
  return new LLMSummarizingCondenser({
    llm,
    // The fallback never inherits a proactive main-model token trigger.
    maxTokens: null,
    hardContextResetMaxRetries: settings.hard_context_reset_max_retries,
    hardContextResetContextScaling: settings.hard_context_reset_context_scaling,
  });
}
