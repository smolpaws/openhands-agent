import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  condensationSchema,
  condensationRequestSchema,
  conversationStateUpdateEventSchema,
  messageEventSchema,
  type Event,
} from '../../event/index.js';
import type { LLMClient } from '../../llm/client.js';
import { EventLog } from '../../conversation/event-log.js';
import { InMemoryFileStore } from '../../io/index.js';
import { llmProfileSchema, messageSchema, textContent } from '../../llm/index.js';
import { ToolDefinition } from '../../tool/index.js';
import {
  contextWarningEvent,
  contextWarningMessage,
  contextWarningThresholdsSchema,
  DEFAULT_CONTEXT_WARNING_THRESHOLDS,
} from '../context-warnings.js';
import { View } from '../view.js';

const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'fixture', model: 'main-model', maxInputTokens: 400_000 });
const user = messageEventSchema.parse({ id: 'question', source: 'user', llm_message: { role: 'user', content: [textContent('Public test question')] } });
const client = (tokens: number | null = 300_000, options: Partial<LLMClient> = {}): LLMClient => ({
  profile,
  complete: vi.fn(async () => { throw new Error('Warnings must not call the LLM'); }),
  getTokenCount: vi.fn(async () => tokens),
  ...options,
});
const thresholds = DEFAULT_CONTEXT_WARNING_THRESHOLDS;
const warning = (history: readonly Event[], llm = client()) => contextWarningEvent(history, new View([user]), llm, thresholds);
const marker = (value: unknown) => conversationStateUpdateEventSchema.parse({
  id: 'persisted-warning', timestamp: '2026-09-20T00:00:00.000Z', key: 'agent_context_warning', value,
});
const payload = { version: 1, generation: null, threshold: 0.85, input_tokens: 350_000, input_limit: 400_000 };

describe('agent context warning settings', () => {
  it('defaults to ascending 75%, 80%, 85%, 90% thresholds', () => {
    expect(thresholds).toEqual([0.75, 0.80, 0.85, 0.90]);
    expect(contextWarningThresholdsSchema.parse([0.2, 0.5, 1])).toEqual([0.2, 0.5, 1]);
  });

  it.each([[], [0], [-0.1], [1.01], [NaN], [Infinity], [0.8, 0.75], [0.8, 0.8]].map(values => ({ values })))('rejects invalid thresholds $values', ({ values }) => {
    expect(contextWarningThresholdsSchema.safeParse(values).success).toBe(false);
  });
});

