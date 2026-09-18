import { describe, expect, it, vi } from 'vitest';

import * as context from '../index.js';
import { condensationSchema, condensationSummaryEventSchema, messageEventSchema, systemPromptEventSchema, type LLMConvertibleEvent } from '../../event/index.js';
import { llmProfileSchema, messageSchema, textContent, type Message } from '../../llm/index.js';
import type { LLMClient, LLMCompletionResponse } from '../../llm/client.js';

// PORT: pinned tests/sdk/context/condenser/{test_llm_summarizing_condenser,test_rolling_condenser,test_utils}.py.
// Provider-native transports are selected by the client/profile, never by the condenser.
const profile = llmProfileSchema.parse({ profileId: 'summary', providerId: 'openai', model: 'fixture' });
const user = (text: string) => messageEventSchema.parse({ source: 'user', llm_message: { role: 'user', content: [textContent(text)] } });
const events = (n: number) => Array.from({ length: n }, (_, i) => user(`Event ${i}`));
const response = (text = 'Summary of forgotten events'): LLMCompletionResponse => ({ message: messageSchema.parse({ role: 'assistant', content: [textContent(text)] }), usage: { promptTokens: 20, completionTokens: 5 }, responseId: 'summary-response' });
const mockLlm = (extra: Partial<LLMClient> = {}) => ({ profile, complete: vi.fn(async () => response()), ...extra });
const countedLlm = (limit?: number) => mockLlm({ ...(limit === undefined ? {} : { effectiveMaxInputTokens: limit }), getTokenCount: vi.fn(async (messages: readonly Message[]) => messages.reduce((n, message) => n + message.content.length * 10, 0)) });
const condenser = (llm: LLMClient, options = {}) => new context.LLMSummarizingCondenser({ llm, ...options });
const condensed = async (value: ReturnType<context.Condenser['condense']>) => {
  const result = await value;
  expect(result).toHaveProperty('kind', 'Condensation');
  if (!('kind' in result)) throw new Error('Expected Condensation');
  return result;
};

