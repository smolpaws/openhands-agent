import { z } from 'zod';

import {
  conversationStateUpdateEventSchema,
  messageEventSchema,
  type ConversationStateUpdateEvent,
  type Event,
  type MessageEvent,
} from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import { textContent } from '../llm/index.js';
import type { CondenserContext } from './condenser.js';
import { getTotalTokenCount } from './condenser-utils.js';
import type { View } from './view.js';

export const DEFAULT_CONTEXT_WARNING_THRESHOLDS = Object.freeze([0.75, 0.80, 0.85, 0.90]);

const thresholdSchema = z.number().positive().max(1);
export const contextWarningThresholdsSchema = z.array(thresholdSchema).min(1).refine(
  values => values.every((value, index) => index === 0 || value > values[index - 1]!),
  'Context warning thresholds must be strictly ascending and unique',
);

const WARNING_KEY = 'agent_context_warning';
const warningStateSchema = z.object({
  version: z.literal(1),
  // EventLog omits null model fields, so absence also denotes the initial generation.
  generation: z.string().min(1).nullable().default(null),
  threshold: thresholdSchema,
  input_tokens: z.number().finite().nonnegative(),
  input_limit: z.number().finite().positive(),
}).strict();
type WarningState = z.infer<typeof warningStateSchema>;

function warningState(event: Event): WarningState | null {
  if (event.kind !== 'ConversationStateUpdateEvent' || event.key !== WARNING_KEY) return null;
  const result = warningStateSchema.safeParse(event.value);
  if (!result.success) throw new Error('Invalid agent context warning state', { cause: result.error });
  return result.data;
}

/** Advisory, target-only state. Only an appended Condensation starts a new warning cycle. */
export async function contextWarningEvent(
  history: readonly Event[], view: View, llm: LLMClient,
  thresholds: readonly number[], context?: CondenserContext,
): Promise<ConversationStateUpdateEvent | null> {
  const levels = contextWarningThresholdsSchema.parse(thresholds);
  let generation: string | null = null;
  for (const event of history) if (event.kind === 'Condensation') generation = event.id;
  let highestWarned = 0;
  for (const event of history) {
    const state = warningState(event);
    if (state?.generation === generation) highestWarned = Math.max(highestWarned, state.threshold);
  }

  // The selected main profile is authoritative even for custom clients whose
  // effective-limit getter has not yet learned about the explicit override.
  if (llm.profile.maxInputTokens === null) await llm.resolveRuntimeMetadata?.();
  const inputLimit = llm.profile.maxInputTokens ?? llm.effectiveMaxInputTokens ?? null;
  if (inputLimit === null) return null;
  if (!Number.isFinite(inputLimit) || inputLimit <= 0) throw new RangeError('Invalid provider input-token limit');
  const inputTokens = await getTotalTokenCount(view.events, llm, context);
  if (inputTokens === null) return null;
  const highestPassed = levels.filter(threshold => inputTokens / inputLimit >= threshold).at(-1);
  if (highestPassed === undefined || highestPassed <= highestWarned) return null;
  return conversationStateUpdateEventSchema.parse({
    key: WARNING_KEY,
    value: { version: 1, generation, threshold: highestPassed, input_tokens: inputTokens, input_limit: inputLimit },
  });
}

/** Rebuild the same model-visible message from its single durable warning marker. */
export function contextWarningMessage(event: Event): MessageEvent | null {
  const state = warningState(event);
  if (state === null) return null;
  const thresholdPercent = Math.round(state.threshold * 10_000) / 100;
  return messageEventSchema.parse({
    id: `${event.id}-message`, timestamp: event.timestamp, source: 'environment',
    llm_message: {
      role: 'user',
      content: [textContent(
        `Context warning: the ${thresholdPercent}% input-budget threshold has been reached ` +
        `(${state.input_tokens} input tokens / ${state.input_limit} input-token budget). ` +
        'This is advisory; you decide when to condense. Save useful state in your notes, ' +
        'then call condense when you are ready, with any message you want your future self to receive.',
      )],
    },
  });
}