describe('persisted advisory context warnings', () => {
  it.each([
    [299_999, null], [300_000, 0.75], [320_000, 0.80],
    [340_000, 0.85], [360_000, 0.90], [450_000, 0.90],
  ])('at %s input tokens emits only the highest passed threshold %s', async (tokens, threshold) => {
    const llm = client(tokens);
    const event = await warning([user], llm);
    if (threshold === null) expect(event).toBeNull();
    else expect(event).toMatchObject({
      kind: 'ConversationStateUpdateEvent', source: 'environment', key: 'agent_context_warning',
      value: { version: 1, generation: null, threshold, input_tokens: tokens, input_limit: 400_000 },
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('emits exactly at a custom fractional threshold without multiplication rounding drift', async () => {
    const llm = client(7, { profile: { ...profile, maxInputTokens: 100 } });
    expect(await contextWarningEvent([], new View([user]), llm, [0.07])).toMatchObject({ value: { threshold: 0.07 } });
  });

  it('uses the explicit main-profile input limit before a different effective limit', async () => {
    expect(await warning([], client(300_000, { effectiveMaxInputTokens: 1_000_000 }))).toMatchObject({
      value: { threshold: 0.75, input_limit: 400_000 },
    });
  });

  it('uses resolved main-model metadata when the profile input limit is absent', async () => {
    let resolved = false;
    const llm = client(750, {
      profile: { ...profile, maxInputTokens: null },
      get effectiveMaxInputTokens() { return resolved ? 1_000 : null; },
    });
    // Preserve the live getter rather than copying its current value in the fixture helper.
    Object.defineProperty(llm, 'effectiveMaxInputTokens', { get: () => resolved ? 1_000 : null });
    const resolveRuntimeMetadata = vi.fn(async () => { resolved = true; });
    Object.assign(llm, { resolveRuntimeMetadata });
    expect(await warning([], llm)).toMatchObject({ value: { input_limit: 1_000, threshold: 0.75 } });
    expect(resolveRuntimeMetadata).toHaveBeenCalledOnce();
  });

  it('counts the host full prompt with fixed system, memory, skills and usable tools', async () => {
    const llm = client();
    const view = new View([user]);
    const fixed = messageSchema.parse({ role: 'system', content: [textContent('System, memory, runtime, skills')] });
    const messages = [fixed, user.llm_message];
    const messagesForEvents = vi.fn(() => messages);
    const tools = [new ToolDefinition({ name: 'condense', description: 'Reset after saving notes', inputSchema: z.object({}) })];
    await contextWarningEvent([user], view, llm, thresholds, { messagesForEvents, tools });
    expect(messagesForEvents).toHaveBeenCalledWith(view.events);
    expect(llm.getTokenCount).toHaveBeenCalledWith(messages, tools);
  });

  it.each(['no-counter', 'unknown-count', 'unknown-limit'] as const)('leaves %s unavailable instead of inventing a ratio', async missing => {
    const llm = client(missing === 'unknown-count' ? null : 300_000,
      missing === 'unknown-limit' ? { profile: { ...profile, maxInputTokens: null } } : {});
    if (missing === 'no-counter') Reflect.deleteProperty(llm, 'getTokenCount');
    expect(await warning([], llm)).toBeNull();
  });

  it('marks lower thresholds passed when jumping from 74% to 87%, with no hover repeats', async () => {
    expect(await warning([], client(296_000))).toBeNull();
    const emitted = await warning([], client(348_000));
    expect(emitted).toMatchObject({ value: { threshold: 0.85 } });
    const history = [user, emitted!];
    for (const tokens of [348_000, 320_000, 300_000, 359_999]) expect(await warning(history, client(tokens))).toBeNull();
    expect(await warning(history, client(360_000))).toMatchObject({ value: { threshold: 0.90 } });
  });

  it('deduplicates across restore using the highest persisted marker rather than its position', async () => {
    const restored = JSON.parse(JSON.stringify(marker(payload))) as Event;
    const lower = marker({ ...payload, threshold: 0.75 });
    expect(await warning([restored, lower], client(340_000))).toBeNull();
    expect(await warning([restored, lower], client(360_000))).toMatchObject({ value: { threshold: 0.9 } });
  });

  it('preserves deduplication and the projected message through actual EventLog serialization', async () => {
    const event = (await warning([]))!;
    const store = new InMemoryFileStore();
    new EventLog(store).append(event);
    const restored = new EventLog(store).toArray();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ value: { version: 1, threshold: 0.75 } });
    expect(await warning(restored)).toBeNull();
    expect(contextWarningMessage(restored[0]!)).toEqual(contextWarningMessage(event));
  });

  it('rearms after a committed condensation, never merely a requested one', async () => {
    const old = marker({ ...payload, threshold: 0.9 });
    const requested = condensationRequestSchema.parse({});
    expect(await warning([old, requested], client(300_000))).toBeNull();
    const reset = condensationSchema.parse({ id: 'reset-1', forgotten_event_ids: [] });
    const next = await warning([old, requested, reset], client(300_000));
    expect(next).toMatchObject({ value: { generation: 'reset-1', threshold: 0.75 } });
    expect(await warning([old, requested, reset, next!], client(300_000))).toBeNull();
  });

  it('does not use a marker for a different reset generation', async () => {
    const reset = condensationSchema.parse({ id: 'latest-reset', forgotten_event_ids: [] });
    const stale = marker({ ...payload, generation: 'older-reset', threshold: 0.9 });
    expect(await warning([reset, stale])).toMatchObject({ value: { generation: 'latest-reset', threshold: 0.75 } });
  });

  it.each([
    { ...payload, version: 2 }, { ...payload, threshold: 0 },
    { ...payload, generation: 1 }, { ...payload, input_tokens: null },
    { ...payload, input_limit: 0 }, { version: 1 },
  ])('fails explicitly for malformed warning payload %j', async value => {
    await expect(warning([marker(value)])).rejects.toThrow(/context warning/iu);
    expect(() => contextWarningMessage(marker(value))).toThrow(/context warning/iu);
  });

  it('does not mutate history, active View, thresholds or profile', async () => {
    const history = Object.freeze([user]);
    const view = new View([user]);
    Object.freeze(view.events);
    Object.freeze(view);
    const llm = client();
    const before = structuredClone({ history, view, profile: llm.profile });
    await contextWarningEvent(history, view, llm, Object.freeze([...thresholds]));
    expect({ history, view: { ...view }, profile: llm.profile }).toEqual(before);
  });
});

describe('model-visible warning projection', () => {
  it('renders a deterministic environment-source user message with advisory guidance', () => {
    const event = marker(payload);
    const message = contextWarningMessage(event);
    expect(message).toMatchObject({
      id: 'persisted-warning-message', timestamp: event.timestamp, source: 'environment',
      llm_message: { role: 'user' },
    });
    expect(contextWarningMessage(event)).toEqual(message);
    const content = message!.llm_message.content[0];
    expect(content).toMatchObject({ type: 'text', text: expect.stringMatching(/85%/u) });
    const text = content?.type === 'text' ? content.text : '';
    expect(text).toContain('350000');
    expect(text).toContain('400000');
    expect(text).toMatch(/notes/iu);
    expect(text).toMatch(/condense/iu);
    expect(text).toMatch(/when (you are )?ready/iu);
    expect(text).toMatch(/advisory/iu);
    expect(text).toMatch(/you decide/iu);
  });

  it('ignores unrelated events and state-update keys', () => {
    expect(contextWarningMessage(user)).toBeNull();
    expect(contextWarningMessage(conversationStateUpdateEventSchema.parse({ key: 'other', value: {} }))).toBeNull();
  });
});
