import { describe, expect, it } from 'vitest';

import { Agent } from '../agent.js';
import { AgentResetCondenser } from '../../context/agent-reset-condenser.js';
import { ConversationState } from '../../conversation/state.js';
import { EventLog } from '../../conversation/event-log.js';
import { messageEventSchema } from '../../event/index.js';
import { InMemoryFileStore } from '../../io/index.js';
import { AnthropicMessagesClient } from '../../llm/anthropic.js';
import type { FetchLike, LLMClient } from '../../llm/client.js';
import { llmProfileSchema } from '../../llm/index.js';
import { OpenAIChatClient, OpenAIResponsesClient } from '../../llm/openai.js';

const futureMessage = '  From your earlier self:\nRead notes/today.md.  ';
const args = { message_to_future_self: futureMessage };
type Provider = 'openai-chat' | 'openai-responses' | 'anthropic';
type Wire = Record<string, unknown>;
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });

function client(provider: Provider, fetch: FetchLike): LLMClient {
  const profile = llmProfileSchema.parse({
    profileId: 'native-main', providerId: provider === 'anthropic' ? 'anthropic' : 'openai',
    model: provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-5.1', maxInputTokens: 400_000,
    maxOutputTokens: 4096, openAiApiMode: provider === 'openai-responses' ? 'responses' : 'chat_completions',
    ...(provider === 'anthropic' ? { reasoningEffort: 'high' } : {}),
  });
  if (provider === 'anthropic') return new AnthropicMessagesClient(profile, 'synthetic-test-key', fetch);
  if (provider === 'openai-responses') return new OpenAIResponsesClient(profile, 'synthetic-test-key', fetch);
  return new OpenAIChatClient(profile, 'synthetic-test-key', fetch);
}

function response(provider: Provider, round: number): Wire {
  const isReset = round < 3;
  const callId = `call_condense_${round}`;
  if (provider === 'openai-chat') return {
    id: `response_${round}`, choices: [{ message: isReset ? {
      role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'condense', arguments: JSON.stringify(args) } }],
    } : { role: 'assistant', content: 'Ready to continue.' } }],
  };
  if (provider === 'openai-responses') return {
    id: `response_${round}`, output: isReset ? [
      { type: 'reasoning', id: `rs_${round}`, summary: [{ type: 'summary_text', text: 'Preserve the important notes.' }], encrypted_content: `encrypted_fixture_${round}`, status: 'completed' },
      { type: 'function_call', id: `fc_${round}`, call_id: callId, name: 'condense', arguments: JSON.stringify(args) },
    ] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ready to continue.' }] }],
  };
  return {
    id: `response_${round}`, type: 'message', role: 'assistant', content: isReset ? [
      { type: 'thinking', thinking: 'Save the useful context first.', signature: `signature_fixture_${round}` },
      { type: 'tool_use', id: callId, name: 'condense', input: args },
    ] : [{ type: 'text', text: 'Ready to continue.' }],
  };
}

function verifyWire(provider: Provider, body: Wire, resetRound: number, withLateInput: boolean): void {
  const callId = `call_condense_${resetRound}`;
  const encoded = JSON.stringify(body);
  expect(encoded).toContain('Fixed agent identity');
  expect(encoded).toContain('The agent triggered context condensation.');
  expect(encoded).not.toContain('old context to clear');
  expect(encoded).toContain('regain your bearings');
  expect(encoded).toContain(JSON.stringify(futureMessage).slice(1, -1));
  if (withLateInput) expect(encoded).toContain(`late input ${resetRound}`);
  if (resetRound > 1) expect(encoded).not.toContain(`late input ${resetRound - 1}`);
  if (provider === 'openai-chat') {
    const messages = body.messages as Wire[];
    expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', ...(withLateInput ? ['user'] : [])]);
    expect(messages[2]).toMatchObject({ tool_calls: [{ id: callId, type: 'function', function: { name: 'condense', arguments: JSON.stringify(args) } }] });
    expect(messages[3]).toMatchObject({ tool_call_id: callId });
  } else if (provider === 'openai-responses') {
    const input = body.input as Wire[];
    expect(input.map(item => item.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call_output', ...(withLateInput ? ['message'] : [])]);
    expect(input[0]).toMatchObject({ role: 'user' });
    expect(input[1]).toMatchObject({ id: `rs_${resetRound}`, encrypted_content: `encrypted_fixture_${resetRound}` });
    expect(input[2]).toMatchObject({ id: `fc_${resetRound}`, call_id: callId, name: 'condense', arguments: JSON.stringify(args) });
    expect(input[3]).toMatchObject({ call_id: callId });
    if (withLateInput) expect(input[4]).toMatchObject({ role: 'user' });
    expect(body).not.toHaveProperty('previous_response_id');
  } else {
    const messages = body.messages as Wire[];
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', ...(withLateInput ? ['user'] : [])]);
    expect(messages[1]).toMatchObject({ content: [
      { type: 'thinking', thinking: 'Save the useful context first.', signature: `signature_fixture_${resetRound}` },
      { type: 'tool_use', id: callId, name: 'condense', input: args },
    ] });
    expect(messages[2]).toMatchObject({ content: [{ type: 'tool_result', tool_use_id: callId }] });
  }
}

describe('agent reset native provider wire contracts', () => {
  it.each((['openai-chat', 'openai-responses', 'anthropic'] as const).flatMap(provider => [false, true].map(withLateInput => ({ provider, withLateInput }))))(
    '$provider keeps the genuine exchange through two resets and restores (late input: $withLateInput)', async ({ provider, withLateInput }) => {
      const store = new InMemoryFileStore();
      let state = new ConversationState({ eventLog: new EventLog(store), events: [user('old context to clear')] });
      const bodies: Wire[] = [];
      const fetch: FetchLike = async (_url, request) => {
        const round = bodies.push(JSON.parse(request.body) as Wire);
        if (withLateInput && round < 3) await state.appendEventAsync(user(`late input ${round}`));
        const payload = response(provider, round);
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      };
      const agent = new Agent({ llm: client(provider, fetch), condenser: new AgentResetCondenser(), systemPrompt: 'Fixed agent identity' });
      for (let round = 1; round <= 3; round += 1) {
        await agent.step(state);
        state = new ConversationState({ eventLog: new EventLog(store) });
      }
      expect(bodies).toHaveLength(3);
      verifyWire(provider, bodies[1]!, 1, withLateInput);
      verifyWire(provider, bodies[2]!, 2, withLateInput);
      expect(state.events.filter(event => event.kind === 'Condensation')).toHaveLength(2);
      expect(state.events.filter(event => event.kind === 'CondensationRequest')).toHaveLength(2);
      expect(state.stats.usage_to_metrics.condenser).toBeUndefined();
    },
  );
});
