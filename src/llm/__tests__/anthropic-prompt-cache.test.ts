import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent } from '../../agent/agent.js';
import { AgentContext } from '../../context/index.js';
import { ConversationState } from '../../conversation/state.js';
import { messageEventSchema } from '../../event/index.js';
import { ToolDefinition } from '../../tool/index.js';
import { AnthropicMessagesClient, buildAnthropicMessagesBody } from '../anthropic.js';
import { imageContent, llmProfileSchema, textContent } from '../index.js';
import { OpenAIChatClient, buildChatCompletionsBody, buildOpenAIResponsesBody } from '../openai.js';
import type { FetchLike } from '../client.js';

const cacheControl = { type: 'ephemeral' };
const nativeProfile = llmProfileSchema.parse({ profileId: 'haiku', providerId: 'anthropic', model: 'claude-haiku-4-5' });
const proxyProfile = llmProfileSchema.parse({ profileId: 'fable', providerId: 'litellm_proxy', model: 'anthropic/claude-fable-5-1' });
const tool = new ToolDefinition({ name: 'lookup', description: 'Read a value', inputSchema: z.object({}), executor: async () => ({ content: 'result' }) });

describe('Anthropic cache duration requests', () => {
  it('keeps subsequent default and explicit five-minute requests unchanged after a one-hour request', () => {
    const messages = [{ role: 'user' as const, content: [textContent('prefix')] }];
    for (const [profile, build] of [[nativeProfile, buildAnthropicMessagesBody], [proxyProfile, buildChatCompletionsBody]] as const) {
      const oneHour = build({ ...profile, anthropicCacheTtl: '1h' }, messages);
      for (const fiveMinuteProfile of [profile, { ...profile, anthropicCacheTtl: '5m' as const }]) {
        expect(build(fiveMinuteProfile, messages).messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } }] }]);
      }
      expect(oneHour.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }] }]);
    }
    expect(messages[0]!.content[0]!.cache_prompt).toBe(false);
  });
});

// Adapted from pinned Python test_prompt_caching_cross_conversation.py and
// test_message.py's tool-role cache tests. Capture the actual Agent -> HTTP seam.
describe('Anthropic prompt caching through the Agent', () => {
  it.each([
    ['native', '5m'], ['proxy', '5m'], ['native', '1h'], ['proxy', '1h'],
  ] as const)('automatically caches static system and latest user for %s requests with %s duration without changing history', async (protocol, anthropicCacheTtl) => {
    const expectedControl = anthropicCacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : cacheControl;
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const response = protocol === 'native'
        ? { content: [{ type: 'text', text: 'ok' }] }
        : { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
      return { ok: true, status: 200, json: async () => response, text: async () => JSON.stringify(response) };
    };
    const llm = protocol === 'native'
      ? new AnthropicMessagesClient({ ...nativeProfile, anthropicCacheTtl }, 'test', fetch)
      : new OpenAIChatClient({ ...proxyProfile, anthropicCacheTtl }, 'test', fetch);
    const agent = new Agent({ llm, systemPrompt: 'Stable instructions.', context: new AgentContext({ currentDatetime: '2026-09-16T10:00' }), tools: [tool] });
    const user = messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent('first')] } });
    const state = new ConversationState({ events: [user] });
    await agent.step(state);
    state.appendEvent(messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent('second')] } }));
    await agent.step(state);

    for (const [index, body] of bodies.entries()) {
      const messages = body.messages as { role: string; content: unknown }[];
      const system = protocol === 'native' ? body.system : messages[0]?.content;
      expect(system).toEqual([
        { type: 'text', text: 'Stable instructions.', cache_control: expectedControl },
        { type: 'text', text: expect.stringContaining('<CURRENT_DATETIME>') },
      ]);
      expect(messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: index === 0 ? 'first' : 'second', cache_control: expectedControl }] });
      expect(JSON.stringify(body).match(/cache_control/gu)).toHaveLength(2);
      expect(JSON.stringify(body.tools)).not.toContain('cache_control');
    }
    expect(user.llm_message.content[0]?.cache_prompt).toBe(false);
  });
});

