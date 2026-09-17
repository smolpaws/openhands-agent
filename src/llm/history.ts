import type { ConversationState } from '../conversation/state.js';
import { conversationStateUpdateEventSchema, type Event, type LLMConvertibleEvent } from '../event/index.js';
import type { Content, LLMProfile } from './index.js';
import { LLM_USAGE_KEY, llmHistoryOrigin } from './metrics.js';

export const LLM_HISTORY_ORIGIN_KEY = 'llm_history_origin';

/** Call under the conversation's step-boundary guard, before committing a replacement binding. */
export async function ensureLlmHistoryOrigin(state: ConversationState, profile: LLMProfile): Promise<void> {
  if (legacyOrigin(state.events) !== null) return;
  await state.appendEventAsync(conversationStateUpdateEventSchema.parse({
    key: LLM_HISTORY_ORIGIN_KEY, value: { version: 1, origin: llmHistoryOrigin(profile) },
  }));
}

/** Project copies for the selected LLM. The EventLog remains an unmodified record of each response. */
export function historyForProfile(
  view: readonly LLMConvertibleEvent[], history: readonly Event[], profile: LLMProfile, legacyProfile?: LLMProfile,
): LLMConvertibleEvent[] {
  if (!view.some(event => event.kind === 'ActionEvent'
    ? event.thinking_blocks.length > 0 || event.responses_reasoning_item !== null
    : event.kind === 'MessageEvent' && (event.llm_message.thinking_blocks.length > 0 || event.llm_message.responses_reasoning_item !== null))) return [...view];
  const current = llmHistoryOrigin(profile);
  // Auxiliary completions know the main binding that owns unanchored legacy history.
  const legacy = legacyOrigin(history) ?? (legacyProfile === undefined ? null : llmHistoryOrigin(legacyProfile));
  const legacyMatches = legacy === null || legacy === current;
  const responses = new Map<string, boolean>();
  const compatible = new Map<string, boolean>();
  let anchored = false;
  for (const event of history) {
    if (event.kind === 'ConversationStateUpdateEvent' && event.key === LLM_HISTORY_ORIGIN_KEY) {
      anchored = true;
    } else if (event.kind === 'ConversationStateUpdateEvent' && event.key === LLM_USAGE_KEY && record(event.value)) {
      const usage = event.value;
      const responseId = typeof usage.response_id === 'string' ? usage.response_id : event.id;
      // Old accounting knows the provider/profile/model but not the endpoint. Only the original
      // persisted binding can vouch for those records; different known origins fail closed.
      const sameProfile = usage.profile_id === profile.profileId && usage.provider_id === profile.providerId && usage.requested_model === profile.model;
      const matches = sameProfile && (usage.history_origin !== undefined ? usage.history_origin === current : legacyMatches && !anchored);
      responses.set(responseId, matches);
    } else if (event.kind === 'ActionEvent' || event.kind === 'MessageEvent') {
      // Resolve as encountered, not from a final response-id map: providers may repeat their IDs.
      const unknownMatches = legacyMatches && !anchored;
      compatible.set(event.id, event.llm_response_id === null ? unknownMatches : responses.get(event.llm_response_id) ?? unknownMatches);
    }
  }
  return view.flatMap((event): LLMConvertibleEvent[] => {
    if (compatible.get(event.id) ?? legacyMatches) return [event];
    if (event.kind === 'ActionEvent') return [{ ...event, thinking_blocks: [], responses_reasoning_item: null }];
    if (event.kind !== 'MessageEvent' || event.llm_message.role !== 'assistant') return [event];
    const message = event.llm_message;
    // A reasoning-only turn cannot become an empty assistant turn in native provider payloads.
    if (!hasVisibleContent(message.content) && !hasVisibleContent(event.extended_content) && !message.tool_calls?.length
      && (message.thinking_blocks.length > 0 || message.responses_reasoning_item !== null)) return [];
    return [{ ...event, llm_message: { ...message, thinking_blocks: [], responses_reasoning_item: null } }];
  });
}

function hasVisibleContent(content: readonly Content[]): boolean {
  return content.some(item => item.type !== 'text' || item.text.trim().length > 0);
}

function legacyOrigin(events: readonly Event[]): string | null {
  let result: string | null = null;
  for (const event of events) {
    if (event.kind !== 'ConversationStateUpdateEvent' || event.key !== LLM_HISTORY_ORIGIN_KEY) continue;
    if (!record(event.value) || event.value.version !== 1 || typeof event.value.origin !== 'string'
      || !/^[a-f0-9]{64}$/u.test(event.value.origin) || result !== null && result !== event.value.origin) {
      throw new Error('Invalid LLM history origin');
    }
    result = event.value.origin;
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
