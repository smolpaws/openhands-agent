import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import { Agent } from '../../agent/agent.js';
import { AgentResetCondenser } from '../../context/agent-reset-condenser.js';
import { ConversationState } from '../../conversation/state.js';
import { EventLog } from '../../conversation/event-log.js';
import { messageEventSchema } from '../../event/index.js';
import { InMemoryFileStore } from '../../io/index.js';
import { AnthropicMessagesClient } from '../anthropic.js';
import { LLMCallContext } from '../call-context.js';
import { llmProfileSchema, messageSchema } from '../index.js';

// Sanitized provider rejection captured with a synthetic reset exchange. The local
// HTTP fixture exercises the real client, recovery, Agent and persistence paths.
const bindingError = { error: { type: 'invalid_request_error', message:
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
  + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". '
  + 'That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. '
  + 'The earlier `messages` differ from when this block was created.' } };
const success = { id: 'answer', content: [{ type: 'text', text: 'Continued.' }] };
type Block = { type: string; [key: string]: unknown };
type Body = { messages: { role: string; content: Block[] }[]; [key: string]: unknown };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function fixture(reply: (body: Body, index: number) => [number, unknown]) {
  const calls: { body: Body; session: string | string[] | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Body;
    calls.push({ body, session: request.headers['x-litellm-session-id'] });
    const [status, payload] = reply(body, calls.length);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
  const profile = llmProfileSchema.parse({ profileId: 'binding-test', providerId: 'anthropic', model: 'claude-opus-5-5',
    baseUrl: `http://127.0.0.1:${address.port}`, maxInputTokens: 1_000_000 });
  const client = new AnthropicMessagesClient(profile, 'synthetic-key', undefined, undefined, { retry: { maxAttempts: 1 } });
  return { calls, client };
}

function history(thinking = '') {
  return [
    messageSchema.parse({ role: 'user', content: 'Context reset.' }),
    messageSchema.parse({ role: 'assistant', thinking_blocks: [
      { type: 'thinking', thinking, signature: 'synthetic-bound-signature' },
      { type: 'redacted_thinking', data: 'synthetic-opaque-data' },
    ], content: 'Keep this text.', tool_calls: [{ id: 'call', name: 'condense', arguments: '{"message_to_future_self":"Keep the notes."}', origin: 'completion' }] }),
    messageSchema.parse({ role: 'tool', tool_call_id: 'call', content: 'Reset completed.' }),
    messageSchema.parse({ role: 'user', content: 'Pending user input.' }),
  ];
}

function withoutThinking(body: Body): Body {
  return { ...body, messages: body.messages.map(message => ({ ...message,
    content: message.content.filter(block => !['thinking', 'redacted_thinking'].includes(block.type)),
  })).filter(message => message.content.length > 0) };
}

describe('Anthropic prefix-bound thinking recovery', () => {
  it.each(['', 'Nonempty signed thought.'])('retries a binding rejection once without opaque thinking (%j)', async thinking => {
    const { client, calls } = await fixture((_body, index) => index === 1 ? [400, bindingError] : [200, success]);
    const messages = history(thinking);
    const original = structuredClone(messages);
    const result = await client.complete(messages, undefined, { callContext: new LLMCallContext({ sessionId: 'session' }) });
    expect(result.message.content[0]).toMatchObject({ text: 'Continued.' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(withoutThinking(calls[0]!.body));
    expect(calls.map(call => call.session)).toEqual(['session', 'session']);
    expect(messages).toEqual(original);
    // The next independent completion starts from the original signed history.
    await client.complete(messages);
    expect(calls[2]!.body).toEqual(calls[0]!.body);
  });

  it('preserves valid signed thinking without retrying', async () => {
    const { client, calls } = await fixture(() => [200, success]);
    await client.complete(history());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.messages[1]!.content[0]).toMatchObject({ type: 'thinking', thinking: '', signature: 'synthetic-bound-signature' });
  });

  it('omits reasoning-only assistant turns in the retry without editing the input', async () => {
    const { client, calls } = await fixture((_body, index) => index === 1 ? [400, bindingError] : [200, success]);
    const messages = history();
    messages.splice(1, 0, messageSchema.parse({ role: 'assistant', thinking_blocks: [{ type: 'redacted_thinking', data: 'opaque' }] }));
    await client.complete(messages);
    expect(calls[1]!.body).toEqual(withoutThinking(calls[0]!.body));
    expect(calls[1]!.body.messages).toHaveLength(4);
    expect(messages).toHaveLength(5);
  });

  it('does not loop or leak the provider response when the retry is rejected', async () => {
    const rejection = { error: { ...bindingError.error, message: `${bindingError.error.message} private-input-echo` } };
    const { client, calls } = await fixture(() => [400, rejection]);
    const error = await client.complete(history()).catch((error: Error) => error);
    expect(error).toMatchObject({ name: 'LLMBadRequestError', message: expect.stringContaining('thinking') });
    expect(String(error)).not.toContain('private-input-echo');
    expect(calls).toHaveLength(2);
  });

  it.each([
    [400, { error: { type: 'invalid_request_error', message: 'Invalid `signature` in `thinking` block.' } }],
    [400, { error: { type: 'invalid_request_error', message: 'Unrelated invalid request.' } }],
    [400, { error: { type: 'other_error', message: bindingError.error.message } }],
    [401, bindingError], [429, bindingError], [500, bindingError],
  ])('does not apply binding recovery to another rejection (%s, %j)', async (status, payload) => {
    const { client, calls } = await fixture(() => [status as number, payload]);
    await expect(client.complete(history())).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('does not retry a binding rejection without opaque thinking to remove', async () => {
    const { client, calls } = await fixture(() => [400, bindingError]);
    await expect(client.complete([messageSchema.parse({ role: 'user', content: 'Hi.' })])).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('continues two committed resets after restore, preserving the durable exchange and late input', async () => {
    const store = new InMemoryFileStore();
    let state = new ConversationState({ eventLog: new EventLog(store), events: [messageEventSchema.parse({
      source: 'user', llm_message: { role: 'user', content: 'Old task.' },
    })] });
    let completed = 0;
    const { client, calls } = await fixture((body) => {
      if (body.messages.some(message => message.content.some(block => block.type === 'thinking'))) return [400, bindingError];
      completed += 1;
      if (completed === 3) return [200, success];
      state.appendEvent(messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: `Late input ${completed}.` } }));
      return [200, { id: `reset-${completed}`, content: [
        { type: 'thinking', thinking: '', signature: `synthetic-signature-${completed}` },
        { type: 'tool_use', id: `reset-call-${completed}`, name: 'condense', input: { message_to_future_self: 'Keep the notes.' } },
      ] }];
    });
    const agent = new Agent({ llm: client, usageId: 'agent', condenser: new AgentResetCondenser(), systemPrompt: 'Fixed identity.' });
    for (let round = 0; round < 3; round += 1) {
      const before = structuredClone(state.events);
      await agent.step(state);
      state = new ConversationState({ eventLog: new EventLog(store) });
      expect(state.events.slice(0, before.length)).toEqual(before);
    }
    expect(calls).toHaveLength(5);
    for (const index of [2, 4]) {
      expect(calls[index]!.body).toEqual(withoutThinking(calls[index - 1]!.body));
      expect(JSON.stringify(calls[index]!.body)).toContain(`Late input ${index / 2}.`);
    }
    expect(state.events.filter(event => event.kind === 'Condensation')).toHaveLength(2);
    expect(state.events.filter(event => event.kind === 'ActionEvent').map(event => event.thinking_blocks)).toEqual([
      [{ type: 'thinking', thinking: '', signature: 'synthetic-signature-1' }],
      [{ type: 'thinking', thinking: '', signature: 'synthetic-signature-2' }],
    ]);
    expect(state.stats.usage_to_metrics.agent?.records).toHaveLength(3);
    expect(state.stats.usage_to_metrics.condenser).toBeUndefined();
  });
});
