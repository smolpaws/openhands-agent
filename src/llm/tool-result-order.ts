import type { Message } from './index.js';

/**
 * A user can speak while a tool is running. Keep that durable chronology intact,
 * but send completed call/result groups atomically to provider APIs. Only plain
 * user messages may move, and only when every result in this batch is present.
 * Missing/duplicate/unrelated results and later assistant turns are not repaired.
 */
export function orderCompletedToolResults(messages: readonly Message[]): Message[] {
  const ordered: Message[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message === undefined) continue;
    ordered.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const pending = new Set(message.tool_calls.map(call => call.id));
    if (pending.size !== message.tool_calls.length) continue;
    const results: Message[] = [];
    const users: Message[] = [];
    let j = i + 1;
    for (; j < messages.length && pending.size > 0; j += 1) {
      const next = messages[j];
      if (next?.role === 'tool' && next.tool_call_id && pending.delete(next.tool_call_id)) {
        results.push(next);
      } else if (next?.role === 'user' && !next.tool_calls && !next.tool_call_id && !next.name) {
        users.push(next);
      } else break;
    }
    if (pending.size === 0) {
      ordered.push(...results, ...users);
      i = j - 1;
    }
  }
  return ordered;
}
