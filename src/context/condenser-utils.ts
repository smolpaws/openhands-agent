/** PORT: context/condenser/utils.py. Counts are supplied by the agent's provider boundary. */
import { eventsToMessages, type LLMConvertibleEvent } from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import type { CondenserContext } from './condenser.js';

export async function getTotalTokenCount(events: readonly LLMConvertibleEvent[], llm: LLMClient, context?: CondenserContext): Promise<number | null> {
  if (!llm.getTokenCount) return null;
  const messages = context?.messagesForEvents?.(events) ?? eventsToMessages(events);
  const storedTools = events.find(event => event.kind === 'SystemPromptEvent')?.tools;
  const tools = context?.tools ?? (storedTools?.length ? storedTools : undefined);
  const count = await llm.getTokenCount(messages, tools);
  if (count === null) return null;
  if (!Number.isFinite(count) || count < 0) throw new RangeError('Invalid provider token count');
  return count;
}

export async function getShortestPrefixAboveTokenCount(
  events: readonly LLMConvertibleEvent[], llm: LLMClient, tokenCount: number,
  baseEvents: readonly LLMConvertibleEvent[] = [], context?: CondenserContext,
): Promise<number | null> {
  if (events.length === 0) return 0;
  // Host projections may prepend fixed context even to an empty event list.
  const baseTokens = baseEvents.length > 0 || context?.messagesForEvents !== undefined
    ? await getTotalTokenCount(baseEvents, llm, context) : 0;
  if (baseTokens === null) return null;
  const total = await getTotalTokenCount([...baseEvents, ...events], llm, context);
  if (total === null) return null;
  if (total - baseTokens <= tokenCount) return events.length;
  let left = 1, right = events.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const prefix = await getTotalTokenCount([...baseEvents, ...events.slice(0, mid)], llm, context);
    if (prefix === null) return null;
    if (prefix - baseTokens > tokenCount) right = mid;
    else left = mid + 1;
  }
  return left;
}

export async function getSuffixLengthForTokenReduction(
  events: readonly LLMConvertibleEvent[], llm: LLMClient, tokenReduction: number,
  baseEvents: readonly LLMConvertibleEvent[] = [], context?: CondenserContext,
): Promise<number | null> {
  if (events.length === 0) return 0;
  if (tokenReduction <= 0) return events.length;
  const prefix = await getShortestPrefixAboveTokenCount(events, llm, tokenReduction, baseEvents, context);
  return prefix === null ? null : events.length - prefix;
}
