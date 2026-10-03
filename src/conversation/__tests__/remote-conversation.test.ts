import { describe, expect, it } from 'vitest';

import { textContent } from '../../llm/index.js';
import { conversationExecutionStatus } from '../state.js';
import { RemoteConversation, type RemoteFetchLike, type RemoteFetchResponseLike } from '../remote-conversation.js';

describe('RemoteConversation', () => {
  it('posts user messages without implicitly running', async () => {
    const fetch = new FakeRemoteFetch([{ status: 204, body: null }]);
    const conversation = new RemoteConversation({ host: 'https://agent.example', conversationId: 'abc', fetch });

    await conversation.sendMessage('hello', 'engel');

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({ url: 'https://agent.example/api/conversations/abc/events', method: 'POST' });
    expect(JSON.parse(fetch.calls[0]?.body ?? '{}')).toEqual({
      role: 'user',
      content: [textContent('hello')],
      run: false,
      sender: 'engel',
    });
  });

  it('triggers a run and polls until terminal status when blocking', async () => {
    const fetch = new FakeRemoteFetch([
      { status: 204, body: null },
      { status: 200, body: { execution_status: 'running' } },
      { status: 200, body: { execution_status: 'finished' } },
    ]);
    const conversation = new RemoteConversation({ host: 'https://agent.example', conversationId: 'abc', fetch });

    await conversation.run({ pollIntervalMs: 1, timeoutMs: 100 });

    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://agent.example/api/conversations/abc/run',
      'GET https://agent.example/api/conversations/abc',
      'GET https://agent.example/api/conversations/abc',
    ]);
    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.FINISHED);
  });

  it('renames the conversation through the info endpoint', async () => {
    const fetch = new FakeRemoteFetch([{ status: 204, body: null }]);
    const conversation = new RemoteConversation({ host: 'https://agent.example', conversationId: 'abc', fetch });

    await conversation.setTitle('Release automation');

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({ url: 'https://agent.example/api/conversations/abc', method: 'PATCH' });
    expect(JSON.parse(fetch.calls[0]?.body ?? '{}')).toEqual({ title: 'Release automation' });
  });

  it('can pause or interrupt remotely', async () => {
    const fetch = new FakeRemoteFetch([
      { status: 204, body: null },
      { status: 204, body: null },
    ]);
    const conversation = new RemoteConversation({ host: 'https://agent.example', conversationId: 'abc', fetch });

    await conversation.pause();
    await conversation.interrupt();

    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://agent.example/api/conversations/abc/pause',
      'POST https://agent.example/api/conversations/abc/interrupt',
    ]);
  });

  it('creates by POSTing the profile-first request and adopts the returned id and status', async () => {
    const fetch = new FakeRemoteFetch([{ status: 200, body: { id: '00000000-0000-0000-0000-000000000002', execution_status: 'running' } }]);
    const conversation = await RemoteConversation.create({
      host: 'https://agent.example',
      server: 'python', request: { workspace: { kind: 'LocalWorkspace', working_dir: '/workspace' }, agentProfileId: '00000000-0000-0000-0000-000000000001', maxIterations: 17 },
      fetch,
    });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({ url: 'https://agent.example/api/conversations', method: 'POST' });
    expect(JSON.parse(fetch.calls[0]?.body ?? '{}')).toEqual({
      workspace: { kind: 'LocalWorkspace', working_dir: '/workspace' },
      agent_profile_id: '00000000-0000-0000-0000-000000000001',
      max_iterations: 17,
    });
    expect(conversation.id).toBe('00000000-0000-0000-0000-000000000002');
    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.RUNNING);
  });

  it('attaches by GETting the existing conversation without creating', async () => {
    const fetch = new FakeRemoteFetch([{ status: 200, body: { id: '00000000-0000-0000-0000-000000000003', execution_status: 'finished' } }]);
    const conversation = await RemoteConversation.attach({ host: 'https://agent.example', conversationId: '00000000-0000-0000-0000-000000000003', fetch });

    expect(fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://agent.example/api/conversations/00000000-0000-0000-0000-000000000003',
    ]);
    expect(conversation.id).toBe('00000000-0000-0000-0000-000000000003');
    expect(conversation.state.executionStatus).toBe(conversationExecutionStatus.FINISHED);
  });

  it.each([403, 404])('attach propagates HTTP %s without probing an existing conversation', async (status) => {
    const fetch = new FakeRemoteFetch([{ status, body: { detail: 'not found' } }]);
    await expect(
      RemoteConversation.attach({ host: 'https://agent.example', conversationId: '00000000-0000-0000-0000-000000000003', fetch }),
    ).rejects.toThrow(`Remote conversation request failed with HTTP ${status}`);
    expect(fetch.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it.each([403, 404])('create propagates HTTP %s without probing an existing conversation', async (status) => {
    const fetch = new FakeRemoteFetch([{ status, body: { detail: 'forbidden' } }]);
    await expect(
      RemoteConversation.create({ host: 'https://agent.example', server: 'python', request: { workspace: { kind: 'LocalWorkspace', working_dir: '/workspace' }, agentProfileId: '00000000-0000-0000-0000-000000000001' }, fetch }),
    ).rejects.toThrow(`Remote conversation request failed with HTTP ${status}`);
    expect(fetch.calls.map((call) => call.method)).toEqual(['POST']);
  });
});

interface FakeResponse {
  readonly status: number;
  readonly body: unknown;
}

class FakeRemoteFetch implements RemoteFetchLike {
  readonly calls: { url: string; method: string; body: string | null }[] = [];
  private readonly responses: FakeResponse[];

  constructor(responses: readonly FakeResponse[]) {
    this.responses = [...responses];
  }

  async request(url: string, init: { readonly method: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }): Promise<RemoteFetchResponseLike> {
    this.calls.push({ url, method: init.method, body: init.body ?? null });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error('FakeRemoteFetch exhausted');
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  }
}
