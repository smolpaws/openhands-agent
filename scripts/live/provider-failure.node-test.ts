import assert from 'node:assert/strict';
import test from 'node:test';
import type { FetchResponseLike } from '@smolpaws/openhands-agent';
import { providerFailure } from './provider-failure.js';

const prefix = 'Live conversation provider returned HTTP 400';
const failure = (body: unknown) => providerFailure(new Response(JSON.stringify(body), { status: 400 }));

test('Anthropic insufficient credit is unavailable without reflecting its error message', async () => {
  const error = await failure({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. synthetic-secret-must-not-escape' } });
  assert.equal(error.message, `${prefix} unavailable:insufficient-credit`);
  assert.equal(error.cause, undefined);
  assert.ok(!String(error.stack).includes('synthetic-secret-must-not-escape'));
});

test('known balance and quota codes classify independently of arbitrary diagnostic content', async () => {
  for (const code of ['insufficient_balance', 'insufficient_credits']) {
    assert.equal((await failure({ error: { code, message: 'synthetic secret' } })).message, `${prefix} unavailable:insufficient-credit`);
  }
  for (const error of [{ code: 'insufficient_quota' }, { type: 'quota_exceeded' }, { status: 'RESOURCE_EXHAUSTED' }]) {
    assert.equal((await failure({ error })).message, `${prefix} unavailable:exhausted-quota`);
  }
});

test('known billing messages remain bounded classifications', async () => {
  for (const message of ['Insufficient Balance', 'This request requires more credits, or fewer max_tokens.', 'Insufficient credits for this request']) {
    assert.equal((await failure({ error: { message } })).message, `${prefix} unavailable:insufficient-credit`);
  }
  assert.equal((await failure({ error: { message: 'You exceeded your current quota, please check billing.' } })).message, `${prefix} unavailable:exhausted-quota`);
});

test('missing model codes and messages do not turn invalid model parameters into unavailable', async () => {
  for (const error of [{ code: 'model_not_found' }, { message: 'The model requested-model does not exist or you do not have access to it.' }, { message: 'No endpoints found for requested-model.' }]) {
    assert.equal((await failure({ error })).message, `${prefix} unavailable:model-unavailable`);
  }
  assert.equal((await failure({ error: { message: 'This model does not support parameter temperature.' } })).message, prefix);
});

test('unknown JSON, echoed request data, and malformed bodies expose only HTTP status', async () => {
  for (const raw of ['not JSON: synthetic-secret', JSON.stringify({ request: { message: 'insufficient credits' } }), JSON.stringify({ error: { message: 'unrecognized synthetic-secret', actual: 'insufficient credits' } })]) {
    assert.equal((await providerFailure(new Response(raw, { status: 401 }))).message, 'Live conversation provider returned HTTP 401');
  }
});

test('oversized streaming bodies stop reading and are cancelled without classifying a prefix', async () => {
  let reads = 0;
  let cancellations = 0;
  const response: FetchResponseLike = {
    ok: false, status: 400,
    body: { getReader: () => ({
      read: async () => ({ done: false, value: ++reads === 1 ? new Uint8Array(32 * 1024) : new Uint8Array([32]) }),
      cancel: async () => { cancellations++; },
    }) },
    text: async () => { throw new Error('Stream responses must not call text'); },
    json: async () => { throw new Error('Never delegate unbounded JSON parsing'); },
  };
  assert.equal((await providerFailure(response)).message, prefix);
  assert.equal(reads, 2);
  assert.equal(cancellations, 1);
});

test('the byte limit accepts exactly 32 KiB and discards larger nonstream test responses', async () => {
  const body = JSON.stringify({ error: { code: 'insufficient_quota' } });
  const makeResponse = (text: string): FetchResponseLike => ({ ok: false, status: 400, text: async () => text, json: async () => { throw new Error('unused'); } });
  assert.equal((await providerFailure(makeResponse(body.padEnd(32 * 1024)))).message, `${prefix} unavailable:exhausted-quota`);
  assert.equal((await providerFailure(makeResponse(body.padEnd(32 * 1024 + 1)))).message, prefix);
  assert.equal((await providerFailure(makeResponse(body + '🐾'.repeat(9000)))).message, prefix);
});

test('stream read and cancellation errors cannot leak diagnostics or replace the safe error', async () => {
  let cancellations = 0;
  const response: FetchResponseLike = {
    ok: false, status: 503,
    body: { getReader: () => ({ read: async () => { throw new Error('synthetic-read-secret'); }, cancel: async () => { cancellations++; throw new Error('synthetic-cancel-secret'); } }) },
    text: async () => { throw new Error('unused'); }, json: async () => { throw new Error('unused'); },
  };
  const error = await providerFailure(response);
  assert.equal(error.message, 'Live conversation provider returned HTTP 503');
  assert.equal(error.cause, undefined);
  assert.equal(cancellations, 1);
});
