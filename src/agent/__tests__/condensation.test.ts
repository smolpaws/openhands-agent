import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import { ConversationState } from '../../conversation/state.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { NoOpCondenser, type Condenser } from '../../context/condenser.js';
import { LLMSummarizingCondenser } from '../../context/llm-summarizing-condenser.js';
import { AgentContext } from '../../context/agent-context.js';
import { ThinkTool } from '../../tool/builtins.js';
import { View } from '../../context/view.js';
import { condensationSchema, condensationRequestSchema, messageEventSchema, type Event } from '../../event/index.js';
import { LLMResponseError, type LLMClient } from '../../llm/client.js';
import { LLMContextWindowExceedError, LLMMalformedConversationHistoryError } from '../../llm/exceptions.js';
import { llmProfileSchema, messageSchema, type Message } from '../../llm/index.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'test-model' });
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: text } });
const reply = () => ({ usage: null, message: messageSchema.parse({ role: 'assistant', content: 'continued' }) });
const summary = (view: View) => condensationSchema.parse({
  forgotten_event_ids: view.events.slice(0, -1).map(event => event.id), summary: 'Earlier work', summary_offset: 0,
});

describe('pinned Python agent condensation recovery', () => {
  it('awaits an asynchronous condenser and persists its event before making another main completion', async () => {
    const store = new InMemoryFileStore();
    const state = new ConversationState({ eventLog: new EventLog(store) });
    await state.appendEventsAsync([user('old work'), user('continue')]);
    const complete = vi.fn(async () => reply());
    const condenser: Condenser = {
      condense: async view => { await Promise.resolve(); return summary(view); },
      handlesCondensationRequests: () => true,
    };
    const history = structuredClone(state.events);
    const emitted = await new Agent({ llm: { profile, complete }, condenser }).step(state);
    expect(complete).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('Condensation');
    const restored = new ConversationState({ eventLog: new EventLog(store) });
    expect(restored.events.slice(0, history.length)).toEqual(history);
    expect(View.fromEvents(restored.events).events.map(event => event.kind)).toEqual(['CondensationSummaryEvent', 'MessageEvent']);
  });

  it('resolves runtime model metadata before proactive condensation', async () => {
    const order: string[] = [];
    const llm: LLMClient = {
      profile,
      resolveRuntimeMetadata: async () => { order.push('metadata'); },
      complete: async () => { order.push('complete'); return reply(); },
    };
    const condenser: Condenser = { condense: view => { order.push('condense'); return view; } };
    await new Agent({ llm, condenser }).step(new ConversationState({ events: [user('work')] }));
    expect(order).toEqual(['metadata', 'condense', 'complete']);
  });

  it.each([LLMContextWindowExceedError, LLMMalformedConversationHistoryError])(
    'requests condensation after %s, then continues with a reduced view on later steps',
    async ErrorType => {
      const failure = new ErrorType('provider rejected input');
      const seen: Message[][] = [];
      const complete = vi.fn(async (messages: readonly Message[]) => {
        seen.push([...messages]);
        if (seen.length === 1) throw failure;
        return reply();
      });
      const condenser: Condenser = {
        handlesCondensationRequests: () => true,
        condense: view => view.unhandledCondensationRequest ? summary(view) : view,
      };
      const state = new ConversationState({ events: [user('old work'), user('current task')] });
      const original = structuredClone(state.events);
      const agent = new Agent({ llm: { profile, complete }, condenser });
      expect((await agent.step(state)).map(event => event.kind)).toEqual(['CondensationRequest']);
      expect(complete).toHaveBeenCalledTimes(1);
      expect((await agent.step(state)).map(event => event.kind)).toEqual(['Condensation']);
      expect(complete).toHaveBeenCalledTimes(1);
      await agent.step(state);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(seen[1])).toContain('Earlier work');
      expect(JSON.stringify(seen[1])).not.toContain('old work');
      expect(state.events.slice(0, original.length)).toEqual(original);
    },
  );

  it.each([null, new NoOpCondenser()])('propagates overflow when no request-handling condenser exists', async condenser => {
    const failure = new LLMContextWindowExceedError('too much input');
    const complete = vi.fn(async () => { throw failure; });
    const state = new ConversationState({ events: [user('work')] });
    await expect(new Agent({ llm: { profile, complete }, condenser }).step(state)).rejects.toBe(failure);
    expect(state.events.some(event => event.kind === 'CondensationRequest')).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('retains received usage metadata when a wrapped overflow requests recovery', async () => {
    const cause = new LLMContextWindowExceedError('overflow');
    const failure = new LLMResponseError({ usage: { promptTokens: 20 }, responseId: 'failed-response' }, cause);
    const condenser: Condenser = { condense: view => view, handlesCondensationRequests: () => true };
    const state = new ConversationState({ events: [user('work')] });
    await new Agent({ llm: { profile, complete: async () => { throw failure; } }, condenser }).step(state);
    expect(state.stats.usage_to_metrics['profile:main']?.records).toHaveLength(1);
    expect(state.stats.usage_to_metrics['profile:main']?.known_token_usage.prompt_tokens).toBe(20);
    expect(state.events.at(-1)?.kind).toBe('CondensationRequest');
  });

  it('does not turn an unrelated provider failure into condensation', async () => {
    const failure = new Error('HTTP 413 upload limit');
    const condenser: Condenser = { condense: view => view, handlesCondensationRequests: () => true };
    const state = new ConversationState({ events: [user('work')] });
    await expect(new Agent({ llm: { profile, complete: async () => { throw failure; } }, condenser }).step(state)).rejects.toBe(failure);
    expect(state.events.some(event => event.kind === 'CondensationRequest')).toBe(false);
  });
});


describe('condensation host integration', () => {
  it('returns the emitted summary event even if input arrives during persistence', async () => {
    const state = new ConversationState({ events: [user('old'), user('current')] });
    const append = state.appendEventAsync.bind(state);
    vi.spyOn(state, 'appendEventAsync').mockImplementation(async (event: Event) => {
      const result = await append(event);
      if (event.kind === 'Condensation') await append(user('later arrival'));
      return result;
    });
    const emitted = await new Agent({ llm: { profile, complete: async () => reply() },
      condenser: { condense: view => summary(view) },
    }).step(state);
    expect(emitted.map(event => event.kind)).toEqual(['Condensation']);
    expect(state.events.at(-1)).toMatchObject({ kind: 'MessageEvent', llm_message: { content: [{ text: 'later arrival' }] } });
  });

  it('counts the actual fixed system/context and usable tools with the main client', async () => {
    const getTokenCount = vi.fn(async (_messages: readonly Message[], _tools?: readonly unknown[]) => 10);
    const main = { profile, effectiveMaxInputTokens: 1000, getTokenCount, complete: vi.fn(async (_messages: readonly Message[]) => reply()) };
    const auxiliary = { profile: { ...profile, profileId: 'summary' }, complete: vi.fn(async () => reply()) };
    const tools = [ThinkTool.create()];
    const state = new ConversationState({ events: [user('current task')] });
    await new Agent({ llm: main, tools, systemPrompt: 'fixed instructions',
      context: new AgentContext({ systemMessageSuffix: 'full host context', currentDatetime: null }),
      condenser: new LLMSummarizingCondenser({ llm: auxiliary }),
    }).step(state);
    expect(getTokenCount).toHaveBeenCalledExactlyOnceWith(main.complete.mock.calls[0]?.[0], tools);
    expect(JSON.stringify(getTokenCount.mock.calls)).toContain('fixed instructions');
    expect(JSON.stringify(getTokenCount.mock.calls)).toContain('full host context');
    expect(auxiliary.complete).not.toHaveBeenCalled();
  });

  it('persists each summary attempt once under condenser usage with its own profile across restore', async () => {
    const store = new InMemoryFileStore();
    const state = new ConversationState({ eventLog: new EventLog(store) });
    await state.appendEventsAsync([user('one'), user('two'), condensationRequestSchema.parse({})]);
    const main = { profile, complete: vi.fn(async () => reply()) };
    const auxiliaryProfile = { ...profile, profileId: 'summary', model: 'summary-model' };
    const complete = vi.fn(async () => {
      if (complete.mock.calls.length === 1) throw new LLMResponseError({ usage: { promptTokens: 30 }, responseId: 'repeated' }, new Error('summary failed'));
      if (complete.mock.calls.length === 2) throw new Error('network unavailable');
      return { ...reply(), responseId: 'repeated', usage: { promptTokens: 10, completionTokens: 2 } };
    });
    const condenser = new LLMSummarizingCondenser({ llm: { profile: auxiliaryProfile, complete }, keepFirst: 0 });
    const events = await new Agent({ llm: main, condenser }).step(state);
    expect(events.map(event => event.kind)).toEqual(['Condensation']);
    expect(main.complete).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(3);
    const restored = new ConversationState({ eventLog: new EventLog(store) });
    const metrics = restored.stats.usage_to_metrics.condenser!;
    expect(metrics.records).toHaveLength(3);
    expect(new Set(metrics.records.map(record => record.record_id)).size).toBe(3);
    expect(metrics.records.every(record => record.profile_id === 'summary' && record.model === 'summary-model')).toBe(true);
    expect(metrics.known_token_usage.prompt_tokens).toBe(40);
    expect(metrics.accumulated_token_usage.prompt_tokens).toBeNull();
    expect(metrics.records[1]?.usage).toBeNull();
    expect(metrics.records[1]?.cost).toBeNull();
    expect(restored.stats).toEqual(state.stats);
  });

  it('projects unanchored legacy reasoning against the main binding for a distinct condenser', async () => {
    const legacy = messageEventSchema.parse({ source: 'agent', llm_message: {
      role: 'assistant', content: 'visible reasoning result', reasoning_content: 'plain reasoning',
      thinking_blocks: [{ type: 'thinking', thinking: 'opaque thought', signature: 'private-signature' }],
      responses_reasoning_item: { id: 'reason', encrypted_content: 'private-cipher' },
    } });
    const state = new ConversationState({ events: [user('task'), legacy] });
    const original = structuredClone(state.events);
    const condenser: Condenser = { condense: (view, _llm, context) => {
      const same = context!.projectEvents!(view.events, profile);
      const other = context!.projectEvents!(view.events, { ...profile, profileId: 'summary' });
      expect(JSON.stringify(same)).toContain('private-signature');
      expect(JSON.stringify(other)).not.toContain('private-signature');
      expect(JSON.stringify(other)).not.toContain('private-cipher');
      expect(JSON.stringify(other)).toContain('plain reasoning');
      expect(JSON.stringify(other)).toContain('visible reasoning result');
      return summary(view);
    } };
    await new Agent({ llm: { profile, complete: async () => reply() }, condenser }).step(state);
    expect(state.events.slice(0, original.length)).toEqual(original);
  });
});
