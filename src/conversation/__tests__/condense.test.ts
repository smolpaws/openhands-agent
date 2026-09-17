import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/index.js';
import { NoOpCondenser, type Condenser } from '../../context/condenser.js';
import type { View } from '../../context/view.js';
import { condensationSchema } from '../../event/index.js';
import { llmProfileSchema, messageSchema } from '../../llm/index.js';
import { FinishTool, ThinkTool } from '../../tool/builtins.js';
import { LocalConversation } from '../local-conversation.js';
import { RemoteConversation, type RemoteFetchLike } from '../remote-conversation.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'test-model' });
const response = (name: string) => ({
  usage: null,
  message: messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{
    id: 'call-' + name, name, origin: 'completion',
    arguments: JSON.stringify(name === 'finish' ? { message: 'done' } : { thought: 'working' }),
  }] }),
});

describe('pinned Python explicit condensation', () => {
  it.each([null, new NoOpCondenser()])('rejects missing or unsupported condensers without making a call', async condenser => {
    const complete = vi.fn(async () => response('finish'));
    const conversation = new LocalConversation({ agent: new Agent({ llm: { profile, complete }, condenser }) });
    conversation.sendMessage('small input');
    await expect(conversation.condense()).rejects.toThrow(/Cannot condense conversation/);
    expect(complete).not.toHaveBeenCalled();
    expect(conversation.state.events.some(event => event.kind === 'CondensationRequest')).toBe(false);
  });

  it('processes one forced step without resuming a paused conversation', async () => {
    const complete = vi.fn(async () => response('finish'));
    const condense = vi.fn(async (view: View) => {
      expect(view.unhandledCondensationRequest).toBe(true);
      return condensationSchema.parse({ forgotten_event_ids: [], summary: 'summary', summary_offset: 0 });
    });
    const conversation = new LocalConversation({ agent: new Agent({
      llm: { profile, complete }, condenser: { condense, handlesCondensationRequests: () => true },
    }) });
    conversation.sendMessage('work');
    conversation.pause();
    await conversation.condense();
    expect(condense).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(conversation.state.executionStatus).toBe('paused');
    expect(conversation.lastStepUserMessageId).toBeNull();
    expect(conversation.state.events.map(event => event.kind)).toContain('Condensation');
  });

  it('serializes a manual condensation after the current step and before the next model request', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const complete = vi.fn(async () => {
      if (complete.mock.calls.length === 1) {
        order.push('first request'); entered.resolve(); await release.promise; return response('think');
      }
      order.push('second request'); return response('finish');
    });
    const condenser: Condenser = {
      handlesCondensationRequests: () => true,
      condense: view => {
        if (!view.unhandledCondensationRequest) return view;
        order.push('condense');
        return condensationSchema.parse({ forgotten_event_ids: [], summary: 'summary', summary_offset: 0 });
      },
    };
    const conversation = new LocalConversation({
      agent: new Agent({ llm: { profile, complete }, condenser, tools: [ThinkTool.create(), FinishTool.create()] }),
    });
    conversation.sendMessage('work');
    const run = conversation.run();
    await entered.promise;
    const manual = conversation.condense();
    await Promise.resolve();
    expect(order).toEqual(['first request']);
    release.resolve();
    await Promise.all([run, manual]);
    expect(order).toEqual(['first request', 'condense', 'second request']);
    expect(conversation.state.executionStatus).toBe('finished');
    expect(conversation.state.events.filter(event => event.kind === 'CondensationRequest')).toHaveLength(1);
  });

  it('propagates a failed forced step and retains the request for later recovery', async () => {
    const failure = new Error('summary unavailable');
    const conversation = new LocalConversation({ agent: new Agent({
      llm: { profile, complete: async () => response('finish') },
      condenser: { handlesCondensationRequests: () => true, condense: async () => { throw failure; } },
    }) });
    conversation.sendMessage('work');
    await expect(conversation.condense()).rejects.toBe(failure);
    expect(conversation.state.events.at(-1)?.kind).toBe('CondensationRequest');
    await expect(conversation.condense()).rejects.toBe(failure);
    expect(conversation.state.events.filter(event => event.kind === 'CondensationRequest')).toHaveLength(2);
  });

  it.each([200, 404, 500])('remote condensation uses the normal authenticated endpoint and propagates HTTP %i', async status => {
    const request = vi.fn<RemoteFetchLike['request']>(async () => ({
      ok: status === 200, status, json: async () => ({ success: true }), text: async () => 'condensation failed',
    }));
    const conversation = new RemoteConversation({
      host: 'https://server.example/', conversationId: 'conversation/a', apiKey: 'test-session-key', fetch: { request },
    });
    const call = conversation.condense();
    if (status === 200) await call;
    else await expect(call).rejects.toThrow('HTTP ' + status);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'https://server.example/api/conversations/conversation%2Fa/condense',
      { method: 'POST', headers: { 'x-session-api-key': 'test-session-key' } },
    );
  });
});
