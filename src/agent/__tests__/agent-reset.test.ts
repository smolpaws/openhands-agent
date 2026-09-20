import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import { AgentResetCondenser } from '../../context/agent-reset-condenser.js';
import { LLMSummarizingCondenser } from '../../context/llm-summarizing-condenser.js';
import { View } from '../../context/view.js';
import { AgentContext } from '../../context/agent-context.js';
import { ConversationState } from '../../conversation/state.js';
import { LocalConversation } from '../../conversation/local-conversation.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { messageEventSchema, type Event } from '../../event/index.js';
import { llmProfileSchema, messageSchema, type Message } from '../../llm/index.js';
import { LLMResponseError } from '../../llm/client.js';
import { LLMContextWindowExceedError, LLMMalformedConversationHistoryError } from '../../llm/exceptions.js';
import { ThinkTool } from '../../tool/builtins.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'test', maxInputTokens: 400_000 });
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });
const answer = (content = 'continued') => ({ usage: null, message: messageSchema.parse({ role: 'assistant', content }) });
const reset = (args: Record<string, unknown> = {}) => ({ usage: null, responseId: 'reset-response', message: messageSchema.parse({
  role: 'assistant', tool_calls: [{ id: 'real-condense-call', name: 'condense', arguments: JSON.stringify(args), origin: 'completion' }],
}) });
const text = (messages: readonly Message[]) => JSON.stringify(messages);

function persisted(events: Event[] = []) {
  const store = new InMemoryFileStore();
  const state = new ConversationState({ eventLog: new EventLog(store), events });
  return { state, restore: () => new ConversationState({ eventLog: new EventLog(store) }) };
}

