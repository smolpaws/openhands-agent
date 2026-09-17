import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { InMemorySecretStore, llmProfileSchema, llmProviderSecretRef, type FetchLike } from '@smolpaws/openhands-agent';
import { runConversationRegression } from './conversation-regression.js';

type Format = 'chat' | 'responses' | 'anthropic' | 'gemini';
type Call = { id: string; name: string; args: Record<string, unknown> };

test('scratch creation failure lets the process exit without waiting for the conversation deadline', { timeout: 10_000 }, async () => {
  await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { InMemorySecretStore, llmProfileSchema } from '@smolpaws/openhands-agent';
    import { runConversationRegression } from './scripts/live/conversation-regression.ts';
    process.env.TMPDIR = process.env.TEST_INVALID_TMPDIR;
    await assert.rejects(runConversationRegression({
      profile: llmProfileSchema.parse({ profileId: 'failed-setup', providerId: 'openai', model: 'fixture-model' }),
      store: new InMemorySecretStore(), timeoutMs: 60_000,
    }), { code: 'ENOTDIR' });
  `], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TEST_INVALID_TMPDIR: join(process.cwd(), 'README.md', 'not-a-directory') },
    timeout: 3_000,
  });
});

for (const format of ['chat', 'responses', 'anthropic', 'gemini'] as const) {
  test(`complete regression harness exercises real built-in tools through ${format} transport`, { timeout: 30_000 }, async () => {
    const before = await readFile('README.md', 'utf8');
    const { profile, store } = configuration(format);
    const result = await runConversationRegression({ profile, store, fetch: scenario(format), timeoutMs: 20_000 });
    assert.equal(result.requests, 9);
    assert.equal(result.recordedCompletions, 9);
    assert.equal(result.parallelToolExecutions, 2);
    assert.equal(result.wireRequestsChecked, 4);
    assert.equal(result.plainResponseWireRequestsChecked, 2);
    assert.equal(result.checks.length, 9);
    assert.deepEqual(result.returnedModels, ['fixture-model']);
    assert.equal(await readFile('README.md', 'utf8'), before, 'the real checkout README must be untouched');
  });
}

test('an ordinary assistant answer cannot masquerade as finish', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('chat');
  await assert.rejects(runConversationRegression({ profile, store, fetch: scenario('chat', 'plain-finish'), timeoutMs: 20_000 }), /finish tool action is required/);
});

test('partial README reads report the hand-authored invariant and safe phase', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('chat');
  await assert.rejects(runConversationRegression({ profile, store, fetch: scenario('chat', 'partial-read'), timeoutMs: 20_000 }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'the read phase must read the complete README');
    assert.equal((error as Error & { regressionPhase: string }).regressionPhase, 'read');
    return true;
  });
});

test('a containing-sentence replacement is accepted when the entire file has exactly the requested word change', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('chat');
  const result = await runConversationRegression({ profile, store, fetch: scenario('chat', 'sentence-edit'), timeoutMs: 20_000 });
  assert.equal(result.requests, 9);
  assert.ok(result.checks.includes('exact-word-edit'));
});

test('a partial verification view after a correct edit is accepted', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('chat');
  const result = await runConversationRegression({ profile, store, fetch: scenario('chat', 'edit-verification'), timeoutMs: 20_000 });
  assert.equal(result.requests, 10);
  assert.ok(result.checks.includes('exact-word-edit'));
});

test('a sentence replacement that changes anything beyond the chosen word is rejected', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('chat');
  await assert.rejects(runConversationRegression({ profile, store, fetch: scenario('chat', 'extra-edit'), timeoutMs: 20_000 }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'the requested edit must produce exactly the chosen word replacement');
    assert.equal((error as Error & { regressionPhase: string }).regressionPhase, 'edit');
    return true;
  });
});

test('one directory call fails promptly instead of pretending the parallel race was tested', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('chat');
  await assert.rejects(runConversationRegression({ profile, store, fetch: scenario('chat', 'single-tool'), timeoutMs: 20_000 }), /exactly two terminal calls/);
});

test('the complete Responses harness rejects tool identities corrupted by native wire normalization', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('responses');
  await assert.rejects(runConversationRegression({ profile, store, fetch: scenario('responses', 'wire-collision'), timeoutMs: 20_000 }), /exactly one matching wire result/);
});

test('provider error bodies and supplied transport deadlines are bounded without disclosure', { timeout: 30_000 }, async () => {
  const { profile, store } = configuration('chat');
  const response = new Response('sensitive provider body', { status: 401 });
  await assert.rejects(runConversationRegression({ profile, store, fetch: async () => response, timeoutMs: 20_000 }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Live conversation provider returned HTTP 401');
    return true;
  });
  await assert.rejects(runConversationRegression({ profile, store, fetch: async () => new Promise(() => {}), timeoutMs: 500 }), /deadline|aborted/);
});

function configuration(format: Format) {
  const providerId = format === 'chat' || format === 'responses' ? 'openai' : format;
  const profile = llmProfileSchema.parse({ profileId: `fixture-${format}`, providerId, model: 'fixture-model', openAiApiMode: format === 'responses' ? 'responses' : 'chat_completions' });
  return { profile, store: new InMemorySecretStore([[llmProviderSecretRef(providerId), 'synthetic-not-a-real-key']]) };
}

function scenario(format: Format, mode?: 'plain-finish' | 'single-tool' | 'wire-collision' | 'partial-read' | 'sentence-edit' | 'edit-verification' | 'extra-edit'): FetchLike {
  let step = 0;
  let readme = '';
  let originalSentence = '';
  return async (_url, init) => {
    step += 1;
    if (step === 1) {
      const request = JSON.parse(init.body) as Record<string, unknown>;
      const text = requestText(request);
      readme = /README path: ([^\n]+)/u.exec(text)?.[1] ?? '';
      assert.ok(readme.endsWith('/README.md'), 'fixture discovers the actual isolated README path from the real request');
      originalSentence = (await readFile(readme, 'utf8')).split('\n').find(line => line.startsWith('Idiomatic '))!;
    }
    const logicalStep = step > 4 && mode === 'edit-verification' ? step - 1 : step;
    const call = (name: string, args: Record<string, unknown>, suffix = ''): Call => ({ id: `call_${step}${suffix}`, name, args });
    const finish = (message: string) => [call('finish', { message })];
    const calls = step === 4 && mode === 'edit-verification' ? [call('file_editor', { command: 'view', path: readme, view_range: [1, 5] })]
      : logicalStep === 1 ? [call('file_editor', { command: 'view', path: readme, view_range: mode === 'partial-read' ? [2, 10] : [1, -1] })]
      : logicalStep === 2 ? (mode === 'plain-finish' ? [] : finish('README-READ'))
      : logicalStep === 3 ? [call('file_editor', { command: 'str_replace', path: readme,
        old_str: mode === 'sentence-edit' || mode === 'extra-edit' ? originalSentence : 'Idiomatic',
        new_str: mode === 'sentence-edit' || mode === 'extra-edit' ? originalSentence.replace('Idiomatic', 'Straightforward') + (mode === 'extra-edit' ? ' An unrequested change.' : '') : 'Straightforward',
      })]
      : logicalStep === 4 ? finish('README-EDITED')
      : logicalStep === 5 ? [call('terminal', { command: 'ls -1 src' }, '_a'), ...(mode === 'single-tool' ? [] : [call('terminal', { command: 'ls -1 examples' }, '_b')])]
      : logicalStep === 6 ? finish('Directories inspected.')
      : logicalStep === 7 ? []
      : logicalStep === 8 ? finish('INFLIGHT-FINISHED')
      : finish('README-RESTORED');
    // Distinct durable IDs collapse to the same Responses wire ID, so only the
    // final POST oracle can detect this; transcript-only assertions would pass.
    if (step === 5 && mode === 'wire-collision') {
      calls[0]!.id = 'foreign+one';
      calls[1]!.id = 'foreign?one';
    }
    assert.ok(logicalStep <= 9, 'fixture completion budget exceeded');
    return new Response(JSON.stringify(providerResponse(format, calls, logicalStep === 7 ? 'PLAIN-REPLY' : undefined)), { headers: { 'content-type': 'application/json' } });
  };
}

function providerResponse(format: Format, calls: Call[], text = 'Inspecting the requested files.'): Record<string, unknown> {
  // Response IDs are deliberately reused. A real multi-tool thought must survive reconstruction once.
  const base = { id: 'reused-provider-response', model: 'fixture-model' };
  if (format === 'chat') return { ...base, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    choices: [{ message: { role: 'assistant', content: text, reasoning_content: 'Preserve batch reasoning once.', tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] };
  if (format === 'responses') return { ...base, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ...calls.map(call => ({ type: 'function_call', id: `item_${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))] };
  if (format === 'anthropic') return { ...base, role: 'assistant', usage: { input_tokens: 100, output_tokens: 20 },
    content: [{ type: 'thinking', thinking: 'Preserve signed thought once.', signature: 'fixture-signature' }, { type: 'text', text },
      ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args }))] };
  return { ...base, usage: { total_input_tokens: 100, total_output_tokens: 15, total_thought_tokens: 5, total_tokens: 120 },
    steps: [{ type: 'thought', summary: [{ type: 'text', text: 'Preserve signed thought once.' }], signature: 'fixture-signature' }, { type: 'model_output', content: [{ type: 'text', text }] },
      ...calls.map(call => ({ type: 'function_call', id: call.id, name: call.name, arguments: call.args }))] };
}

function requestText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(requestText).join('\n');
  if (typeof value === 'object' && value !== null) return Object.values(value).map(requestText).join('\n');
  return '';
}
