import { describe, expect, it } from 'vitest';

import { messageEventSchema, type Event } from '../../event/index.js';
import { InMemoryFileStore, type FileStore, type FileStoreLockOptions } from '../../io/index.js';
import { textContent } from '../../llm/index.js';
import { EVENT_FILE_PATTERN, EventLog } from '../event-log.js';
import { LocalConversation } from '../local-conversation.js';
import { ConversationState } from '../state.js';
import { Agent } from '../../agent/index.js';
import type { LLMClient, LLMCompletionResponse } from '../../llm/client.js';
import type { LLMProfile, Message } from '../../llm/index.js';
import { FinishTool } from '../../tool/builtins.js';

describe('EventLog upstream parity edge cases', () => {
  it('initializes empty and rejects out-of-range access', () => {
    const log = new EventLog(new InMemoryFileStore());

    expect(log.length).toBe(0);
    expect(log.toArray()).toEqual([]);
    expect(() => log.get(0)).toThrow(RangeError);
    expect(() => log.get(-1)).toThrow(RangeError);
  });

  it('prevents duplicate event ids including manually corrupted mappings', () => {
    const log = new EventLog(new InMemoryFileStore());

    log.append(userMessage('test-id-1', 'first'));
    expect(() => log.append(userMessage('test-id-1', 'second'))).toThrow(/already exists at index 0/u);

    internals(log).idToIndex.set('event-2', 0);
    expect(() => log.append(userMessage('event-2', 'second'))).toThrow(/already exists at index 0/u);
    expect(log.length).toBe(1);
  });

  it('supports negative indexing and id lookups', () => {
    const log = new EventLog(new InMemoryFileStore());
    const ids = [
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000103',
    ];
    ids.forEach((id) => log.append(userMessage(id, id)));

    expect(log.get(-1).id).toBe(ids[2]);
    expect(log.get(-2).id).toBe(ids[1]);
    expect(log.get(-3).id).toBe(ids[0]);
    expect(log.getIndex(ids[0]!)).toBe(0);
    expect(log.getId(-1)).toBe(ids[2]);
    expect(() => log.get(-4)).toThrow(RangeError);
    expect(() => log.getIndex('missing')).toThrow(/Unknown event_id/u);
  });

  it('keeps cached events after files disappear but fails on cold disk access', () => {
    const store = new InMemoryFileStore();
    const log = new EventLog(store);
    const id = '00000000-0000-4000-8000-000000000201';
    log.append(userMessage(id, 'content'));
    store.delete(`events/event-00000-${id}.json`);

    expect(log.get(0).id).toBe(id);
    internals(log).eventCache.clear();
    expect(() => log.get(0)).toThrow(/File not found/u);
  });

  it('matches upstream scan behavior for unrecognized corrupted names and index gaps', () => {
    const corruptedNameStore = new InMemoryFileStore({ 'events/event-00000-test-id.json': 'invalid json content' });
    expect(new EventLog(corruptedNameStore).length).toBe(0);

    const gapStore = new InMemoryFileStore();
    gapStore.write('events/event-00000-00000000-0000-4000-8000-000000000301.json', serialize(userMessage('00000000-0000-4000-8000-000000000301', 'zero')));
    gapStore.write('events/event-00002-00000000-0000-4000-8000-000000000303.json', serialize(userMessage('00000000-0000-4000-8000-000000000303', 'two')));

    const gapLog = new EventLog(gapStore);
    expect(gapLog.length).toBe(1);
    expect(gapLog.getId(0)).toBe('00000000-0000-4000-8000-000000000301');
    expect(() => gapLog.get(1)).toThrow(RangeError);
  });

  it('treats FileStore list failures as an empty log', () => {
    expect(new EventLog(new BrokenListFileStore()).length).toBe(0);
  });

  it('supports custom directories, large indexes, stale writers, and stale index recovery', () => {
    const store = new InMemoryFileStore();
    const customLog = new EventLog(store, 'custom_events');
    customLog.append(userMessage('custom-event', 'custom'));
    expect(store.list('custom_events')).toEqual(['custom_events/event-00000-custom-event.json']);

    const largeLog = new EventLog(new InMemoryFileStore());
    internals(largeLog).lengthValue = 99_999;
    largeLog.append(userMessage('large-index-event', 'large'));
    expect(largeLog.getIndex('large-index-event')).toBe(99_999);
    expect(largeLog.getId(99_999)).toBe('large-index-event');

    const sharedStore = new InMemoryFileStore();
    const log1 = new EventLog(sharedStore);
    const log2 = new EventLog(sharedStore);
    log1.append(userMessage('00000000-0000-4000-8000-000000000401', 'first'));
    log2.append(userMessage('00000000-0000-4000-8000-000000000402', 'second'));
    expect(log2.length).toBe(2);

    internals(log2).indexToId.clear();
    internals(log2).idToIndex.clear();
    internals(log2).eventCache.clear();
    expect(log2.get(0).id).toBe('00000000-0000-4000-8000-000000000401');

    internals(log2).indexToId.clear();
    internals(log2).idToIndex.clear();
    internals(log2).eventCache.clear();
    internals(log2).lengthValue = 5;
    expect(() => log2.get(3)).toThrow(RangeError);
  });

  it('does not inflate length or duplicate indexes when syncing past disk gaps', () => {
    const store = new InMemoryFileStore();
    const zeroId = '00000000-0000-4000-8000-000000000701';
    const gapId = '00000000-0000-4000-8000-000000000703';
    const fillId = '00000000-0000-4000-8000-000000000702';
    store.write(`events/event-00000-${zeroId}.json`, serialize(userMessage(zeroId, 'zero')));
    const log = new EventLog(store);
    store.write(`events/event-00002-${gapId}.json`, serialize(userMessage(gapId, 'two')));

    log.append(userMessage(fillId, 'one'));

    expect(log.length).toBe(2);
    expect(log.toArray().map((event) => event.id)).toEqual([zeroId, fillId]);
    expect(store.list('events').filter((filePath) => filePath.includes('event-00002-'))).toEqual([`events/event-00002-${gapId}.json`]);
  });


  it('caches repeated deserialization and iteration results', () => {
    const log = new EventLog(new InMemoryFileStore());
    log.append(userMessage('cached-event-a', 'a'));
    log.append(userMessage('cached-event-b', 'b'));

    expect(log.get(0)).toBe(log.get(0));

    internals(log).eventCache.clear();
    const firstPass = log.toArray();
    const secondPass = log.toArray();
    expect(internals(log).eventCache.size).toBe(2);
    expect(firstPass[0]).toBe(secondPass[0]);
    expect(firstPass[1]).toBe(secondPass[1]);
  });

  it('cold-reloads event filenames past the 100k index boundary', () => {
    const store = new MapFileStore();
    const payload = serialize(userMessage('seed', 'seed'));
    const count = 100_002;

    for (let index = 0; index < count; index += 1) {
      const eventId = `${index.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
      const fileName = EVENT_FILE_PATTERN.replace('{idx}', index.toString().padStart(5, '0')).replace('{event_id}', eventId);
      store.write(`events/${fileName}`, payload);
    }

    const log = new EventLog(store);

    expect(log.length).toBe(count);
    expect(log.get(99_999)).toBeDefined();
    expect(log.get(100_000)).toBeDefined();
    expect(log.get(100_001)).toBeDefined();

    log.append(userMessage('ffffffff-0000-4000-8000-000000000000', 'after'));
    expect(log.length).toBe(count + 1);
  });
});

describe('ConversationState and LocalConversation persistence edge cases', () => {
  it('does not crash when constructor events are already persisted', () => {
    const event = userMessage('00000000-0000-4000-8000-000000000601', 'already there');
    const eventLog = new EventLog(new InMemoryFileStore());
    eventLog.append(event);

    const state = new ConversationState({ eventLog, events: [event] });

    expect(state.events.map((stored) => stored.id)).toEqual([event.id]);
  });

  it('syncs very large event arrays without spreading into push arguments', () => {
    const state = new ConversationState();
    const event = userMessage('00000000-0000-4000-8000-000000000604', 'large');
    const events = Array.from({ length: 150_000 }, () => event);
    const eventLog = {
      refresh() {},
      toArray() {
        return events;
      },
    } as EventLog;
    (state as unknown as { eventLog: EventLog | null }).eventLog = eventLog;

    expect(() => state.syncFromDisk()).not.toThrow();
    expect(state.events).toHaveLength(events.length);
  });

  it('refreshes the EventLog before rebuilding in-memory events', () => {
    const store = new InMemoryFileStore();
    const state = new ConversationState({ eventLog: new EventLog(store) });
    state.appendEvent(userMessage('00000000-0000-4000-8000-000000000602', 'first'));

    new EventLog(store).append(userMessage('00000000-0000-4000-8000-000000000603', 'second'));
    state.syncFromDisk();

    expect(state.events.map((event) => event.id)).toEqual([
      '00000000-0000-4000-8000-000000000602',
      '00000000-0000-4000-8000-000000000603',
    ]);
  });

  it('treats conversationId-only construction as persistent and preserves explicit ids with state', () => {
    const persistent = new LocalConversation({ agent: fakeAgent(), conversationId: 'conv-id-only' });
    expect(persistent.conversationId).toBe('conv-id-only');
    expect(persistent.state.eventLog).not.toBeNull();

    const state = new ConversationState();
    const withState = new LocalConversation({ agent: fakeAgent(), state, conversationId: 'explicit-id' });
    expect(withState.conversationId).toBe('explicit-id');
    expect(withState.state).toBe(state);
  });
});

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

function serialize(event: Event): string {
  return `${JSON.stringify(event)}\n`;
}

interface EventLogInternals {
  lengthValue: number;
  idToIndex: Map<string, number>;
  indexToId: Map<number, string>;
  eventCache: Map<number, Event>;
}

function internals(log: EventLog): EventLogInternals {
  return log as unknown as EventLogInternals;
}

class BrokenListFileStore implements FileStore {
  write(_filePath: string, _contents: string | Buffer): void {}
  read(_filePath: string): string {
    throw new Error('not used');
  }
  list(_filePath: string): string[] {
    throw new Error('File system error');
  }
  delete(_filePath: string): void {}
  exists(_filePath: string): boolean {
    return false;
  }
  getAbsolutePath(filePath: string): string {
    return filePath;
  }
  lock<T>(_filePath: string, callback: () => T, _options?: FileStoreLockOptions): T {
    return callback();
  }
}

class MapFileStore implements FileStore {
  private readonly files = new Map<string, string>();

  write(filePath: string, contents: string | Buffer): void {
    this.files.set(filePath, typeof contents === 'string' ? contents : contents.toString('utf8'));
  }

  read(filePath: string): string {
    const contents = this.files.get(filePath);
    if (contents === undefined) {
      throw new Error(`File not found: ${filePath}`);
    }
    return contents;
  }

  list(filePath: string): string[] {
    const prefix = filePath.replace(/\/+$/u, '');
    return [...this.files.keys()].filter((storedPath) => storedPath.startsWith(`${prefix}/`) || storedPath === prefix);
  }

  delete(filePath: string): void {
    this.files.delete(filePath);
  }

  exists(filePath: string): boolean {
    return this.files.has(filePath);
  }

  getAbsolutePath(filePath: string): string {
    return filePath;
  }

  lock<T>(_filePath: string, callback: () => T, _options?: FileStoreLockOptions): T {
    return callback();
  }
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
    headers: {},
    useProfileKeyOverride: false,
  };

  complete(_messages: readonly Message[]): Promise<LLMCompletionResponse> {
    throw new Error('FakeLLM should not be called by persistence tests');
  }
}
