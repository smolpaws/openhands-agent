import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent.js';
import { AgentResetCondenser } from '../../context/agent-reset-condenser.js';
import { ConversationState } from '../../conversation/state.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { condensationSchema, messageEventSchema, type Event } from '../../event/index.js';
import { llmProfileSchema, messageSchema, type Message } from '../../llm/index.js';
import { createLlmUsageEvent } from '../../llm/metrics.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'gpt-5', maxInputTokens: 1000 });
const user = () => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: 'Continue.' } });
const reply = (promptTokens: number | undefined = 750) => ({
  message: messageSchema.parse({ role: 'assistant', content: 'Continuing.' }),
  usage: { ...(promptTokens === undefined ? {} : { promptTokens }), completionTokens: 9000,
    totalTokens: 10000, cacheReadTokens: promptTokens ?? 0 },
});
const warnings = (messages: readonly Message[]) => messages.flatMap(m => m.content.flatMap(c =>
  c.type === 'text' && c.text.startsWith('Context warning:') ? [c.text] : []));
const stages = (state: ConversationState) => state.events.filter(e => e.kind === 'ConversationStateUpdateEvent' && e.key === 'agent_context_warning');

function fixture(counts: readonly (number | undefined)[] = [750]) {
  const store = new InMemoryFileStore();
  let state = new ConversationState({ eventLog: new EventLog(store), events: [user()] });
  const seen: Message[][] = [];
  let index = 0;
  const complete = vi.fn(async (messages: readonly Message[]) => {
    seen.push([...messages]); return reply(counts[Math.min(index++, counts.length - 1)]);
  });
  const getTokenCount = vi.fn(async () => null);
  const agent = new Agent({ llm: { profile, complete, getTokenCount }, condenser: new AgentResetCondenser() });
  return { agent, seen, complete, getTokenCount, state: () => state,
    restore: () => { state = new ConversationState({ eventLog: new EventLog(store) }); } };
}

describe('provider input usage drives advisory context warnings', () => {
  it('sends each newly crossed stage once, including after restore, using inclusive input rather than totals or cache misses', async () => {
    const f = fixture([750, 750, 800, 800, 900, 900, 900]);
    for (let i = 0; i < 7; i++) {
      if (i === 2 || i === 4) f.restore();
      await f.agent.step(f.state());
    }
    expect(f.seen.map(warnings).map(ws => ws.map(w => w.match(/the (\d+)%/)?.[1]))).toEqual([
      [], ['75'], [], ['80'], [], ['90'], [],
    ]);
    expect(stages(f.state()).map(e => e.kind === 'ConversationStateUpdateEvent' ? e.value : null)).toMatchObject([
      { input_tokens: 750, input_limit: 1000, threshold: 0.75 },
      { input_tokens: 800, input_limit: 1000, threshold: 0.8 },
      { input_tokens: 900, input_limit: 1000, threshold: 0.9 },
    ]);
    expect(f.getTokenCount).toHaveBeenCalledTimes(1); // First request only.
    expect(f.state().events.some(e => e.kind === 'Condensation')).toBe(false);
  });

  it('jumps to only the highest crossed stage and ignores auxiliary usage even with the same profile', async () => {
    const f = fixture([870, 870, 870]);
    await f.agent.step(f.state());
    await f.state().appendEventAsync(createLlmUsageEvent(profile, reply(5000), {
      startedAt: 0, completedAt: 1, usageId: 'condenser',
    }));
    await f.agent.step(f.state());
    await f.agent.step(f.state());
    expect(f.seen.map(warnings).map(ws => ws.map(w => w.match(/the (\d+)%/)?.[1]))).toEqual([[], ['85'], []]);
    expect(stages(f.state())).toHaveLength(1);
  });

  it('retries a pending warning after a failed request but stops showing it after a successful response', async () => {
    const f = fixture();
    await f.agent.step(f.state());
    f.complete.mockImplementationOnce(async messages => { f.seen.push([...messages]); throw new Error('Network failed'); });
    await expect(f.agent.step(f.state())).rejects.toThrow('Network failed');
    f.restore();
    await f.agent.step(f.state());
    await f.agent.step(f.state());
    expect(f.seen.map(warnings).map(ws => ws.length)).toEqual([0, 1, 1, 0]);
    expect(stages(f.state())).toHaveLength(1);
  });

  it('rearms after committed reset and does not reuse stale pre-reset usage', async () => {
    const f = fixture();
    await f.agent.step(f.state());
    await f.agent.step(f.state());
    await f.state().appendEventAsync(condensationSchema.parse({ forgotten_event_ids: [] }));
    f.restore();
    await f.agent.step(f.state());
    await f.agent.step(f.state());
    expect(f.seen.map(warnings).map(ws => ws.length)).toEqual([0, 1, 0, 1]);
    expect(stages(f.state())).toHaveLength(2);
  });

  it('retains one-shot delivery across EventLog restore even if dispatch failed after success accounting', async () => {
    const f = fixture();
    await f.agent.step(f.state());
    const append = f.state().appendEventsAsync.bind(f.state());
    vi.spyOn(f.state(), 'appendEventsAsync').mockImplementation(async (events: readonly Event[]) => {
      if (events.some(e => e.kind === 'MessageEvent' && e.source === 'agent')) throw new Error('Dispatch persistence failed');
      return append(events);
    });
    await expect(f.agent.step(f.state())).rejects.toThrow('Dispatch persistence failed');
    f.restore();
    await f.agent.step(f.state());
    expect(f.seen.map(warnings).map(ws => ws.length)).toEqual([0, 1, 0]);
    expect(stages(f.state())).toHaveLength(1);
  });
});
