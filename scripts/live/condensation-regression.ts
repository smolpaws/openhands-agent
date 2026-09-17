import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  Agent, FinishTool, LLMSummarizingCondenser, LocalConversation, ToolDefinition, View,
  isContextWindowExceeded, looksLikeMalformedConversationHistoryError, isContentPolicyViolation, providerResponseError,
  condensationSchema, createClientFromProfile, llmProfileSchema, metricsSnapshot, restoreConversationState,
  type ActionEvent, type Condenser, type Event, type FetchLike, type LLMProfile, type SecretStore,
} from '@smolpaws/openhands-agent';
import { providerFailure } from './provider-failure.js';
import type { CondensationScenario } from './condensation-options.js';
export type { CondensationScenario } from './condensation-options.js';

interface Options {
  profile: LLMProfile; store: SecretStore; scenario: CondensationScenario;
  fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number; maxRequests?: number;
}
export interface CondensationRegressionSummary {
  profileId: string; requestedModel: string; scenario: CondensationScenario;
  requests: number; reactiveRequests: number; summaryCompletions: number; condensations: number; eventsForgotten: number;
  continuations: number; executedTools: number; thinkingActions: number; checks: string[];
}

/** c01-c05 at 50080b58d: bounded public tools, independent summary client, actual native adapters. */
export async function runCondensationRegression(options: Options): Promise<CondensationRegressionSummary> {
  if (options.scenario === 'thinking' && options.profile.providerId !== 'anthropic') throw new Error('unavailable:thinking');
  const signal = options.signal === undefined ? AbortSignal.timeout(options.timeoutMs ?? 220_000)
    : AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 220_000)]);
  let requests = 0, summaryCompletions = 0, continuations = 0;
  let conversation: LocalConversation | undefined;
  const transport: FetchLike = async (url, init) => {
    signal.throwIfAborted();
    assert.ok(++requests <= (options.maxRequests ?? 20), 'condensation exceeded request budget');
    if (options.scenario === 'thinking' && conversation && condensations(conversation.state.events).length > 0) {
      const retained = View.fromEvents(conversation.state.events).events;
      const retainedIds = new Set(retained.map(event => event.id));
      const signatures = (events: readonly Event[]) => events.flatMap(event => event.kind === 'ActionEvent'
        ? event.thinking_blocks.flatMap(block => block.type === 'thinking' && block.signature ? [block.signature] : []) : []);
      const kept = new Set(signatures(retained));
      for (const signature of signatures(conversation.state.events.filter(event => !retainedIds.has(event.id)))) {
        if (!kept.has(signature)) assert.ok(!init.body.includes(JSON.stringify(signature)), 'forgotten signed loop must not reach native wire');
      }
      for (const signature of kept) assert.ok(init.body.includes(JSON.stringify(signature)), 'retained signed loop must reach native wire');
    }
    const response = await (options.fetch ? options.fetch(url, init) : fetch(url, { ...init, signal }));
    if (!response.ok) {
      // Keep recoverable failures at the native adapter boundary, including its
      // metadata accounting. Other failures retain the existing bounded categories.
      const body = await response.text();
      const replay = { ok: response.ok, status: response.status, text: async () => body, json: async () => JSON.parse(body) as unknown };
      const classified = providerResponseError('Live provider', response.status, body);
      if (isContextWindowExceeded(classified) || looksLikeMalformedConversationHistoryError(classified) || isContentPolicyViolation(classified)) return replay;
      throw await providerFailure(replay);
    }
    return response;
  };
  const nativeMain = await createClientFromProfile(options.profile, options.store, { fetch: transport });
  const main = {
    profile: nativeMain.profile,
    get effectiveMaxInputTokens() { return nativeMain.effectiveMaxInputTokens; },
    resolveRuntimeMetadata: () => nativeMain.resolveRuntimeMetadata?.() ?? Promise.resolve(),
    getTokenCount: async (...args: Parameters<NonNullable<typeof nativeMain.getTokenCount>>) => {
      const count = await nativeMain.getTokenCount?.(...args) ?? null;
      if (options.scenario === 'tokens' && count === null) throw new Error('unavailable:token-count');
      return count;
    },
    complete: async (...args: Parameters<typeof nativeMain.complete>) => {
      if (conversation?.state.events.some(event => event.kind === 'Condensation')) continuations++;
      return nativeMain.complete(...args);
    },
  };
  if (options.scenario === 'tokens' && await main.getTokenCount([]) === null) throw new Error('unavailable:token-count');
  const nativeSummary = await createClientFromProfile(llmProfileSchema.parse({ ...options.profile, profileId: `${options.profile.profileId}.condenser` }), options.store, { fetch: transport });
  const summary = {
    profile: nativeSummary.profile,
    get effectiveMaxInputTokens() { return nativeSummary.effectiveMaxInputTokens; },
    resolveRuntimeMetadata: () => nativeSummary.resolveRuntimeMetadata?.() ?? Promise.resolve(),
    getTokenCount: (...args: Parameters<NonNullable<typeof nativeSummary.getTokenCount>>) => nativeSummary.getTokenCount?.(...args) ?? Promise.resolve(null),
    complete: async (...args: Parameters<typeof nativeSummary.complete>) => { summaryCompletions++; return nativeSummary.complete(...args); },
  };
  const executed: string[] = [];
  const terminal = new ToolDefinition({
    name: 'terminal', description: 'Run one of the public fixture commands echo 1, echo 2, echo 3; returns its output.',
    inputSchema: z.object({ command: z.enum(['echo 1', 'echo 2', 'echo 3']) }),
    executor: ({ command }) => {
      assert.ok(!executed.includes(command), 'completed tool must never replay');
      executed.push(command);
      return { text: `${command.slice(5)}\n${options.scenario === 'tokens' ? 'Public condensation context fixture. '.repeat(100) : 'Public echo complete.'}`, is_error: false };
    },
  });
  const condenser: Condenser = options.scenario === 'thinking' ? new FirstToolLoopCondenser()
    : new LLMSummarizingCondenser({ llm: summary, maxSize: options.scenario === 'size' ? 10 : 1000,
      maxTokens: options.scenario === 'tokens' ? 1100 : null, keepFirst: options.scenario === 'forced' ? 4 : 1 });
  const tools = [terminal, FinishTool.create()];
  const agent = () => new Agent({ llm: main, tools, condenser });
  conversation = new LocalConversation({ agent: agent(), maxIterations: 15 });

  // c02: with one input event, keepFirst=4 makes only a full-view reset possible.
  if (options.scenario === 'forced') {
    conversation.sendMessage('Public initial task: later execute the three numbered echo commands when instructed.');
    await waitFor(conversation.condense(), signal);
    assert.equal(condensations(conversation.state.events)[0]?.summary_offset, 0, 'first forced condensation must reset full view');
  }
  for (let turn = 1; turn <= 3; turn++) {
    conversation.sendMessage(`Call terminal once with command "echo ${turn}". After its result, call finish with message "done". Do not repeat earlier commands.`);
    await waitFor(conversation.run(), signal);
    assert.equal(conversation.state.executionStatus, 'finished', 'tool turn must finish');
    assert.deepEqual(executed, Array.from({ length: turn }, (_, i) => `echo ${i + 1}`), 'each requested public tool must execute once');
    const lastAction: ActionEvent | undefined = [...conversation.state.events].reverse().find(event => event.kind === 'ActionEvent');
    assert.equal(lastAction?.tool_name, 'finish', 'ordinary text is not a finish action');
    assert.ok(conversation.state.events.some(event => event.kind === 'ObservationEvent' && event.action_id === lastAction?.id && !event.observation.is_error), 'finish requires a successful matching result');
    if (options.scenario === 'forced' && turn === 2) {
      await waitFor(conversation.condense(), signal);
      const entries = condensations(conversation.state.events);
      assert.equal(entries.length, 2, 'manual scenario must produce exactly two condensations');
      assert.ok(entries[1]!.summary_offset! > 0, 'second forced condensation must use a normal safe range');
      assert.ok(!entries[1]!.forgotten_event_ids.has(`${entries[0]!.id}-summary`), 'normal condensation must retain hard-reset summary');
    }
  }
  const entries = condensations(conversation.state.events);
  const thinking = conversation.state.events.filter(event => event.kind === 'ActionEvent' && event.thinking_blocks.length > 0);
  if (options.scenario === 'thinking' && thinking.length === 0) throw new Error('unavailable:thinking');
  assert.ok(entries.length > 0, 'scenario must emit an actual condensation');
  assert.ok(entries.every(event => event.forgotten_event_ids.size > 0), 'condensations must forget actual events');
  if (options.scenario === 'thinking') {
    assert.ok(thinking.length >= 3, 'thinking test needs at least three signed actions');
    assert.ok(entries[0]!.forgotten_event_ids.has(thinking[0]!.id), 'first signed tool loop must be forgotten');
    assert.ok(View.fromEvents(conversation.state.events).events.some(event => event.id === thinking.at(-1)!.id), 'latest thinking action must remain');
  } else {
    assert.equal(conversation.state.stats.usage_to_metrics.condenser?.records.length, summaryCompletions, 'every summary attempt must be accounted once');
  }
  const saved = JSON.parse(JSON.stringify({ events: conversation.state.events, executionStatus: conversation.state.executionStatus }, (_key, value) => value instanceof Set ? [...value] : value));
  const restored = restoreConversationState(saved).state;
  assert.deepEqual(metricsSnapshot(restored.stats), metricsSnapshot(conversation.state.stats), 'restore must preserve accounting');
  assert.deepEqual(condensations(restored.events), entries, 'restore must preserve summaries and forgotten event sets');
  const before = metricsSnapshot(restored.stats).coverage.completion_count;
  conversation = new LocalConversation({ state: restored, agent: agent(), maxIterations: 10 });
  conversation.sendMessage('Call finish with message "RESTORED-CONDENSATION". Do not call terminal.');
  await waitFor(conversation.run(), signal);
  assert.equal(conversation.state.executionStatus, 'finished');
  assert.equal(executed.length, 3, 'restored continuation must not repeat tools');
  const restoredFinish = [...conversation.state.events].reverse().find(event => event.kind === 'ActionEvent');
  assert.equal(restoredFinish?.tool_name, 'finish', 'restored continuation requires a real finish');
  assert.equal(restoredFinish?.action?.message, 'RESTORED-CONDENSATION');
  assert.ok(metricsSnapshot(conversation.state.stats).coverage.completion_count > before, 'restored continuation adds new accounting');
  assert.ok(continuations > 0, 'agent must continue after condensation');
  return { profileId: options.profile.profileId, requestedModel: options.profile.model, scenario: options.scenario,
    requests, reactiveRequests: conversation.state.events.filter(event => event.kind === 'CondensationRequest').length - (options.scenario === 'forced' ? 2 : 0), summaryCompletions, condensations: entries.length, eventsForgotten: entries.reduce((count, event) => count + event.forgotten_event_ids.size, 0),
    continuations, executedTools: executed.length, thinkingActions: thinking.length,
    checks: ['actual-condensation', 'tool-continuation', 'restored-summary-and-accounting', ...(options.scenario === 'thinking' ? ['signed-loop-forgotten-and-later-retained'] : ['independent-summary-accounting'])] };
}

/** Port of c01's custom condenser: remove the first signed loop when two exist. */
class FirstToolLoopCondenser implements Condenser {
  handlesCondensationRequests() { return true; }

  condense(view: View) {
    const indices = [...view.manipulationIndices].sort((a, b) => a - b);
    const loops = indices.slice(0, -1).map((start, i) => ({ start, events: view.events.slice(start, indices[i + 1]) }))
      .filter(unit => unit.events.some(event => event.kind === 'ActionEvent' && event.thinking_blocks.length > 0));
    if (loops.length < 2) return view;
    return condensationSchema.parse({ forgotten_event_ids: new Set(loops[0]!.events.map(event => event.id)), summary_offset: loops[0]!.start, summary: 'Previous signed tool loop completed successfully.' });
  }
}
function condensations(events: readonly Event[]) { return events.filter(event => event.kind === 'Condensation'); }
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new DOMException('Condensation deadline reached', 'TimeoutError')); });
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
