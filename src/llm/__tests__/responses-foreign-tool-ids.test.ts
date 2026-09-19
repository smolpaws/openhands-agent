import { expect, test } from 'vitest';
import { buildOpenAIResponsesBody } from '../openai.js';
import { llmProfileSchema, messageSchema, textContent } from '../index.js';

const profile = llmProfileSchema.parse({ profileId: 'astra', providerId: 'litellm_proxy', model: 'openai/gpt-6-astra', openAiApiMode: 'responses' });
test.each(['toolu_01W6HE76vPPJzLEHswEBbfqT', 'call_chat_tool'])('replays foreign tool call %s without fabricating a Responses item ID', id => {
  const messages = [
    messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id, name: 'lookup', arguments: '{}', responses_item_id: null, origin: 'completion' }] }),
    messageSchema.parse({ role: 'tool', tool_call_id: id, content: [textContent('result')] }),
  ];
  const original = JSON.stringify(messages);
  const body = buildOpenAIResponsesBody(profile, messages);
  const items = body.input as Record<string, unknown>[];
  expect(items[0]).not.toHaveProperty('id');
  expect(items[0]?.call_id).toBe(items[1]?.call_id);
  expect(items[0]).toMatchObject({ type: 'function_call', name: 'lookup', arguments: '{}' });
  expect(JSON.stringify(messages)).toBe(original);
});
test('preserves a real Responses item ID separately from its call ID', () => {
  const body = buildOpenAIResponsesBody(profile, [messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: 'call_native', responses_item_id: 'fc_native', origin: 'responses', name: 'lookup', arguments: '{}' }] })]);
  expect(body.input).toMatchObject([{ id: 'fc_native', call_id: 'call_native' }]);
});
