import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, llmProfileSchema, llmProviderSecretRef, type FetchLike } from '@smolpaws/openhands-agent';
import { runCondensationRegression, type CondensationScenario } from './condensation-regression.js';
import { parseCondensationOption } from './condensation-options.js';

for (const format of ['chat', 'responses', 'anthropic', 'gemini'] as const) {
  for (const mode of ['size', 'tokens', 'forced', ...(format === 'anthropic' ? ['thinking'] : [])] as CondensationScenario[]) {
    test(`pinned condensation ${mode} completes and restores through ${format} native wire`, { timeout: 30_000 }, async () => {
      const providerId = format === 'chat' || format === 'responses' ? 'openai' : format;
      const profile = llmProfileSchema.parse({ profileId: `fixture-${format}`, providerId, model: format === 'anthropic' ? 'claude-fixture' : 'fixture', openAiApiMode: format === 'responses' ? 'responses' : 'chat_completions' });
      const store = new InMemorySecretStore([[llmProviderSecretRef(providerId), 'synthetic-key']]);
      const result = await runCondensationRegression({ profile, store, scenario: mode, fetch: fixture(format), maxRequests: 20, timeoutMs: 20_000 });
      assert.ok(result.condensations > 0);
      assert.equal(result.executedTools, 3);
      assert.ok(result.continuations > 0);
      assert.ok(result.checks.includes('restored-summary-and-accounting'));
      if (mode === 'thinking') assert.ok(result.thinkingActions >= 3);
      else assert.ok(result.summaryCompletions > 0);
    });
  }
}

for (const format of ['chat', 'responses', 'anthropic', 'gemini'] as const) {
  test(`native ${format} HTTP context overflow reaches SDK request and summary recovery`, async () => {
    const providerId = format === 'chat' || format === 'responses' ? 'openai' : format;
    const profile = llmProfileSchema.parse({ profileId: 'overflow', providerId, model: 'fixture', openAiApiMode: format === 'responses' ? 'responses' : 'chat_completions' });
    const normal = fixture(format);
    let overflow = false;
    const result = await runCondensationRegression({ profile, scenario: 'size', store: new InMemorySecretStore([[llmProviderSecretRef(providerId), 'synthetic-key']]),
      fetch: async (url, init) => {
        if (!overflow) { overflow = true; return new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'Input exceeds the context window' } }), { status: 400 }); }
        return normal(url, init);
      } });
    assert.equal(result.reactiveRequests, 1);
    assert.ok(result.summaryCompletions > 0);
    assert.ok(result.continuations > 0);
    assert.equal(result.executedTools, 3);
  });
}

test('explicit scenario override requires exactly one supported mode and a selected target', () => {
  assert.equal(parseCondensationOption(['--target', 'target', '--condensation', 'tokens']), 'tokens');
  assert.equal(parseCondensationOption(['--all']), null);
  assert.throws(() => parseCondensationOption(['--all', '--condensation', 'tokens']), /--target/);
  assert.throws(() => parseCondensationOption(['--target', 'target', '--condensation', 'unknown']), /scenario/);
  assert.throws(() => parseCondensationOption(['--target', 'target', '--condensation']), /scenario/);
});

test('thinking prerequisite is unavailable instead of a successful skip', async () => {
  const profile = llmProfileSchema.parse({ profileId: 'fixture', providerId: 'openai', model: 'fixture' });
  await assert.rejects(runCondensationRegression({ profile, store: new InMemorySecretStore(), scenario: 'thinking' }), /unavailable:thinking/);
});

function fixture(format: 'chat' | 'responses' | 'anthropic' | 'gemini'): FetchLike {
  let request = 0, calls = 0;
  return async (_url, init) => {
    request++;
    const body = JSON.parse(init.body);
    const summary = JSON.stringify(body).includes('You are maintaining a context-aware state summary');
    const restore = JSON.stringify(body).includes('RESTORED-CONDENSATION');
    const step = summary ? 0 : ++calls;
    const tool = summary ? null : restore || step % 2 === 0 ? 'finish' : 'terminal';
    const args = tool === 'terminal' ? { command: `echo ${(step + 1) / 2}` } : { message: restore ? 'RESTORED-CONDENSATION' : 'done' };
    const text = summary ? 'Public earlier work complete; keep current task.' : 'Continuing.';
    const id = `request-${request}`, callId = `call-${request}`;
    const call = tool ? { id: callId, name: tool, args } : null;
    const response = format === 'chat' ? { id, model: 'fixture', usage: { prompt_tokens: 30, completion_tokens: 10 }, choices: [{ message: { role: 'assistant', content: text, ...(call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) } }] }
      : format === 'responses' ? { id, model: 'fixture', usage: { input_tokens: 30, output_tokens: 10 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }, ...(call ? [{ type: 'function_call', id: `item-${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] : [])] }
      : format === 'anthropic' ? { id, model: 'fixture', role: 'assistant', usage: { input_tokens: 30, output_tokens: 10 }, content: [...(summary ? [] : [{ type: 'thinking', thinking: 'Public reasoning', signature: `signed-${request}` }]), { type: 'text', text }, ...(call ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] : [])] }
      : { id, model: 'fixture', usage: { total_input_tokens: 30, total_output_tokens: 10, total_tokens: 40 }, steps: [{ type: 'model_output', content: [{ type: 'text', text }] }, ...(call ? [{ type: 'function_call', id: call.id, name: call.name, arguments: call.args }] : [])] };
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  };
}
