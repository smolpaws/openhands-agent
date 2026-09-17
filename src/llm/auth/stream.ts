import { providerResponseError } from '../exceptions.js';
import type { FetchResponseLike } from '../client.js';

/** Codex requires SSE even when callers want one completed SDK response. */
export async function readSubscriptionResponse(response: FetchResponseLike, onTerminalResponse?: (response: unknown) => void): Promise<unknown> {
  const reader = response.body?.getReader();
  let pending = '';
  const outputItems: unknown[] = [];
  const decode = new TextDecoder();
  const consume = (frame: string): unknown => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return undefined;
    let event: {
      type?: string;
      response?: { output?: unknown[]; error?: unknown; incomplete_details?: unknown };
      error?: unknown;
      item?: unknown;
    };
    try {
      event = JSON.parse(data) as typeof event;
    } catch {
      throw new Error('Invalid OpenAI subscription stream event');
    }
    if (event.type === 'response.output_item.done' && event.item !== undefined) outputItems.push(event.item);
    if (event.response && ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type ?? ''))
      onTerminalResponse?.(event.response);
    if (event.type === 'response.completed') {
      if (!event.response) throw new Error('Invalid OpenAI subscription completed response');
      return event.response.output?.length ? event.response : { ...event.response, output: outputItems };
    }
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete')
      throw providerResponseError('OpenAI subscription', 200, event.response?.error ?? event.error ?? event);
    return undefined;
  };
  try {
    do {
      const chunk = reader ? await reader.read() : { done: true, value: undefined };
      pending += reader ? decode.decode(chunk.value, { stream: !chunk.done }) : await response.text();
      pending = pending.replace(/\r\n/gu, '\n');
      let end: number;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const result = consume(frame);
        if (result !== undefined) return result;
      }
      if (chunk.done) {
        const result = consume(pending);
        if (result !== undefined) return result;
        break;
      }
    } while (reader);
    throw new Error('OpenAI subscription stream ended without a completed response');
  } finally {
    await reader?.cancel();
  }
}
