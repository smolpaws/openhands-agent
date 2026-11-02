// PORT: OpenHands/software-agent-sdk#6364 (eebe235ee537ed085f2cf3a351a5be687ff5e034).
// Adapt test_subscription_mode.py's session-header regressions at the actual native wire boundary.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../../agent/index.js';
import { LocalConversation } from '../../conversation/local-conversation.js';
import { InMemoryFileStore } from '../../io/index.js';
import { InMemorySecretStore } from '../../secrets/index.js';
import { CredentialStore, OAuthCredentials, OpenAISubscriptionAuth } from '../auth/index.js';
import { LLMCallContext, withLLMCallContext } from '../call-context.js';
import type { FetchLike } from '../client.js';
import { createClientFromProfile } from '../factory.js';
import { llmProfileSchema } from '../index.js';
import { OpenAIResponsesClient } from '../openai.js';

const dirs: string[] = [];
const completed = { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] };
type Request = Parameters<FetchLike>[1];

afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

async function subscriptionClient(options: {
  headers?: Readonly<Record<string, string>>;
  onRequest?: (request: Request) => Promise<void>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'subscription-cache-'));
  dirs.push(dir);
  const credentialStore = new CredentialStore(dir);
  credentialStore.save(new OAuthCredentials({ vendor: 'openai', access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Date.now() + 3_600_000 }));
  const requests: Request[] = [];
  const client = await createClientFromProfile(llmProfileSchema.parse({
    profileId: 'subscription-cache', providerId: 'openai', model: 'gpt-6-astra', authType: 'subscription', headers: options.headers,
  }), new InMemorySecretStore(), {
    subscriptionAuth: new OpenAISubscriptionAuth({ credentialStore }),
    fetch: async (_url, request) => {
      requests.push(request);
      await options.onRequest?.(request);
      return { ok: true, status: 200, json: async () => completed,
        text: async () => `data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n` };
    },
  });
  return { client, requests };
}

describe('Codex subscription conversation cache identity', () => {
  it('sends Codex session headers and a prompt cache key for a conversation', async () => {
    const { client, requests } = await subscriptionClient();
    await client.complete([], undefined, { callContext: LLMCallContext.forConversation('conv-abc') });
    expect(JSON.parse(requests[0]!.body).prompt_cache_key).toBe('conv-abc');
    expect(requests[0]!.headers).toMatchObject({ 'x-litellm-session-id': 'conv-abc', 'session-id': 'conv-abc', 'thread-id': 'conv-abc' });
  });

  it('does not invent Codex session headers without a conversation', async () => {
    const { client, requests } = await subscriptionClient();
    await client.complete([]);
    expect(requests[0]!.headers).not.toHaveProperty('session-id');
    expect(requests[0]!.headers).not.toHaveProperty('thread-id');
    expect(JSON.parse(requests[0]!.body)).not.toHaveProperty('prompt_cache_key');
  });

  it('does not add Codex session headers to ordinary API Responses calls', async () => {
    const requests: Request[] = [];
    const client = new OpenAIResponsesClient(llmProfileSchema.parse({ profileId: 'api', providerId: 'openai', model: 'gpt-6-astra' }), 'test-key', async (_url, request) => {
      requests.push(request);
      return { ok: true, status: 200, json: async () => completed, text: async () => JSON.stringify(completed) };
    });
    await client.complete([], undefined, { callContext: LLMCallContext.forConversation('conv-abc') });
    expect(requests[0]!.headers['x-litellm-session-id']).toBe('conv-abc');
    expect(requests[0]!.headers).not.toHaveProperty('session-id');
    expect(requests[0]!.headers).not.toHaveProperty('thread-id');
  });

  it('uses conversation identity for session headers when the cache shard is shared', async () => {
    const { client, requests } = await subscriptionClient();
    await client.complete([], undefined, { callContext: LLMCallContext.forConversation('child', { promptCacheKey: 'shared-shard' }) });
    expect(JSON.parse(requests[0]!.body).prompt_cache_key).toBe('shared-shard');
    expect(requests[0]!.headers).toMatchObject({ 'session-id': 'child', 'thread-id': 'child' });
  });

  it('replaces stale session headers case-insensitively without mutating the saved profile', async () => {
    const headers = { 'Session-ID': 'stale-session', 'session-id': 'also-stale', 'THREAD-id': 'stale-thread', 'x-other': 'preserved' };
    const { client, requests } = await subscriptionClient({ headers });
    await client.complete([], undefined, { callContext: LLMCallContext.forConversation('current') });
    expect(Object.fromEntries(Object.entries(requests[0]!.headers).filter(([name]) => ['session-id', 'thread-id'].includes(name.toLowerCase()))))
      .toEqual({ 'session-id': 'current', 'thread-id': 'current' });
    expect(requests[0]!.headers['x-other']).toBe('preserved');
    expect(client.profile.headers).toEqual(headers);
  });

  it('preserves caller-supplied headers when an empty context suppresses ambient identity', async () => {
    const headers = { 'Session-ID': 'caller-session', 'thread-id': 'caller-thread' };
    const { client, requests } = await subscriptionClient({ headers });
    await withLLMCallContext(LLMCallContext.forConversation('ambient'), () => client.complete([], undefined, { callContext: new LLMCallContext() }));
    expect(requests[0]!.headers).toMatchObject(headers);
    expect(requests[0]!.headers).not.toHaveProperty('session-id');
    expect(requests[0]!.headers).not.toHaveProperty('x-litellm-session-id');
  });

  it('isolates overlapping conversation scopes sharing one subscription client', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { client, requests } = await subscriptionClient({ onRequest: async request => {
      if (JSON.parse(request.body).prompt_cache_key === 'one') { entered.resolve(); await release.promise; }
    } });
    const first = withLLMCallContext(LLMCallContext.forConversation('one'), () => client.complete([]));
    await entered.promise;
    try {
      await withLLMCallContext(LLMCallContext.forConversation('two'), () => client.complete([]));
    } finally {
      release.resolve();
      await first;
    }
    expect(requests.map(request => [JSON.parse(request.body).prompt_cache_key, request.headers['session-id'], request.headers['thread-id']]))
      .toEqual([['one', 'one', 'one'], ['two', 'two', 'two']]);
    await client.complete([]);
    expect(requests[2]!.headers).not.toHaveProperty('session-id');
    expect(requests[2]!.headers).not.toHaveProperty('thread-id');
  });

  it('retains the session identity when a persisted conversation resumes', async () => {
    const { client, requests } = await subscriptionClient();
    const fileStore = new InMemoryFileStore();
    const first = new LocalConversation({ agent: new Agent({ llm: client }), fileStore, conversationId: 'resumed' });
    first.sendMessage('first turn');
    await first.run();
    first.close();
    const restored = new LocalConversation({ agent: new Agent({ llm: client }), fileStore, conversationId: 'resumed' });
    restored.sendMessage('second turn');
    await restored.run();
    restored.close();
    expect(requests).toHaveLength(2);
    expect(requests.map(request => [JSON.parse(request.body).prompt_cache_key, request.headers['session-id'], request.headers['thread-id']]))
      .toEqual([['resumed', 'resumed', 'resumed'], ['resumed', 'resumed', 'resumed']]);
  });
});
