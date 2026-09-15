import { orderCompletedToolResults } from '../tool-result-order.js';
import { describe, it, expect } from 'vitest';
import { buildChatCompletionsBody, buildOpenAIResponsesBody } from '../openai.js';
import { buildAnthropicMessagesBody } from '../anthropic.js';
import { buildGeminiInteractionsBody } from '../gemini.js';
import { llmProfileSchema, messageSchema } from '../index.js';

// Sanitized shape of the September 15 WhatsApp failure. No private chat/tool contents.
const messages = () => [
  messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: 'slow-call', name: 'terminal', arguments: '{}', origin: 'completion' }] }),
  messageSchema.parse({ role: 'user', content: [{ type: 'text', text: 'Please include the result.' }] }),
  messageSchema.parse({ role: 'tool', tool_call_id: 'slow-call', name: 'terminal', content: [{ type: 'text', text: 'Completed once.' }] }),
];
const profile = llmProfileSchema.parse({ profileId: 'test', providerId: 'openai', model: 'test' });

describe('provider tool-result adjacency for concurrent user messages', () => {
  it('serializes the complete tool exchange before the concurrent user message without mutating history', () => {
    const input = messages(); const before = JSON.stringify(input);
    const body = buildChatCompletionsBody(profile, input);
    expect((body.messages as Array<{role:string}>).map(m => m.role)).toEqual(['assistant','tool','user']);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('keeps OpenAI Responses call/output pairs ahead of concurrent user input', () => {
    const body = buildOpenAIResponsesBody(profile, messages());
    expect((body.input as Array<{type:string}>).map(m => m.type)).toEqual(['function_call','function_call_output','message']);
  });
  it('puts Anthropic tool_result before the concurrent user text', () => {
    const body = buildAnthropicMessagesBody(profile, messages());
    const turns = body.messages as Array<{role:string;content:Array<{type:string}>}>;
    expect(turns[1]?.content[0]?.type).toBe('tool_result');
  });
  it('puts Gemini function_result before the concurrent user text', () => {
    const body = buildGeminiInteractionsBody(profile, messages());
    const input = body.input as Array<{type:string}>;
    expect(input.map(m => m.type)).toEqual(['function_call','function_result','user_input']);
  });
});

describe('completed tool-group ordering boundaries', () => {
  it('waits for all parallel results and preserves user/result content and relative order', () => {
    const [call, user, result] = messages();
    const secondCall = { id: 'second', name: 'terminal', arguments: '{}', origin: 'completion' as const };
    const batch = messageSchema.parse({ ...call, tool_calls: [...(call?.tool_calls ?? []), secondCall], reasoning_content: 'Keep this reasoning' });
    const other = messageSchema.parse({ ...result, tool_call_id: 'second' });
    const followup = messageSchema.parse({ role: 'user', content: [{ type: 'text', text: 'And keep the files.' }] });
    const input = [batch, user!, other, followup, result!];
    const before = JSON.stringify(input);
    expect(orderCompletedToolResults(input)).toEqual([batch, other, result, user, followup]);
    expect(JSON.stringify(input)).toBe(before);
    expect(orderCompletedToolResults(orderCompletedToolResults(input))).toEqual([batch, other, result, user, followup]);
  });
  it('does not manufacture missing results or move messages across later assistant turns', () => {
    const [call, user, result] = messages();
    for (const input of [[call!, user!], [call!, user!, messageSchema.parse({ role: 'assistant', content: [] }), result!],
      [call!, user!, messageSchema.parse({ ...result, tool_call_id: 'unrelated' })]]) {
      expect(orderCompletedToolResults(input)).toEqual(input);
    }
  });
  it('leaves already valid histories and metadata-bearing user messages unchanged', () => {
    const [call, user, result] = messages();
    const valid = [call!, result!, user!]; expect(orderCompletedToolResults(valid)).toEqual(valid);
    const named = [call!, messageSchema.parse({ ...user, name: 'named' }), result!];
    expect(orderCompletedToolResults(named)).toEqual(named);
  });
});
