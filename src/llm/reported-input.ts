import type { Event } from '../event/index.js';
import type { LLMProfile } from './index.js';
import { llmHistoryOrigin, readLlmUsageEvent, type UsageRecord } from './metrics.js';
import { LLM_REQUEST_BOUNDARY_KEY } from './request-history.js';

/** Latest successful main request in the current reset generation and binding.
 * Undefined: no such request, so a first-request estimate may be used.
 * Null: that response omitted input usage; do not invent a value or reuse an older count.
 */
export function latestReportedInputTokens(history: readonly Event[], profile: LLMProfile, usageId?: string): number | null | undefined {
  const origin = llmHistoryOrigin(profile);
  const mainUsageId = usageId ?? `profile:${profile.profileId}`;
  let latest: number | null | undefined;
  let legacy: UsageRecord | null = null;
  for (const event of history) {
    if (event.kind === 'Condensation') { latest = undefined; legacy = null; continue; }
    const record = readLlmUsageEvent(event);
    if (record !== null) {
      if (record.usage_id !== mainUsageId || record.profile_id !== profile.profileId
        || record.provider_id !== profile.providerId || record.requested_model !== profile.model
        || record.history_origin !== undefined && record.history_origin !== origin) continue;
      legacy = null;
      if (record.request_succeeded === true) latest = record.usage?.promptTokens ?? null;
      else if (record.request_succeeded === undefined) legacy = record;
    } else if (event.kind === 'ConversationStateUpdateEvent' && event.key === LLM_REQUEST_BOUNDARY_KEY && legacy !== null) {
      // Older accounting predates success metadata; its completed request boundary
      // distinguishes a returned response from an accounted provider failure.
      latest = legacy.usage?.promptTokens ?? null;
      legacy = null;
    }
  }
  return latest;
}
