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
