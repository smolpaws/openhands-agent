import oracle from '../__fixtures__/python-remote-contract.json';
import manifest from '../../../transpile/upstream.json';
import { describe, expect, it } from 'vitest';
import { defaultAgentSettings } from '../../settings/index.js';
import { RemoteWorkspace } from '../../workspace/index.js';
import { ConversationState } from '../state.js';
import { RemoteConversation, type RemoteFetchLike } from '../remote-conversation.js';

const ID = '12345678-1234-1234-1234-123456789abc';
const workspace = { kind: 'LocalWorkspace' as const, working_dir: '/workspace' };
function transport(info: unknown = { id: ID, execution_status: 'idle' }) {
  const calls: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const fetch: RemoteFetchLike = { async request(url, init) {
    calls.push({ url, method: init.method, body: JSON.parse(init.body ?? '{}') });
    return { ok: true, status: 200, json: async () => info, text: async () => JSON.stringify(info) };
  } };
  return { fetch, calls };
}

describe('remote creation and attachment contract', () => {
  it('ports the pinned Python profile creation configuration', async () => {
    const { fetch, calls } = transport();
    const hookConfig = { stop: [{ hooks: [{ command: 'true' }] }] };
    await RemoteConversation.create({ host: 'http://test', server: 'python', fetch, request: {
      workspace, agentProfileId: ID, conversationId: ID, maxIterations: 17,
      stuckDetection: false, hookConfig, tags: { automationrun: 'run-one' },
      observabilityMetadata: { run: 'one' }, observabilityTags: ['automation'],
      observabilitySpanName: 'scheduled-task', userId: 'operator', worktree: false,
      initialMessage: { role: 'user', content: [], run: false }, autotitle: false,
      titleLlmProfile: 'titles', agentLaunchAdditions: { system_message_suffix_append: 'context' },
    } });
    expect(oracle.upstreamCommit).toBe(manifest.commit);
    expect(calls[0]?.body).toEqual(oracle.validatedCreatePayload);
  });
  it('maps TS settings to the server agent field, preserving selected profile', async () => {
    const { fetch, calls } = transport();
    const agentSettings = defaultAgentSettings('requested-profile');
    await RemoteConversation.create({ host: 'http://test', fetch, request: { workspace, agentSettings } });
    expect(calls[0]?.body).toEqual({ workspace, agent: agentSettings });
  });
  it.each([
    { server: 'smolpaws' as const, request: { workspace, agentProfileId: ID } },
    { server: 'python' as const, request: { workspace, agentSettings: defaultAgentSettings('main') } },
    { server: 'python' as const, request: { workspace, agentProfileId: ID, agentSettings: defaultAgentSettings('main') } },
    { server: 'smolpaws' as const, request: { workspace } },
  ])('rejects incompatible or absent profile selection before network ($server)', async options => {
    const { fetch, calls } = transport();
    await expect(RemoteConversation.create({ host: 'http://test', fetch, ...options })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it.each([
    { id: 'not-a-uuid', execution_status: 'idle' },
    { id: ID },
    { id: ID, execution_status: 'unknown' },
    { id: ID, execution_status: null },
  ])('rejects malformed create/attach responses without mutating caller state (%j)', async info => {
    for (const operation of ['create', 'attach'] as const) {
      const { fetch } = transport(info);
      const state = new ConversationState();
      state.executionStatus = 'paused';
      const promise = operation === 'create'
        ? RemoteConversation.create({ host: 'http://test', fetch, state, request: { workspace, agentSettings: defaultAgentSettings('main') } })
        : RemoteConversation.attach({ host: 'http://test', fetch, state, conversationId: ID });
      await expect(promise).rejects.toThrow(/Invalid response/u);
      expect(state.executionStatus).toBe('paused');
    }
  });
  it.each(oracle.uuids)('normalizes upstream UUID form $input', async ({ input: id, canonical }) => {
    expect(new RemoteWorkspace({ host: 'http://test', runtimeConversationId: id }).runtimeConversationId).toBe(canonical);
    const { fetch, calls } = transport({ id, execution_status: 'finished' });
    const conversation = await RemoteConversation.attach({ host: 'http://test', fetch, conversationId: id });
    expect(conversation.id).toBe(canonical);
    expect(conversation.state.executionStatus).toBe('finished');
    expect(calls[0]?.url).toBe(`http://test/api/conversations/${ID}`);
  });
  it.each(oracle.invalidUuids)('rejects invalid pinned UUID input %j before requests', async id => {
    expect(() => new RemoteWorkspace({ host: 'http://test', runtimeConversationId: id })).toThrow(/valid UUID/u);
    const { fetch, calls } = transport();
    await expect(RemoteConversation.attach({ host: 'http://test', fetch, conversationId: id })).rejects.toThrow(/valid UUID/u);
    expect(calls).toHaveLength(0);
  });
});
