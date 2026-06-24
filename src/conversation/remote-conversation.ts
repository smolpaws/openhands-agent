import { textContent, messageSchema, type Message } from '../llm/index.js';
import { ConversationState, conversationExecutionStatus, type ConversationExecutionStatus } from './state.js';

export interface RemoteFetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RemoteFetchLike {
  request(url: string, init: { readonly method: string; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }): Promise<RemoteFetchResponseLike>;
}

export interface RemoteConversationOptions {
  readonly host: string;
  readonly conversationId: string;
  readonly fetch?: RemoteFetchLike;
  readonly apiKey?: string | null;
  readonly state?: ConversationState;
}

export interface RemoteRunOptions {
  readonly blocking?: boolean;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export class RemoteConversation {
  readonly host: string;
  readonly id: string;
  readonly state: ConversationState;
  private readonly fetcher: RemoteFetchLike;
  private readonly apiKey: string | null;

  constructor(options: RemoteConversationOptions) {
    this.host = options.host.replace(/\/+$/, '');
    this.id = options.conversationId;
    this.state = options.state ?? new ConversationState();
    this.fetcher = options.fetch ?? globalRemoteFetch();
    this.apiKey = options.apiKey ?? null;
  }

  async sendMessage(message: string | Message, sender?: string): Promise<void> {
    const parsed = typeof message === 'string' ? userMessage(message) : messageSchema.parse(message);
    if (parsed.role !== 'user') {
      throw new Error('Only user messages can be sent to a remote conversation');
    }
    await this.request('POST', `${this.actionBasePath}/events`, {
      role: parsed.role,
      content: parsed.content,
      run: false,
      ...(sender === undefined ? {} : { sender }),
    });
  }

  async run(options: RemoteRunOptions = {}): Promise<void> {
    const blocking = options.blocking ?? true;
    await this.request('POST', `${this.actionBasePath}/run`, undefined, new Set([200, 201, 204, 409]));
    if (!blocking) {
      this.state.executionStatus = conversationExecutionStatus.RUNNING;
      return;
    }
    await this.waitForRunCompletion(options.pollIntervalMs ?? 1000, options.timeoutMs ?? 3_600_000);
  }

  async rejectPendingActions(reason = 'User rejected the action'): Promise<void> {
    await this.request('POST', `${this.actionBasePath}/events/respond_to_confirmation`, { accept: false, reason });
  }

  async pause(): Promise<void> {
    await this.request('POST', `${this.actionBasePath}/pause`);
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }

  async interrupt(): Promise<void> {
    await this.request('POST', `${this.actionBasePath}/interrupt`);
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }

  private async waitForRunCompletion(pollIntervalMs: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const status = await this.pollStatus();
      if (status !== null) {
        this.state.executionStatus = status;
      }
      if (status === conversationExecutionStatus.ERROR) {
        throw new Error(`Remote conversation ${this.id} ended with error`);
      }
      if (status === conversationExecutionStatus.STUCK) {
        throw new Error(`Remote conversation ${this.id} got stuck`);
      }
      if (status !== null && status !== conversationExecutionStatus.RUNNING && status !== conversationExecutionStatus.IDLE) {
        return;
      }
      await sleep(pollIntervalMs);
    }
    throw new Error(`Remote conversation ${this.id} run timed out after ${timeoutMs}ms`);
  }

  private async pollStatus(): Promise<ConversationExecutionStatus | null> {
    const info = await this.request('GET', this.infoPath);
    if (isRecord(info) && typeof info.execution_status === 'string' && isExecutionStatus(info.execution_status)) {
      return info.execution_status;
    }
    return null;
  }

  private async request(method: string, url: string, payload?: unknown, acceptableStatusCodes?: ReadonlySet<number>): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.apiKey !== null) {
      headers['x-session-api-key'] = this.apiKey;
    }
    const response = await this.fetcher.request(url, payload === undefined ? { method, headers } : { method, headers, body: JSON.stringify(payload) });
    if (!(acceptableStatusCodes?.has(response.status) ?? response.ok)) {
      throw new Error(`Remote conversation request failed with HTTP ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  private get actionBasePath(): string {
    return `${this.host}/api/conversations/${encodeURIComponent(this.id)}`;
  }

  private get infoPath(): string {
    return `${this.host}/api/conversations/${encodeURIComponent(this.id)}`;
  }
}

function userMessage(text: string): Message {
  return messageSchema.parse({ role: 'user', content: [textContent(text)] });
}

function isExecutionStatus(status: string): status is ConversationExecutionStatus {
  return Object.values(conversationExecutionStatus).includes(status as ConversationExecutionStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function globalRemoteFetch(): RemoteFetchLike {
  return {
    async request(url, init) {
      const response = await fetch(url, init);
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.json(),
        text: async () => response.text(),
      };
    },
  };
}