describe('agent-controlled context reset', () => {
  it('keeps its genuine tool pair after fixed context and notice, preserves concurrent input, and never summarizes', async () => {
    const { state, restore } = persisted([user('old task that should be cleared')]);
    const seen: Message[][] = [];
    const future = '  Hi future self. Read notes/today.md.\nKeep the spacing.  ';
    const complete = vi.fn(async (messages: readonly Message[]) => {
      seen.push([...messages]);
      if (seen.length === 1) { await state.appendEventAsync(user('question arriving during reset completion')); return reset({ message_to_future_self: future }); }
      return answer();
    });
    const agent = new Agent({ llm: { profile, complete }, condenser: new AgentResetCondenser(), systemPrompt: 'fixed identity',
      context: new AgentContext({ systemMessageSuffix: 'memory runtime and skills', currentDatetime: null }) });
    expect(agent.tools.some(tool => tool.name === 'condense')).toBe(true);
    await agent.step(state);
    const original = structuredClone(state.events);
    const restored = restore();
    const view = View.fromEvents(restored.events);
    expect(view.events.map(event => event.kind)).toEqual(['MessageEvent', 'ActionEvent', 'ObservationEvent', 'MessageEvent']);
    expect(view.events[0]).toMatchObject({ source: 'environment', llm_message: { role: 'user', content: [{ text: 'The agent triggered context condensation.' }] } });
    expect(view.events[1]).toMatchObject({ tool_call_id: 'real-condense-call', action: { message_to_future_self: future } });
    expect(view.events[2]).toMatchObject({ tool_call_id: 'real-condense-call', observation: { kind: 'CondenseObservation', message_to_future_self: future } });
    expect(state.events.filter(event => event.kind === 'CondensationRequest')).toHaveLength(1);
    expect(state.events.filter(event => event.kind === 'Condensation')).toHaveLength(1);
    await agent.step(restored);
    expect(seen[1]?.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(text(seen[1]!)).toContain('fixed identity');
    expect(text(seen[1]!)).toContain('memory runtime and skills');
    expect(text(seen[1]!)).not.toContain('old task that should be cleared');
    expect(text(seen[1]!)).toContain('question arriving during reset completion');
    expect(restored.events.slice(0, original.length)).toEqual(original);
    expect(restored.stats.usage_to_metrics.condenser).toBeUndefined();
  });

  it('recovers a durable request/result before a failed reset commit without executing the tool again', async () => {
    const { state, restore } = persisted([user('old work')]);
    const append = state.appendEventAsync.bind(state);
    vi.spyOn(state, 'appendEventAsync').mockImplementation(async event => {
      if (event.kind === 'Condensation') throw new Error('commit unavailable');
      return append(event);
    });
    const complete = vi.fn(async () => reset());
    const agent = new Agent({ llm: { profile, complete }, condenser: new AgentResetCondenser() });
    await expect(agent.step(state)).rejects.toThrow('commit unavailable');
    expect(View.fromEvents(restore().events).events.some(event => event.id === state.events[0]?.id)).toBe(true);
    const restored = restore();
    await agent.step(restored);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(restored.events.filter(event => event.kind === 'Condensation')).toHaveLength(1);
    expect(View.fromEvents(restored.events).events.map(event => event.kind)).toEqual(['MessageEvent', 'ActionEvent', 'ObservationEvent']);
  });

  it('rejects mixed reset calls without dropping another tool or clearing history', async () => {
    const reply = reset();
    reply.message.tool_calls!.push({ ...reply.message.tool_calls![0]!, id: 'think-call', name: 'think', arguments: '{"thought":"still working"}' });
    const state = new ConversationState({ events: [user('keep this task')] });
    await new Agent({ llm: { profile, complete: async () => reply }, tools: [ThinkTool.create()], condenser: new AgentResetCondenser() }).step(state);
    expect(state.events.filter(event => event.kind === 'Condensation')).toHaveLength(0);
    expect(state.pendingActions()).toHaveLength(0);
    expect(state.events.find(event => event.kind === 'ObservationEvent' && event.tool_name === 'condense')).toMatchObject({ observation: { is_error: true } });
    expect(state.events.some(event => event.kind === 'ObservationEvent' && event.tool_name === 'think')).toBe(true);
  });

  it('warns against explicit main input tokens but never proactively condenses or blocks the main call', async () => {
    const { state, restore } = persisted([user('task')]);
    const complete = vi.fn(async (_messages: readonly Message[]) => answer());
    const getTokenCount = vi.fn(async () => 450_000);
    const auxiliary = { profile: { ...profile, profileId: 'hard' }, complete: vi.fn(async () => answer('summary')) };
    const agent = new Agent({ llm: { profile, complete, getTokenCount, effectiveMaxInputTokens: 1_000_000 },
      condenser: new AgentResetCondenser(), hardCondenser: new LLMSummarizingCondenser({ llm: auxiliary }), systemPrompt: 'fixed' });
    await agent.step(state);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(auxiliary.complete).not.toHaveBeenCalled();
    expect(text(complete.mock.calls[0]![0])).toContain('90%');
    expect(state.events.some(event => event.kind === 'Condensation')).toBe(false);
    await agent.step(restore());
    expect(state.events.filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === 'agent_context_warning')).toHaveLength(1);
  });

  it('does not consume a user message that arrives while computing a warning', async () => {
    const state = new ConversationState({ events: [user('original task')] });
    let measured = false;
    const complete = vi.fn(async () => reset({ message_to_future_self: '' }));
    const agent = new Agent({ llm: { profile, complete, getTokenCount: async () => {
      if (!measured) { measured = true; await state.appendEventAsync(user('arrived while counting')); }
      return 320_000;
    } }, condenser: new AgentResetCondenser() });
    await agent.step(state);
    const view = View.fromEvents(state.events);
    expect(JSON.stringify(view.events)).toContain('arrived while counting');
    expect(JSON.stringify(view.events)).not.toContain('original task');
    expect(view.events.find(event => event.kind === 'ObservationEvent')).toMatchObject({ observation: { message_to_future_self: '' } });
  });

  it('rejects duplicate condense calls and invalid payloads without creating a reset intent', async () => {
    for (const reply of [reset({ message_to_future_self: 123 }), reset()]) {
      if (reply.message.tool_calls![0]!.arguments === '{}') {
        reply.message.tool_calls!.push({ ...reply.message.tool_calls![0]!, id: 'second-condense-call' });
      }
      const state = new ConversationState({ events: [user('preserve task')] });
      await new Agent({ llm: { profile, complete: async () => reply }, condenser: new AgentResetCondenser() }).step(state);
      expect(state.events.some(event => event.kind === 'CondensationRequest' || event.kind === 'Condensation')).toBe(false);
      expect(state.pendingActions()).toHaveLength(0);
      expect(JSON.stringify(View.fromEvents(state.events).events)).toContain('preserve task');
    }
  });

  it('starts another warning cycle only after a committed reset, and preserves subsequent genuine tool calls', async () => {
    const state = new ConversationState({ events: [user('initial task')] });
    const llm = { profile, getTokenCount: async () => 360_000, complete: vi.fn(async () => reset()) };
    const agent = new Agent({ llm, condenser: new AgentResetCondenser() });
    await agent.step(state);
    await state.appendEventAsync(user('next task'));
    await agent.step(state);
    expect(state.events.filter(event => event.kind === 'Condensation')).toHaveLength(2);
    expect(state.events.filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === 'agent_context_warning')).toHaveLength(2);
    expect(View.fromEvents(state.events).events.map(event => event.kind)).toEqual(['MessageEvent', 'ActionEvent', 'ObservationEvent']);
    const reconstructed = new Agent({ llm, condenser: new AgentResetCondenser(), tools: agent.tools });
    expect(reconstructed.tools.filter(tool => tool.name === 'condense')).toHaveLength(1);
    expect(new Agent({ llm, tools: agent.tools }).tools.some(tool => tool.name === 'condense')).toBe(false);
  });

  it('rejects host condensation without claiming an agent called its tool', async () => {
    const complete = vi.fn(async () => answer());
    const conversation = new LocalConversation({ agent: new Agent({ llm: { profile, complete }, condenser: new AgentResetCondenser() }) });
    conversation.sendMessage('task');
    await expect(conversation.condense()).rejects.toThrow(/agent.*condense/i);
    expect(conversation.state.events).toHaveLength(1);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('explicit hard fallback only on actual context-window errors', () => {
  it('uses direct full-view hard reset and preserves unconsumed text/media and late arrivals', async () => {
    const { state, restore } = persisted([user('old consumed work')]);
    await new Agent({ llm: { profile, complete: async () => answer('old answer') } }).step(state);
    const image = messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [
      { type: 'text', text: 'new task not answered' }, { type: 'image', image_urls: ['https://example.invalid/image.png'] },
    ] } });
    await state.appendEventAsync(image);
    let calls = 0;
    const seen: Message[][] = [];
    const complete = vi.fn(async (messages: readonly Message[]) => {
      seen.push([...messages]);
      if (calls++ === 0) { await state.appendEventAsync(user('arrived during rejected request')); throw new LLMContextWindowExceedError('full'); }
      return answer();
    });
    const summary = vi.fn(async () => { await state.appendEventAsync(user('arrived during summary')); return answer('summary of old work'); });
    const hard = new LLMSummarizingCondenser({ llm: { profile: { ...profile, profileId: 'emergency' }, complete: summary }, keepFirst: 2 });
    const ordinary = vi.spyOn(hard, 'condense');
    const agent = new Agent({ llm: { profile, complete }, condenser: new AgentResetCondenser(), hardCondenser: hard });
    await agent.step(state);
    expect(ordinary).not.toHaveBeenCalled();
    expect(summary).toHaveBeenCalledTimes(1);
    const restored = restore();
    const view = View.fromEvents(restored.events);
    expect(view.events[0]).toMatchObject({ kind: 'MessageEvent', source: 'environment' });
    expect(JSON.stringify(view.events[0])).toContain('context-window error');
    expect(view.events[1]).toMatchObject({ kind: 'CondensationSummaryEvent', summary: 'summary of old work' });
    expect(view.events.filter(event => event.kind === 'ActionEvent')).toHaveLength(0);
    expect(view.events.find(event => event.id === image.id)).toEqual(image);
    expect(JSON.stringify(view.events)).toContain('arrived during rejected request');
    expect(JSON.stringify(view.events)).toContain('arrived during summary');
    await agent.step(restored);
    expect(text(seen[1]!)).not.toContain('old consumed work');
    expect(text(seen[1]!)).toContain('new task not answered');
    expect(restored.stats.usage_to_metrics.condenser?.records).toHaveLength(1);
  });

  it.each([new LLMMalformedConversationHistoryError('bad history'), new Error('HTTP 413 upload limit'), new Error('rate limit')])(
    'does not summarize on unrelated failure %s', async error => {
      const summary = vi.fn(async () => answer('summary'));
      const agent = new Agent({ llm: { profile, complete: async () => { throw error; } }, condenser: new AgentResetCondenser(),
        hardCondenser: new LLMSummarizingCondenser({ llm: { profile, complete: summary } }) });
      await expect(agent.step(new ConversationState({ events: [user('task')] }))).rejects.toBe(error);
      expect(summary).not.toHaveBeenCalled();
    },
  );

  it('propagates actual overflow without an explicitly configured fallback', async () => {
    const error = new LLMContextWindowExceedError('full');
    const state = new ConversationState({ events: [user('task')] });
    await expect(new Agent({ llm: { profile, complete: async () => { throw error; } }, condenser: new AgentResetCondenser() }).step(state)).rejects.toBe(error);
    expect(state.events.some(event => event.kind === 'Condensation')).toBe(false);
  });

  it('bounds repeated provider rejection and retains wrapped failure accounting', async () => {
    const failure = new LLMResponseError({ usage: { promptTokens: 42 } }, new LLMContextWindowExceedError('full'));
    const state = new ConversationState({ events: [user('old task')] });
    await new Agent({ llm: { profile, complete: async () => answer() } }).step(state);
    const summary = vi.fn(async () => answer('summary'));
    const agent = new Agent({ llm: { profile, complete: async () => { throw failure; } }, condenser: new AgentResetCondenser(),
      hardCondenser: new LLMSummarizingCondenser({ llm: { profile: { ...profile, profileId: 'hard' }, complete: summary } }) });
    await agent.step(state);
    await expect(agent.step(state)).rejects.toThrow(/context|recovery/i);
    expect(summary).toHaveBeenCalledTimes(1);
    expect(state.stats.usage_to_metrics['profile:main']?.known_token_usage.prompt_tokens).toBe(84);
  });
});
