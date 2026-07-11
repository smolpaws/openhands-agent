import { eventSchema, type Event } from '../event/index.js';
import type { FileStore } from '../io/index.js';

export const EVENTS_DIR = 'events';
export const EVENT_FILE_PATTERN = 'event-{idx}-{event_id}.json';
export const LOCK_FILE_NAME = '.eventlog.lock';
export const LOCK_TIMEOUT_SECONDS = 30;

const eventNamePattern = /^event-(?<idx>\d{5,})-(?<event_id>[0-9a-fA-F-]{8,})\.json$/u;

export class DuplicateEventError extends Error {
  constructor(eventId: string, index: number) {
    super(`Event with ID '${eventId}' already exists at index ${index}`);
    this.name = 'DuplicateEventError';
  }
}

export class EventLog {
  private readonly fs: FileStore;
  private readonly dir: string;
  private readonly lockPath: string;
  private readonly idToIndex = new Map<string, number>();
  private readonly indexToId = new Map<number, string>();
  private readonly eventCache = new Map<number, Event>();
  private lengthValue: number;

  constructor(fs: FileStore, dirPath = EVENTS_DIR) {
    this.fs = fs;
    this.dir = normalizeStoreDir(dirPath);
    this.lockPath = joinStorePath(this.dir, LOCK_FILE_NAME);
    this.lengthValue = this.scanAndBuildIndex();
  }

  get length(): number {
    return this.lengthValue;
  }

  getIndex(eventId: string): number {
    const index = this.idToIndex.get(eventId);
    if (index === undefined) {
      throw new Error(`Unknown event_id: ${eventId}`);
    }
    return index;
  }

  has(eventId: string): boolean {
    return this.idToIndex.has(eventId);
  }

  getId(index: number): string {
    const normalized = this.normalizeIndex(index);
    const eventId = this.indexToId.get(normalized);
    if (eventId === undefined) {
      throw new RangeError('Event index out of range');
    }
    return eventId;
  }

  get(index: number): Event {
    const normalized = this.normalizeIndex(index);
    const cached = this.eventCache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }

    let filePath = this.pathForIndex(normalized);
    if (filePath === null) {
      this.lengthValue = this.scanAndBuildIndex();
      filePath = this.pathForIndex(normalized);
      if (filePath === null) {
        throw new RangeError('Event index out of range');
      }
    }

