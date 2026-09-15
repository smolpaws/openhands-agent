#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  Agent, FinishTool, LocalConversation, ToolDefinition,
  createClientFromProfile, llmProfileSchema, messageSchema, restoreConversationState, textContent,
  type Event,
} from '@smolpaws/openhands-agent';
import { createExampleLlmSecretStore } from '../../examples/_shared/exampleProfile.js';

// A real-provider regression, separate from deterministic tests and parity oracles.
test('DeepSeek Flash: text, concurrent tool input, and restored continuation', { timeout: 180_000 }, async (t) => {
  const profile = llmProfileSchema.parse({
    profileId: 'live-deepseek-flash', providerId: 'deepseek',
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com', openAiApiMode: 'chat_completions',
    maxOutputTokens: 4096,
  });
  const store = createExampleLlmSecretStore(profile);
  assert.ok(store, 'Set DEEPSEEK_API_KEY to run the live test (missing credentials must fail, not skip).');
  let requests = 0;
  const client = await createClientFromProfile(profile, store, { fetch: async (url, init) => {
    assert.ok(++requests <= 12, 'live test exceeded its request budget');
    const response = await fetch(url, { ...init, signal: AbortSignal.any([t.signal, AbortSignal.timeout(45_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      // Provider errors can echo credentials. Never print response bodies or headers.
      throw new Error(`DeepSeek returned HTTP ${response.status}`);
    }
    return response;
  } });

  const text = await client.complete([messageSchema.parse({ role: 'user', content: [textContent('Reply with exactly DEEPSEEK-SMOKE-OK.')] })]);
  assert.equal(text.message.content.filter(c => c.type === 'text').map(c => c.text).join('').trim(), 'DEEPSEEK-SMOKE-OK');

  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.signal.addEventListener('abort', () => release(), { once: true });
  let effects = 0;
  const tool = new ToolDefinition({
    name: 'slow_echo', description: 'Perform the requested echo once and return its result.',
    inputSchema: z.object({}), executor: async () => {
      effects += 1;
      entered();
      await gate;
      return { text: 'The echo completed once.', is_error: false };
    },
  });
  const makeAgent = () => new Agent({ llm: client, tools: [tool, FinishTool.create()] });
  const conversation = new LocalConversation({ agent: makeAgent(), maxIterations: 6 });
  conversation.sendMessage('First call slow_echo exactly once. After its result, obey the latest user message. Use finish for your final answer.');
  const run = conversation.run();
  try {
    await Promise.race([started, run.then(() => { throw new Error('Agent finished without calling slow_echo'); })]);
    await conversation.sendMessageAsync('This arrived while slow_echo was running. Do not call it again. After its result, use finish with exactly DEEPSEEK-OVERLAP-OK.');
  } finally { release(); }
  await run;
  assert.equal(conversation.state.executionStatus, 'finished');
  assert.equal(effects, 1, 'concurrent input must not repeat the tool');
  assertFinish(conversation.state.events, 'DEEPSEEK-OVERLAP-OK');

  // JSON round-trip the real events: the user must remain between action and observation.
  const snapshot = JSON.stringify(conversation.state.events);
  const saved = JSON.parse(snapshot) as Event[];
  const actionIndex = saved.findIndex(e => e.kind === 'ActionEvent' && e.tool_name === 'slow_echo');
  const resultIndex = saved.findIndex(e => e.kind === 'ObservationEvent' && e.tool_name === 'slow_echo');
  assert.ok(actionIndex >= 0 && resultIndex > actionIndex);
  assert.ok(saved.slice(actionIndex + 1, resultIndex).some(e => e.kind === 'MessageEvent' && e.source === 'user'));
  const restored = new LocalConversation({ agent: makeAgent(), state: restoreConversationState(saved).state, maxIterations: 4 });
  restored.sendMessage('Continue after restoring the conversation. Do not call slow_echo again. Use finish with exactly DEEPSEEK-RESTORE-OK.');
  await restored.run();
  assert.equal(restored.state.executionStatus, 'finished');
  assert.equal(effects, 1, 'restore must not repeat the completed tool');
  assertFinish(restored.state.events, 'DEEPSEEK-RESTORE-OK');
  assert.equal(JSON.stringify(conversation.state.events), snapshot, 'original history must remain unchanged');
  console.log(JSON.stringify({ model: profile.model, requests, toolExecutions: effects, overlap: 'passed', restore: 'passed' }));
});

function assertFinish(events: readonly Event[], expected: string): void {
  const finish = events.filter(e => e.kind === 'ActionEvent' && e.tool_name === 'finish').at(-1);
  assert.ok(finish?.kind === 'ActionEvent');
  assert.equal(finish.action.message, expected);
}
