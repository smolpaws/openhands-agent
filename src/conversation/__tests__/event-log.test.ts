import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { Agent } from '../../agent/index.js';
import { messageEventSchema, type Event } from '../../event/index.js';
import { InMemoryFileStore, LocalFileStore, type FileStoreLockOptions } from '../../io/index.js';
import type { LLMClient, LLMCompletionResponse } from '../../llm/client.js';
import { textContent, type LLMProfile, type Message } from '../../llm/index.js';
import { FinishTool } from '../../tool/builtins.js';
import { EventLog } from '../event-log.js';
import { LocalConversation } from '../local-conversation.js';
import { ConversationState } from '../state.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('EventLog', () => {
  it('persists each appended event as an indexed event file', async () => {
    const dir = await tempDir();
    const store = new LocalFileStore(dir);
    const log = new EventLog(store);
    const event = userMessage('00000000-0000-4000-8000-000000000001', 'hello');

    log.append(event);

    expect(log.length).toBe(1);
    expect(store.list('events')).toEqual(['events/event-00000-00000000-0000-4000-8000-000000000001.json']);
    expect(JSON.parse(store.read('events/event-00000-00000000-0000-4000-8000-000000000001.json'))).toMatchObject({
      id: event.id,
      kind: 'MessageEvent',
      llm_message: { role: 'user' },
    });
  });

  it('persists events without null-valued optional fields like upstream exclude_none', async () => {
    const dir = await tempDir();
    const store = new LocalFileStore(dir);
    const log = new EventLog(store);
    const event = userMessage('00000000-0000-4000-8000-000000000108', 'hello');

    log.append(event);

    const persisted = JSON.parse(store.read('events/event-00000-00000000-0000-4000-8000-000000000108.json')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('llm_response_id');
    expect(persisted).not.toHaveProperty('sender');
    expect(persisted).not.toHaveProperty('critic_result');
    const message = persisted.llm_message as Record<string, unknown>;
    expect(message).not.toHaveProperty('tool_calls');
    expect(message).not.toHaveProperty('tool_call_id');
    expect(message).not.toHaveProperty('name');
    expect(message).not.toHaveProperty('reasoning_content');
    expect(message).not.toHaveProperty('responses_reasoning_item');
  });

  it('restores events from an existing event directory on open', async () => {
    const dir = await tempDir();
    const first = new EventLog(new LocalFileStore(dir));
    const events = [
      userMessage('00000000-0000-4000-8000-000000000002', 'first'),
      userMessage('00000000-0000-4000-8000-000000000003', 'second'),
    ];
    events.forEach((event) => first.append(event));

    const restored = new EventLog(new LocalFileStore(dir));

    expect(restored.length).toBe(2);
    expect(restored.getId(1)).toBe(events[1]?.id);
    expect(restored.getIndex(events[0]?.id ?? '')).toBe(0);
    expect(restored.toArray()).toEqual(events);
  });

  it('syncs stale writers from disk and rejects duplicate event ids', async () => {
    const dir = await tempDir();
    const store = new LocalFileStore(dir);
    const first = new EventLog(store);
    const staleSecondWriter = new EventLog(store);
    const event = userMessage('00000000-0000-4000-8000-000000000004', 'same');

    first.append(event);

    expect(() => staleSecondWriter.append(event)).toThrow(/already exists at index 0/u);
    expect(new EventLog(store).toArray().map((restored) => restored.id)).toEqual([event.id]);
  });

  it('checks membership and appends event batches under one lock', () => {
    const store = new CountingMemoryFileStore();
    const log = new EventLog(store);
    const events = [
      userMessage('00000000-0000-4000-8000-000000000104', 'first'),
      userMessage('00000000-0000-4000-8000-000000000105', 'second'),
    ];

    log.appendMultiple(events);

    expect(store.lockCount).toBe(1);
    expect(log.has(events[0]?.id ?? '')).toBe(true);
    expect(log.has('missing')).toBe(false);
    expect(log.toArray()).toEqual(events);
    expect(() => log.appendMultiple([userMessage('dup', 'a'), userMessage('dup', 'b')])).toThrow(/already exists at index 2/u);
  });

  it('appends event batches through the async FileStore lock API', async () => {
    const store = new CountingMemoryFileStore();
    const log = new EventLog(store);
    const events = [
      userMessage('00000000-0000-4000-8000-000000000109', 'first'),
      userMessage('00000000-0000-4000-8000-000000000110', 'second'),
    ];

    await log.appendMultipleAsync(events);

    expect(store.asyncLockCount).toBe(1);
    expect(store.lockCount).toBe(0);
    expect(log.toArray()).toEqual(events);
  });

});

