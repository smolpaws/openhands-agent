/** Run against an isolated SmolPaws server checkout; never touches a resident service. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { InMemorySecretStore, TestLLM, llmProfileSchema, type LLMClient, type LLMProfile, type SecretStore } from '../../src/index.js';
import { defaultAgentSettings } from '../../src/settings/index.js';
import { RemoteConversation } from '../../src/conversation/remote-conversation.js';

const serverRoot = resolve(process.argv[2] ?? '../smolpaws/packages/openhands-agent-server');
interface ProbeServer {
  app: { close(): Promise<void>; listen(options: { host: string; port: number }): Promise<string>; server: { address(): AddressInfo | string | null } };
  serverStateService: { saveProfile(profile: LLMProfile): Promise<LLMProfile> };
}
interface ProbeServerModule {
  createAgentServerApp(this: void, options: { secretStore: SecretStore; llmClientFactory: () => Promise<LLMClient>; config: Record<string, unknown> }): Promise<ProbeServer>;
}
const { createAgentServerApp } = await import(pathToFileURL(join(serverRoot, 'src/app.ts')).href) as ProbeServerModule;
const root = await mkdtemp(join(tmpdir(), 'remote-profile-contract-'));
let app: { close(): Promise<void> } | undefined;
try {
  const workingDir = join(root, 'workspace');
  await mkdir(workingDir);
  const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(),
    llmClientFactory: () => Promise.resolve(TestLLM.fromMessages([])),
    config: { conversationsPath: join(root, 'conversations'), workspaceRoot: workingDir,
      statePath: join(root, 'state'), bashEventsPath: join(root, 'bash'), allowedFileRoots: [workingDir], sessionApiKey: 'test-contract-key' },
  });
  app = server.app;
  await server.serverStateService.saveProfile(llmProfileSchema.parse({ profileId: 'requested-profile', providerId: 'openai', model: 'test-model' }));
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  assert(address !== null && typeof address !== 'string');
  const host = `http://127.0.0.1:${address.port}`;
  const options = { host, apiKey: 'test-contract-key' };
  const request = { workspace: { kind: 'LocalWorkspace' as const, working_dir: workingDir }, agentSettings: defaultAgentSettings('requested-profile') };
  const created = await RemoteConversation.create({ ...options, request });
  const info = await fetch(`${host}/api/conversations/${created.id}`, { headers: { 'x-session-api-key': options.apiKey } }).then(response => response.json());
  const resolved = info as { agent: { llm_profile_ref: string } };
  assert.equal(resolved.agent.llm_profile_ref, 'requested-profile');
  const attached = await RemoteConversation.attach({ ...options, conversationId: created.id });
  assert.equal(attached.id, created.id);
  assert.equal(attached.state.executionStatus, created.state.executionStatus);
  await assert.rejects(RemoteConversation.create({ ...options, request: { ...request, agentSettings: defaultAgentSettings('missing-profile') } }), /llm_profile_not_found/);
  console.log('Real TS server: requested profile preserved, create/attach succeeded, missing profile rejected.');
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
