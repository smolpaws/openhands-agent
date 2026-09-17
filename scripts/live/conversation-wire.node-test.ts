import assert from 'node:assert/strict';
import test from 'node:test';
import { assertConcurrentWireOrder, assertPlainResponseWireOrder } from './conversation-wire.js';

const injected = 'finish with a finish tool call';
const calls = ['first', 'second'];

test('wire oracle accepts native Chat, Responses, Anthropic, and Gemini completed batches', () => {
  for (const body of bodies()) assertConcurrentWireOrder(body, calls, injected);
});

test('wire oracle rejects input before any or all completed results in every native format', () => {
  for (const original of bodies()) {
    for (let position = 0; position < (original.messages ?? original.input)!.length - 1; position += 1) {
      const body = structuredClone(original);
      const sequence = (body.messages ?? body.input)!;
      const user = sequence.pop()!;
      sequence.splice(position, 0, user);
      assert.throws(() => assertConcurrentWireOrder(body, calls, injected));
    }
  }
});

test('plain response wire oracle rejects a late user arrival appearing before its unseen response', () => {
  for (const original of [
    { messages: [{ role: 'assistant', content: 'PLAIN-REPLY' }, { role: 'user', content: 'late-input' }] },
    { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'PLAIN-REPLY' }] }, { role: 'user', content: [{ type: 'text', text: 'late-input' }] }] },
    { input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PLAIN-REPLY' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'late-input' }] }] },
    { input: [{ type: 'model_output', content: [{ type: 'text', text: 'PLAIN-REPLY' }] }, { type: 'user_input', content: [{ type: 'text', text: 'late-input' }] }] },
  ]) {
    assertPlainResponseWireOrder(original, 'PLAIN-REPLY', 'late-input');
    const wrong = structuredClone(original);
    (wrong.messages ?? wrong.input)!.reverse();
    assert.throws(() => assertPlainResponseWireOrder(wrong, 'PLAIN-REPLY', 'late-input'), /unseen user input must follow/);
  }
});

test('wire oracle rejects missing, duplicated, or unrelated results and duplicated input', () => {
  const original = bodies()[0]!;
  for (const replacement of [[], [{ role: 'tool', tool_call_id: 'wrong', content: 'done' }], [
    { role: 'tool', tool_call_id: 'first', content: 'done' },
    { role: 'tool', tool_call_id: 'first', content: 'done' },
  ]]) {
    const body = { messages: [original.messages![0], ...replacement, original.messages!.at(-1)] };
    assert.throws(() => assertConcurrentWireOrder(body, calls, injected));
  }
  const body = structuredClone(original);
  body.messages!.push(body.messages!.at(-1)!);
  assert.throws(() => assertConcurrentWireOrder(body, calls, injected));
});

test('Anthropic user text cannot hide between result blocks in a shared user envelope', () => {
  const body = { messages: [
    { role: 'assistant', content: calls.map(id => ({ type: 'tool_use', id, name: 'terminal', input: {} })) },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'first', content: 'done' },
      { type: 'text', text: injected },
      { type: 'tool_result', tool_use_id: 'second', content: 'done' },
    ] },
  ] };
  assert.throws(() => assertConcurrentWireOrder(body, calls, injected));
});

test('text mentioning the instruction in a tool result is not the user arrival', () => {
  const body = bodies()[0]!;
  body.messages!.pop();
  body.messages![1]!.content = injected;
  assert.throws(() => assertConcurrentWireOrder(body, calls, injected));
});

function bodies(): { messages?: Record<string, unknown>[]; input?: Record<string, unknown>[] }[] {
  return [
    { messages: [
      { role: 'assistant', tool_calls: calls.map(id => ({ id, function: { name: 'terminal', arguments: '{}' } })) },
      ...calls.map(id => ({ role: 'tool', tool_call_id: id, content: 'done' })),
      { role: 'user', content: injected },
    ] },
    { input: [
      ...calls.map(id => ({ type: 'function_call', call_id: `call_${id}`, name: 'terminal', arguments: '{}' })),
      ...calls.map(id => ({ type: 'function_call_output', call_id: `call_${id}`, output: 'done' })),
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: injected }] },
    ] },
    { messages: [
      { role: 'assistant', content: calls.map(id => ({ type: 'tool_use', id, name: 'terminal', input: {} })) },
      { role: 'user', content: calls.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'done' })) },
      { role: 'user', content: [{ type: 'text', text: injected }] },
    ] },
    { input: [
      ...calls.map(id => ({ type: 'function_call', id, name: 'terminal', arguments: {} })),
      ...calls.map(id => ({ type: 'function_result', call_id: id, result: [{ type: 'text', text: 'done' }] })),
      { type: 'user_input', content: [{ type: 'text', text: injected }] },
    ] },
  ];
}