describe.each(['5m', '1h'] as const)('Anthropic cache wire contract (%s)', anthropicCacheTtl => {
  const native = { ...nativeProfile, anthropicCacheTtl };
  const proxy = { ...proxyProfile, anthropicCacheTtl };
  const cacheControl = anthropicCacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  const history = [
    { role: 'system' as const, content: [textContent('static'), textContent('dynamic', true)] },
    { role: 'user' as const, content: [textContent('old')] },
    { role: 'assistant' as const, content: [], tool_calls: [
      { id: 'one', name: 'lookup', arguments: '{}', origin: 'completion' as const },
      { id: 'two', name: 'lookup', arguments: '{}', origin: 'completion' as const },
    ] },
    { role: 'tool' as const, tool_call_id: 'two', content: [textContent('result two')] },
    { role: 'tool' as const, tool_call_id: 'one', content: [textContent('result one')] },
  ];

  it.each(['claude-fable-5-1', 'claude-opus-5'])('recognizes the pinned %s cache-capable model family', model => {
    const messages = [{ role: 'user' as const, content: [textContent('automatic')] }];
    const nativeBody = buildAnthropicMessagesBody({ ...native, model }, messages);
    const proxyBody = buildChatCompletionsBody({ ...proxy, model: `anthropic/${model}` }, messages);
    for (const body of [nativeBody, proxyBody]) expect(JSON.stringify(body).match(/cache_control/gu)).toHaveLength(1);
  });

  it('does not cache empty text or signed thinking, and lifts image-result markers without nesting them', () => {
    const messages = [
      { role: 'system' as const, content: [textContent('', true), textContent('dynamic')] },
      { role: 'assistant' as const, content: [textContent('', true)], thinking_blocks: [{ type: 'thinking' as const, thinking: 'thought', signature: 'signature' }],
        tool_calls: [{ id: 'image', name: 'lookup', arguments: '{}', origin: 'completion' as const }] },
      { role: 'tool' as const, tool_call_id: 'image', content: [imageContent(['https://example.org/image.png'], true)] },
    ];
    const nativeBody = buildAnthropicMessagesBody(native, messages);
    expect((nativeBody.messages as unknown[]).at(-1)).toEqual({ role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'image', content: [{ type: 'image', source: { type: 'url', url: 'https://example.org/image.png' } }], cache_control: cacheControl,
    }] });
    const proxyBody = buildChatCompletionsBody(proxy, messages);
    expect((proxyBody.messages as unknown[]).at(-1)).toEqual({ role: 'tool', tool_call_id: 'image',
      content: [{ type: 'image_url', image_url: { url: 'https://example.org/image.png' } }], cache_control: cacheControl });
    for (const body of [nativeBody, proxyBody]) expect(JSON.stringify(body).match(/cache_control/gu)).toHaveLength(1);
  });

  it('caches the latest user after placing completed tools ahead of a concurrent user message', () => {
    const messages = [history[0]!, history[2]!, { role: 'user' as const, content: [textContent('new request')] }, ...history.slice(-2)];
    for (const body of [buildAnthropicMessagesBody(native, messages), buildChatCompletionsBody(proxy, messages)]) {
      expect((body.messages as unknown[]).at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'new request', cache_control: cacheControl }] });
      expect(JSON.stringify(body).match(/cache_control/gu)).toHaveLength(2);
    }
  });

  it('places native tool caching on the last ordered outer result block', () => {
    const body = buildAnthropicMessagesBody(native, history, [tool]);
    expect(body.system).toEqual([{ type: 'text', text: 'static', cache_control: cacheControl }, { type: 'text', text: 'dynamic' }]);
    expect((body.messages as unknown[]).at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'two', content: 'result two' },
      { type: 'tool_result', tool_use_id: 'one', content: 'result one', cache_control: cacheControl },
    ] });
    expect(JSON.stringify(body).match(/cache_control/gu)).toHaveLength(2);
  });

  it.each(['litellm_proxy', 'openrouter'])('lifts tool-result cache control to the %s Chat message', (providerId) => {
    const body = buildChatCompletionsBody({ ...proxy, providerId }, history, [tool]);
    expect((body.messages as unknown[]).slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'two', content: 'result two' },
      { role: 'tool', tool_call_id: 'one', content: 'result one', cache_control: cacheControl },
    ]);
    expect(JSON.stringify(body).match(/cache_control/gu)).toHaveLength(2);
  });

  it('preserves explicit user breakpoints and places a multi-image marker only on the final image', () => {
    const messages = [{ role: 'user' as const, content: [textContent('prefix', true), imageContent(['https://example.org/one.png', 'https://example.org/two.png'])] }];
    expect(buildAnthropicMessagesBody(native, messages).messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'prefix', cache_control: cacheControl },
      { type: 'image', source: { type: 'url', url: 'https://example.org/one.png' } },
      { type: 'image', source: { type: 'url', url: 'https://example.org/two.png' }, cache_control: cacheControl },
    ] }]);
    expect(buildChatCompletionsBody(proxy, messages).messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'prefix', cache_control: cacheControl },
      { type: 'image_url', image_url: { url: 'https://example.org/one.png' } },
      { type: 'image_url', image_url: { url: 'https://example.org/two.png' }, cache_control: cacheControl },
    ] }]);
  });

  it('supports explicit profile opt-out even with manually marked content', () => {
    const messages = [{ role: 'user' as const, content: [textContent('do not cache', true)] }];
    const disabledNative = llmProfileSchema.parse({ ...native, cachingPrompt: false });
    const disabledProxy = llmProfileSchema.parse({ ...proxy, cachingPrompt: false });
    expect(JSON.stringify(buildAnthropicMessagesBody(disabledNative, messages))).not.toContain('cache_control');
    expect(JSON.stringify(buildChatCompletionsBody(disabledProxy, messages))).not.toContain('cache_control');
  });

  it('does not pass Anthropic markers to unrelated Chat or Responses providers', () => {
    const messages = [{ role: 'user' as const, content: [textContent('explicit cache', true)] }];
    for (const [providerId, model] of [['openai', 'gpt-5.4'], ['deepseek', 'deepseek-v4-flash'], ['openrouter', 'google/gemini-2.5-pro'], ['litellm_proxy', 'openai/gpt-5.4'], ['anthropic', 'claude-2.1']]) {
      const profile = llmProfileSchema.parse({ profileId: 'other', providerId, model, anthropicCacheTtl });
      expect(JSON.stringify(buildChatCompletionsBody(profile, messages))).not.toContain('cache_control');
      expect(JSON.stringify(buildOpenAIResponsesBody(profile, messages))).not.toContain('cache_control');
    }
    const subscription = llmProfileSchema.parse({ profileId: 'sub', providerId: 'openai', model: 'gpt-5.4', authType: 'subscription', anthropicCacheTtl });
    expect(JSON.stringify(buildOpenAIResponsesBody(subscription, messages))).not.toContain('cache_control');
  });

  it('rejects more than four explicit wire breakpoints instead of sending an invalid request', () => {
    const messages = [{ role: 'user' as const, content: Array.from({ length: 5 }, (_, i) => textContent(`part ${i}`, true)) }];
    expect(() => buildAnthropicMessagesBody(native, messages)).toThrow(/four|4/u);
    expect(() => buildChatCompletionsBody(proxy, messages)).toThrow(/four|4/u);
  });
});