describe('ConversationState disk-backed events', () => {
  it('uses EventLog as source of truth for append and fresh restore', async () => {
    const dir = await tempDir();
    const event = userMessage('00000000-0000-4000-8000-000000000005', 'persist me');
    const state = new ConversationState({ eventLog: new EventLog(new LocalFileStore(dir)) });

    state.appendEvent(event);

    const restored = new ConversationState({ eventLog: new EventLog(new LocalFileStore(dir)) });
    expect(restored.events).toEqual([event]);
  });

  it('can append batches through the EventLog async lock path', async () => {
    const store = new CountingMemoryFileStore();
    const events = [
      userMessage('00000000-0000-4000-8000-000000000111', 'async persist me'),
      userMessage('00000000-0000-4000-8000-000000000112', 'async persist me too'),
    ];
    const state = new ConversationState({ eventLog: new EventLog(store) });

    await expect(state.appendEventsAsync(events)).resolves.toEqual(events);

    expect(store.asyncLockCount).toBe(1);
    expect(store.lockCount).toBe(0);
    expect(state.events).toEqual(events);
  });

  it('seeds missing constructor events with one EventLog lock', () => {
    const store = new CountingMemoryFileStore();
    const eventLog = new EventLog(store);
    const alreadyPersisted = userMessage('00000000-0000-4000-8000-000000000106', 'already');
    const missing = userMessage('00000000-0000-4000-8000-000000000107', 'missing');
    eventLog.append(alreadyPersisted);
    store.lockCount = 0;

    const state = new ConversationState({ eventLog, events: [alreadyPersisted, missing] });

    expect(store.lockCount).toBe(1);
    expect(state.events.map((event) => event.id)).toEqual([alreadyPersisted.id, missing.id]);
  });

});

describe('LocalConversation event log persistence', () => {
  it('persists user events to a conversation directory and restores them after restart', async () => {
    const conversationsDir = await tempDir();
    const conversationId = 'conv-00000000-0000-4000-8000-000000000006';
    const first = new LocalConversation({
      agent: fakeAgent(),
      conversationsDir,
      conversationId,
    });

    first.sendMessage('hello after restart');

    const restored = new LocalConversation({
      agent: fakeAgent(),
      conversationsDir,
      conversationId,
    });

    expect(restored.conversationId).toBe(conversationId);
    expect(restored.state.events).toHaveLength(1);
    expect(restored.state.events[0]).toMatchObject({
      kind: 'MessageEvent',
      llm_message: { role: 'user', content: [{ type: 'text', text: 'hello after restart' }] },
    });
  });
});

class CountingMemoryFileStore extends InMemoryFileStore {
  lockCount = 0;
  asyncLockCount = 0;

  lock<T>(filePath: string, callback: () => T, options?: FileStoreLockOptions): T {
    this.lockCount += 1;
    return super.lock(filePath, callback, options);
  }

  async lockAsync<T>(filePath: string, callback: () => T | Promise<T>, options?: FileStoreLockOptions): Promise<T> {
    this.asyncLockCount += 1;
    return super.lockAsync(filePath, callback, options);
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openhands-event-log-'));
  tempDirs.push(dir);
  return dir;
}

function userMessage(id: string, text: string): Event {
  return messageEventSchema.parse({
    id,
    source: 'user',
    llm_message: {
      role: 'user',
      content: [textContent(text)],
    },
  });
}

function fakeAgent(): Agent {
  return new Agent({ llm: new FakeLLM(), tools: [FinishTool.create()] });
}

class FakeLLM implements LLMClient {
  readonly profile: LLMProfile = {
    profileId: 'fake',
    providerId: 'fake',
    model: 'fake',
    baseUrl: null,
    openAiApiMode: 'chat_completions',
    temperature: null,
    topP: null,
    topK: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    timeoutSeconds: null,
    reasoningEffort: null,
    reasoningSummary: null,
    promptCacheRetention: null,
    promptCacheKey: null,
    headers: {},
    useProfileKeyOverride: false,
  };

  complete(_messages: readonly Message[]): Promise<LLMCompletionResponse> {
    throw new Error('FakeLLM should not be called by persistence tests');
  }
}