    const event = eventSchema.parse(JSON.parse(this.fs.read(filePath)) as unknown);
    this.eventCache.set(normalized, event);
    return event;
  }

  at(index: number): Event | undefined {
    try {
      return this.get(index);
    } catch (error) {
      if (error instanceof RangeError) {
        return undefined;
      }
      throw error;
    }
  }

  slice(start?: number, end?: number): Event[] {
    return this.toArray().slice(start, end);
  }

  toArray(): Event[] {
    return [...this];
  }

  refresh(): void {
    this.syncFromDisk(this.countEventsOnDisk());
  }

  append(event: Event): void {
    this.appendMultiple([event]);
  }

  appendMultiple(events: readonly Event[]): void {
    if (events.length === 0) {
      return;
    }

    this.fs.lock(
      this.lockPath,
      () => {
        const diskLength = this.countEventsOnDisk();
        if (diskLength > this.lengthValue) {
          this.syncFromDisk(diskLength);
        }

        const batchIds = new Map<string, number>();
        for (const event of events) {
          const existingIndex = this.idToIndex.get(event.id);
          if (existingIndex !== undefined) {
            throw new DuplicateEventError(event.id, existingIndex);
          }
          const pendingIndex = batchIds.get(event.id);
          if (pendingIndex !== undefined) {
            throw new DuplicateEventError(event.id, pendingIndex);
          }
          batchIds.set(event.id, this.lengthValue + batchIds.size);
        }

        for (const event of events) {
          const index = this.lengthValue;
          this.fs.write(this.path(index, event.id), serializeEvent(event));
          this.indexToId.set(index, event.id);
          this.idToIndex.set(event.id, index);
          this.eventCache.set(index, event);
          this.lengthValue += 1;
        }
      },
      { timeoutSeconds: LOCK_TIMEOUT_SECONDS },
    );
  }

  [Symbol.iterator](): Iterator<Event> {
    let index = 0;
    return {
      next: (): IteratorResult<Event> => {
        if (index >= this.lengthValue) {
          return { done: true, value: undefined };
        }
        const value = this.get(index);
        index += 1;
        return { done: false, value };
      },
    };
  }

  private normalizeIndex(index: number): number {
    const normalized = index < 0 ? index + this.lengthValue : index;
    if (!Number.isInteger(normalized) || normalized < 0 || normalized >= this.lengthValue) {
      throw new RangeError('Event index out of range');
    }
    return normalized;
  }

  private countEventsOnDisk(): number {
    try {
      return this.fs.list(this.dir).filter((filePath) => isEventFileName(posixBasename(filePath))).length;
    } catch {
      return 0;
    }
  }

  private syncFromDisk(diskLength: number): void {
    const existingIndexToId = new Map(this.indexToId);
    const scannedLength = this.scanAndBuildIndex();
    for (const [index, eventId] of existingIndexToId) {
      if (!this.indexToId.has(index)) {
        this.indexToId.set(index, eventId);
      }
      if (!this.idToIndex.has(eventId)) {
        this.idToIndex.set(eventId, index);
      }
    }
    this.lengthValue = Math.max(scannedLength, diskLength);
  }

  private scanAndBuildIndex(): number {
    let paths: string[];
    try {
      paths = this.fs.list(this.dir);
    } catch {
      this.idToIndex.clear();
      this.indexToId.clear();
      this.eventCache.clear();
      return 0;
    }

    const byIndex = new Map<number, string>();
    for (const filePath of paths) {
      const match = eventNamePattern.exec(posixBasename(filePath));
      if (match?.groups === undefined) {
        continue;
      }
      const idx = match.groups.idx;
      const eventId = match.groups.event_id;
      if (idx === undefined || eventId === undefined) {
        continue;
      }
      byIndex.set(Number(idx), eventId);
    }

    this.idToIndex.clear();
    this.indexToId.clear();
    this.eventCache.clear();

    let length = 0;
    while (byIndex.has(length)) {
      length += 1;
    }

    for (let index = 0; index < length; index += 1) {
      const eventId = byIndex.get(index);
      if (eventId === undefined) {
        break;
      }
      this.indexToId.set(index, eventId);
      if (!this.idToIndex.has(eventId)) {
        this.idToIndex.set(eventId, index);
      }
    }
    return length;
  }

  private pathForIndex(index: number): string | null {
    const eventId = this.indexToId.get(index);
    return eventId === undefined ? null : this.path(index, eventId);
  }

  private path(index: number, eventId: string): string {
    const filename = EVENT_FILE_PATTERN.replace('{idx}', index.toString().padStart(5, '0')).replace('{event_id}', eventId);
    return joinStorePath(this.dir, filename);
  }
}

function serializeEvent(event: Event): string {
  return `${JSON.stringify(event, (_key, value: unknown) => (value instanceof Set ? [...value] : value))}\n`;
}

function isEventFileName(name: string): boolean {
  return name.startsWith('event-') && name.endsWith('.json');
}

function normalizeStoreDir(dirPath: string): string {
  return dirPath.replace(/^\/+|\/+$/gu, '') || '.';
}

function joinStorePath(basePath: string, childName: string): string {
  if (basePath.length === 0 || basePath === '.') {
    return childName;
  }
  return `${basePath.replace(/\/+$/u, '')}/${childName}`;
}

function posixBasename(filePath: string): string {
  return filePath.split('/').filter(Boolean).at(-1) ?? filePath;
}
