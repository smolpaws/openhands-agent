import assert from 'node:assert/strict';

interface WireEntry { kind: 'call' | 'result' | 'user' | 'assistant'; id?: string; text?: string }

/** Plain assistant replies have no tool pair to establish causality; inspect their actual wire positions. */
export function assertPlainResponseWireOrder(body: unknown, reply: string, input: string): void {
  const entries = wireEntries(object(body));
  const responses = entries.flatMap((entry, index) => entry.kind === 'assistant' && entry.text === reply ? [index] : []);
  const arrivals = entries.flatMap((entry, index) => entry.kind === 'user' && entry.text?.includes(input) ? [index] : []);
  assert.ok(responses.length === 1 && arrivals.length === 1, 'plain response and concurrent user input must each appear once');
  assert.ok(responses[0]! < arrivals[0]!, 'unseen user input must follow the plain response that could not consume it');
}

/** Inspect the actual POST body, after native serialization, without retaining it in diagnostics. */
export function assertConcurrentWireOrder(body: unknown, callIds: readonly string[], input: string): void {
  assert.ok(callIds.length >= 2 && new Set(callIds).size === callIds.length, 'parallel proof requires distinct call IDs');
  const request = object(body);
  const responses = Array.isArray(request.input) && request.input.some(value => object(value).type === 'function_call_output');
  const ids = responses ? callIds.map(id => id.startsWith('call_') ? id : `call_${id.replace(/[^a-zA-Z0-9_-]/gu, '_')}`) : callIds;
  const entries = wireEntries(request);
  const arrival = entries.flatMap((entry, index) => entry.kind === 'user' && entry.text?.includes(input) ? [index] : []);
  assert.ok(arrival.length === 1, 'concurrent input must occur exactly once as user content in the actual request');
  const callIndices: number[] = [];
  const resultIndices: number[] = [];
  for (const id of ids) {
    const calls = entries.flatMap((entry, index) => entry.kind === 'call' && entry.id === id ? [index] : []);
    const results = entries.flatMap((entry, index) => entry.kind === 'result' && entry.id === id ? [index] : []);
    assert.ok(calls.length === 1 && results.length === 1, 'each actual parallel call needs exactly one matching wire result');
    callIndices.push(calls[0]!);
    resultIndices.push(results[0]!);
  }
  assert.ok(Math.max(...callIndices) < Math.min(...resultIndices), 'parallel requests must form one batch before their results');
  assert.ok(Math.max(...resultIndices) < arrival[0]!, 'all parallel results must precede the concurrent user input');
  const exchange = entries.slice(Math.min(...callIndices), Math.max(...resultIndices) + 1);
  assert.ok(exchange.every(entry => (entry.kind === 'call' || entry.kind === 'result') && ids.includes(entry.id ?? '')),
    'the parallel exchange cannot contain intervening input, assistant turns, or unrelated tools');
}

function wireEntries(body: Record<string, unknown>): WireEntry[] {
  if (Array.isArray(body.messages)) return body.messages.flatMap(value => {
    const message = object(value);
    if (message.role === 'tool') return [{ kind: 'result', id: string(message.tool_call_id) }];
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map(value => ({ kind: 'call' as const, id: string(object(value).id) })) : [];
    if (Array.isArray(message.content)) {
      const content = message.content.flatMap((value): WireEntry[] => {
        const block = object(value);
        if (block.type === 'tool_use') return [{ kind: 'call', id: string(block.id) }];
        if (block.type === 'tool_result') return [{ kind: 'result', id: string(block.tool_use_id) }];
        if (message.role === 'user' && typeof block.text === 'string') return [{ kind: 'user', text: block.text }];
        return [];
      });
      const result = [...content, ...calls];
      if (message.role === 'assistant' && !result.some(entry => entry.kind === 'call')) return [{ kind: 'assistant', text: contentText(message.content) }];
      return result;
    }
    if (message.role === 'user') return [{ kind: 'user', text: string(message.content) }];
    if (calls.length > 0) return calls;
    return message.role === 'assistant' ? [{ kind: 'assistant', text: string(message.content) }] : [];
  });
  assert.ok(Array.isArray(body.input), 'unsupported provider conversation request shape');
  return body.input.flatMap((value): WireEntry[] => {
    const item = object(value);
    if (item.type === 'function_call') return [{ kind: 'call', id: string(item.call_id ?? item.id) }];
    if (item.type === 'function_call_output' || item.type === 'function_result') return [{ kind: 'result', id: string(item.call_id) }];
    if (item.type === 'user_input' || item.role === 'user') return [{ kind: 'user', text: contentText(item.content) }];
    if (item.type === 'model_output' || item.role === 'assistant') return [{ kind: 'assistant', text: contentText(item.content) }];
    if (item.type === 'thought' || item.type === 'reasoning') return [{ kind: 'assistant' }];
    return [];
  });
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function contentText(value: unknown): string {
  return Array.isArray(value) ? value.map(part => string(object(part).text)).filter(text => text.length > 0).join('\n') : string(value);
}