describe('LLMSummarizingCondenser pinned behavior with explicit target policy', () => {
  // DEV-SDK-011: target defaults intentionally differ from the pinned Python values.
  it('uses 1000/2 for both class and standard factory defaults', () => {
    const llm = mockLlm();
    expect(condenser(llm)).toMatchObject({ llm, maxSize: 1000, keepFirst: 2, maxTokens: null, minimumProgress: 0.1, hardContextResetMaxRetries: 5, hardContextResetContextScaling: 0.8 });
    expect(context.defaultCondenser(llm)).toMatchObject({ maxSize: 1000, keepFirst: 2 });
    expect(condenser(llm).handlesCondensationRequests()).toBe(true);
  });

  it.each(['class', 'factory'] as const)('starts default %s event pressure only above 1000 events', async kind => {
    const llm = mockLlm();
    const c = kind === 'class' ? condenser(llm) : context.defaultCondenser(llm);
    expect(await c.condensationRequirement(new context.View(events(1000)))).toBeNull();
    expect(await c.condensationRequirement(new context.View(events(1001)))).toBe('soft');
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it.each([{ maxSize: 0 }, { maxSize: 10, keepFirst: 4 }, { keepFirst: -1 }, { minimumProgress: 0 }, { minimumProgress: 1 }, { hardContextResetMaxRetries: 0 }, { hardContextResetContextScaling: 1 }])('rejects invalid configuration %j', options => {
    expect(() => condenser(mockLlm(), options)).toThrow(RangeError);
  });

  // Review regression: the pinned direct class has int | None without gt=0.
  // Profile-first settings validate positive budgets separately; do not tighten this constructor.
  it.each([0, -1])('preserves the pinned direct-class token cap %s', async maxTokens => {
    const c = condenser(mockLlm(), { maxTokens });
    expect(c.maxTokens).toBe(maxTokens);
    expect(c.effectiveMaxTokens(countedLlm(100))).toBe(maxTokens);
    expect(await c.getCondensationReasons(new context.View(events(1)), countedLlm())).toEqual(new Set(['tokens']));
  });

  it('returns the same untouched view when no pressure exists', async () => {
    const llm = mockLlm(), view = new context.View(events(10));
    const c = condenser(llm, { maxSize: 10, keepFirst: 3 });
    expect(await c.condensationRequirement(view)).toBeNull();
    expect(await c.condense(view)).toBe(view);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('uses strict event thresholds and half-sized event targets', async () => {
    const llm = mockLlm(), original = events(11), view = new context.View(original);
    const c = condenser(llm, { maxSize: 10, keepFirst: 3 });
    expect(await c.getCondensationReasons(view)).toEqual(new Set(['events']));
    expect(await c.condensationRequirement(view)).toBe('soft');
    const result = await condensed(c.condense(view));
    expect(result.forgotten_event_ids).toEqual(new Set(original.slice(3, 10).map(e => e.id)));
    expect(result).toMatchObject({ summary_offset: 3, summary: 'Summary of forgotten events', llm_response_id: 'summary-response' });
    expect(view.events).toEqual(original);
    expect(llm.complete.mock.calls[0]).toHaveLength(1);
  });

  it('includes previous summaries in the next summary prompt', async () => {
    const llm = mockLlm();
    const original = events(13);
    original.splice(3, 0, condensationSummaryEventSchema.parse({ summary: 'Previous summary content' }) as typeof original[number]);
    await condenser(llm, { maxSize: 10, keepFirst: 3 }).getCondensation(new context.View(original));
    expect(JSON.stringify(llm.complete.mock.calls)).toContain('Previous summary content');
  });

  it('uses the first response content only and preserves missing summary', async () => {
    const llm = mockLlm({ complete: vi.fn(async () => ({ ...response(), message: messageSchema.parse({ role: 'assistant', content: [] }) })) });
    const result = await condensed(condenser(llm, { maxSize: 10, keepFirst: 3 }).condense(new context.View(events(11))));
    expect(result.summary).toBeNull();
    expect(result.summary_offset).toBe(3);
  });

  it('treats requests as hard and halves the current view', async () => {
    const original = events(10), c = condenser(mockLlm());
    const view = new context.View(original, true);
    expect(await c.condensationRequirement(view)).toBe('hard');
    const result = await condensed(c.condense(view));
    expect(result.forgotten_event_ids).toEqual(new Set(original.slice(2, 8).map(e => e.id)));
  });

  it.each([[100, 200, 100], [200, 100, 100], [null, 100, 100]])('takes strictest configured %s or agent %s token ceiling', async (maxTokens, agentLimit, effective) => {
    const c = condenser(mockLlm(), { maxTokens });
    const llm = countedLlm(agentLimit);
    expect(await c.condensationRequirement(new context.View(events(effective / 10)), llm)).toBeNull();
    expect(await c.condensationRequirement(new context.View(events(effective / 10 + 1)), llm)).toBe('hard');
  });

  it('resolves provider runtime metadata before reading its effective limit', async () => {
    let limit: number | null = null;
    const llm = countedLlm();
    Object.defineProperty(llm, 'effectiveMaxInputTokens', { get: () => limit });
    Object.assign(llm, { resolveRuntimeMetadata: vi.fn(async () => { limit = 20; }) });
    expect(await condenser(mockLlm()).condensationRequirement(new context.View(events(3)), llm)).toBe('hard');
  });

  it('does not pretend an absent or unknown counter is zero or use the summary model for agent counts', async () => {
    const c = condenser(countedLlm(1), { maxTokens: 1 });
    expect(await c.condensationRequirement(new context.View(events(3)))).toBeNull();
    expect(await c.condensationRequirement(new context.View(events(3)), mockLlm({ getTokenCount: async () => null }))).toBeNull();
    expect(await c.condensationRequirement(new context.View(events(3), true), mockLlm({ getTokenCount: async () => null }))).toBe('hard');
  });

  it('chooses the strictest cut among request, event, and token reasons', async () => {
    const original = events(12), view = new context.View(original, true);
    const c = condenser(mockLlm(), { maxSize: 8, keepFirst: 1, maxTokens: 100 });
    expect(await c.getCondensationReasons(view, countedLlm())).toEqual(new Set(['request', 'tokens', 'events']));
    const result = await condensed(c.condense(view, countedLlm()));
    expect(result.forgotten_event_ids).toEqual(new Set(original.slice(1, 10).map(e => e.id)));
  });

  it('rounds the forgotten range outwards to safe atomic boundaries', async () => {
    const original = events(11), view = new context.View(original);
    Object.defineProperty(view, 'manipulationIndices', { value: { findNext: (at: number) => [0, 4, 11].find(i => i >= at)! } });
    const result = await condensed(condenser(mockLlm(), { maxSize: 10, keepFirst: 3 }).condense(view));
    expect(result.summary_offset).toBe(4);
    expect(result.forgotten_event_ids).toEqual(new Set(original.slice(4).map(e => e.id)));
  });

  it('defers soft condensation with no safe range and succeeds once a later range exists', async () => {
    const llm = mockLlm(), c = condenser(llm, { maxSize: 6, keepFirst: 1 });
    const first = new context.View(events(7));
    Object.defineProperty(first, 'manipulationIndices', { value: { findNext: () => 7 } });
    expect(await c.condense(first)).toBe(first);
    expect(llm.complete).not.toHaveBeenCalled();
    const later = new context.View([...first.events, ...events(3)]);
    await condensed(c.condense(later));
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('enforces minimum progress before spending a summary call', async () => {
    const llm = mockLlm(), view = new context.View(events(11));
    const c = condenser(llm, { maxSize: 10, keepFirst: 3, minimumProgress: 0.9 });
    await expect(c.getCondensation(view)).rejects.toThrow('minimum progress');
    expect(await c.condense(view)).toBe(view);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('wraps summary transport failures with the original cause and defers soft failures', async () => {
    const error = new Error('provider unavailable'), llm = mockLlm({ complete: vi.fn(async () => { throw error; }) });
    const c = condenser(llm, { maxSize: 10, keepFirst: 3 }), view = new context.View(events(11));
    await expect(c.getCondensation(view)).rejects.toMatchObject({ name: 'NoCondensationAvailableError', cause: error });
    expect(await c.condense(view)).toBe(view);
  });

  it('hard reset covers the full view at offset zero, first untruncated then scaled, with five TOTAL attempts', async () => {
    const error = new Error('too long'), llm = mockLlm({ complete: vi.fn(async () => { throw error; }) });
    const original = [user('A'.repeat(1000)), user('B'.repeat(25))], view = new context.View(original);
    const c = condenser(llm), before = JSON.stringify(original);
    expect(await c.hardContextReset(view)).toBeNull();
    expect(llm.complete).toHaveBeenCalledTimes(5);
    const prompts = llm.complete.mock.calls.map(call => JSON.stringify(call[0]));
    expect(prompts[0]).toContain('A'.repeat(497));
    expect(prompts[1]!.length).toBeLessThan(prompts[0]!.length);
    expect(prompts[2]!.length).toBeLessThan(prompts[1]!.length);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('preserves pinned zero-limit retry behavior when aggressive scaling reaches zero', async () => {
    // Executed against original Python 50080b58d: an 88-character preview with
    // scaling 0.1 gives [None, 8, 0, 0, 0]; maybe_truncate(0) means untruncated.
    // This inherited edge is intentional parity, not a promise of monotonic shrinking.
    const complete = vi.fn(async (_messages: readonly Message[]): Promise<LLMCompletionResponse> => { throw new Error('Synthetic failure'); });
    const c = condenser(mockLlm({ complete }), { hardContextResetContextScaling: 0.1 });
    const generate = vi.spyOn(c, 'generateCondensation');
    expect(await c.hardContextReset(new context.View([user('public fixture '.repeat(4))]))).toBeNull();
    expect(generate.mock.calls.map(call => call[2])).toEqual([null, 8, 0, 0, 0]);
    const prompts = complete.mock.calls.map(([messages]) => {
      const first = messages[0]!.content[0]!;
      if (first.type !== 'text') throw new Error('Expected text summary prompt');
      return first.text;
    });
    expect(prompts.map(prompt => [...prompt].length)).toEqual([2120, 2040, 2120, 2120, 2120]);
    expect(prompts.slice(2)).toEqual([prompts[0], prompts[0], prompts[0]]);
  });

  it('uses a successful full-view reset when an explicitly requested normal summary fails', async () => {
    const llm = mockLlm({ complete: vi.fn().mockRejectedValueOnce(new Error('normal summary failed')).mockResolvedValue(response('Recovered')) });
    const original = events(10), result = await condensed(condenser(llm).condense(new context.View(original, true)));
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result.forgotten_event_ids).toEqual(new Set(original.map(e => e.id)));
    expect(result).toMatchObject({ summary_offset: 0, summary: 'Recovered' });
  });

  it('rethrows the original unavailable error after all hard-reset attempts fail', async () => {
    const llm = mockLlm({ complete: vi.fn(async () => { throw new Error('summary failed'); }) });
    await expect(condenser(llm).condense(new context.View(events(10), true))).rejects.toBeInstanceOf(context.NoCondensationAvailableError);
    expect(llm.complete).toHaveBeenCalledTimes(6); // One normal attempt plus five full-view attempts.
  });

  it('awaits and reports each summary attempt exactly once using the independent summary profile', async () => {
    const llm = mockLlm({ complete: vi.fn().mockRejectedValueOnce(new Error('first failed')).mockResolvedValue(response()) });
    const records: context.CondenserCompletionAttempt[] = [];
    const projection = vi.fn((items: readonly LLMConvertibleEvent[]) => items);
    const onCompletion = vi.fn(async (attempt: context.CondenserCompletionAttempt) => { await Promise.resolve(); records.push(attempt); });
    await condensed(condenser(llm).condense(new context.View(events(10), true), countedLlm(), { onCompletion, projectEvents: projection }));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ llm, error: expect.any(Error), startedAt: expect.any(Number), completedAt: expect.any(Number) });
    expect(records[1]).toMatchObject({ llm, response: { responseId: 'summary-response' } });
    expect(projection).toHaveBeenCalledWith(expect.any(Array), profile);
  });

  it('does not forget arrivals added while a summary completion is pending', async () => {
    let finish!: (value: LLMCompletionResponse) => void;
    const pending = new Promise<LLMCompletionResponse>(resolve => { finish = resolve; });
    const llm = mockLlm({ complete: () => pending });
    const original = events(3), ids = original.map(event => event.id);
    const job = condenser(llm).generateCondensation(original, 0);
    original.push(user('New arrival never seen by the summary request'));
    finish(response());
    const result = await job;
    expect(result.forgotten_event_ids).toEqual(new Set(ids));
  });

  it('does not retry a failed accounting callback as another billable completion', async () => {
    const llm = mockLlm(), failure = new Error('accounting persistence failed');
    await expect(condenser(llm).condense(new context.View(events(10), true), undefined, { onCompletion: async () => { throw failure; } })).rejects.toBe(failure);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });
});

describe('asynchronous rolling and pipeline compatibility', () => {
  it('awaits asynchronous requirement, summary and fallback while retaining synchronous no-op behavior', async () => {
    class AsyncCondenser extends context.RollingCondenser {
      condensationRequirement = async () => 'hard' as const;
      getCondensation = async () => { throw new context.NoCondensationAvailableError('not ready'); };
      hardContextReset = async () => condensationSchema.parse({ forgotten_event_ids: [], summary: 'reset', summary_offset: 0 });
    }
    const view = new context.View(events(1));
    expect(new context.NoOpCondenser().condense(view)).toBe(view);
    const later = vi.fn(() => view);
    expect(await new context.PipelineCondenser([new AsyncCondenser(), { condense: later }]).condense(view)).toMatchObject({ kind: 'Condensation', summary: 'reset' });
    expect(later).not.toHaveBeenCalled();
  });
});

describe('upstream token reduction utilities', () => {
  it('counts the first system prompt tools and uses message conversion', async () => {
    const getTokenCount = vi.fn(async () => 55), llm = mockLlm({ getTokenCount });
    const tools = [{ type: 'function', name: 'terminal', parameters: { type: 'object' } }];
    const system = systemPromptEventSchema.parse({ system_prompt: textContent('System'), tools });
    expect(await context.getTotalTokenCount([system, ...events(2)], llm)).toBe(55);
    expect(getTokenCount.mock.calls[0]?.[1]).toEqual(tools);
    expect(getTokenCount.mock.calls[0]?.[0].map(m => m.role)).toEqual(['system', 'user']);
  });

  it.each([[0, 0], [5, 1], [10, 2], [20, 3], [40, 4], [100, 4]])('uses strict shortest-prefix threshold %s', async (threshold, expected) => {
    const input = threshold === 0 ? [] : events(4);
    expect(await context.getShortestPrefixAboveTokenCount(input, countedLlm(), threshold)).toBe(expected);
  });

  it('returns suffix sizes for zero, negative, exact and impossible reduction', async () => {
    const input = events(4), llm = countedLlm();
    expect(await context.getSuffixLengthForTokenReduction([], llm, 10)).toBe(0);
    expect(await context.getSuffixLengthForTokenReduction(input, llm, 0)).toBe(4);
    expect(await context.getSuffixLengthForTokenReduction(input, llm, -1)).toBe(4);
    expect(await context.getSuffixLengthForTokenReduction(input, llm, 10)).toBe(2);
    expect(await context.getSuffixLengthForTokenReduction(input, llm, 40)).toBe(0);
  });

  it('includes base context while subtracting its fixed overhead for reduction', async () => {
    const base = systemPromptEventSchema.parse({ system_prompt: textContent('System'), tools: [{ name: 'large schema' }] });
    const getTokenCount = vi.fn(async (messages: readonly Message[], tools?: unknown[]) => messages.reduce((n, m) => n + m.content.length * 10, tools?.length ? 100 : 0));
    const llm = mockLlm({ getTokenCount });
    expect(await context.getShortestPrefixAboveTokenCount(events(4), llm, 10, [base])).toBe(2);
    expect(getTokenCount.mock.calls.every(call => call[1]?.length === 1)).toBe(true);
  });

  it('uses the host actual prompt projection and tool definitions for the MAIN count', async () => {
    const getTokenCount = vi.fn(async () => 20), llm = mockLlm({ getTokenCount });
    const prompt = messageSchema.parse({ role: 'system', content: [textContent('Rendered context')] });
    const messagesForEvents = vi.fn(() => [prompt]);
    expect(await context.getTotalTokenCount(events(3), llm, { messagesForEvents, tools: [] })).toBe(20);
    expect(getTokenCount).toHaveBeenCalledWith([prompt], []);
  });
});
