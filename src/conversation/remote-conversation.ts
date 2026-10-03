import { textContent, messageSchema, type Message } from '../llm/index.js';
import { validateAgentSettings, type AgentSettings } from '../settings/index.js';
import type { HookConfig, HookConfigInput } from '../hooks/index.js';
import { normalizeUuid } from '../utils/uuid.js';
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

export interface RemoteConversationCreateRequest {
  readonly workspace: { readonly kind: 'LocalWorkspace'; readonly working_dir: string };
  readonly worktree?: boolean;
  readonly parentConversationId?: string | null;
  readonly initialMessage?: { readonly role?: Message['role']; readonly content: Message['content']; readonly run?: boolean } | null;
  readonly stuckDetection?: boolean;
  readonly hookConfig?: HookConfig | HookConfigInput | null;
  readonly agentLaunchAdditions?: { readonly system_message_suffix_append?: string | null } | null;
  readonly userId?: string | null;
  readonly observabilityMetadata?: Readonly<Record<string, unknown>>;
  readonly observabilityTags?: readonly string[];
  readonly observabilitySpanName?: string;
  readonly autotitle?: boolean;
  readonly titleLlmProfile?: string | null;
  readonly title?: string | null;
  readonly persistenceDir?: string | null;
  readonly agentProfileId?: string | null;
  readonly agentSettings?: AgentSettings | null;
  readonly conversationId?: string | null;
  readonly maxIterations?: number | null;
  readonly tags?: Readonly<Record<string, string>> | null;
}

export interface RemoteConversationCreateOptions {
  /** SmolPaws accepts TS AgentSettings as `agent`; Python accepts a saved Agent Profile UUID. */
  readonly server?: 'smolpaws' | 'python';
  readonly host: string;
  readonly request: RemoteConversationCreateRequest;
  readonly fetch?: RemoteFetchLike;
  readonly apiKey?: string | null;
  readonly state?: ConversationState;
}

export interface RemoteConversationAttachOptions {
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

  static async create(options: RemoteConversationCreateOptions): Promise<RemoteConversation> {
    const host = options.host.replace(/\/+$/, '');
    const fetcher = options.fetch ?? globalRemoteFetch();
    const apiKey = options.apiKey ?? null;
    const info = await sendRemoteRequest(fetcher, apiKey, 'POST', `${host}/api/conversations`, serializeCreateRequest(options.request, options.server ?? 'smolpaws'));
    return RemoteConversation.fromInfo(host, fetcher, apiKey, options.state, info);
  }

  static async attach(options: RemoteConversationAttachOptions): Promise<RemoteConversation> {
    const host = options.host.replace(/\/+$/, '');
    const fetcher = options.fetch ?? globalRemoteFetch();
    const apiKey = options.apiKey ?? null;
    const info = await sendRemoteRequest(fetcher, apiKey, 'GET', `${host}/api/conversations/${encodeURIComponent(normalizeUuid(options.conversationId))}`);
    return RemoteConversation.fromInfo(host, fetcher, apiKey, options.state, info);
  }

  private static fromInfo(host: string, fetcher: RemoteFetchLike, apiKey: string | null, state: ConversationState | undefined, info: unknown): RemoteConversation {
    const id = extractConversationId(info);
    return new RemoteConversation({ host, conversationId: id, fetch: fetcher, apiKey, state: restoreExecutionStatus(info, state ?? new ConversationState()) });
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

  async condense(): Promise<void> {
    await this.request('POST', `${this.actionBasePath}/condense`);
  }

  async pause(): Promise<void> {
    await this.request('POST', `${this.actionBasePath}/pause`);
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }

  async interrupt(): Promise<void> {
    await this.request('POST', `${this.actionBasePath}/interrupt`);
    this.state.executionStatus = conversationExecutionStatus.PAUSED;
  }

  async setTitle(title: string): Promise<void> {
    await this.request('PATCH', this.infoPath, { title });
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
    return sendRemoteRequest(this.fetcher, this.apiKey, method, url, payload, acceptableStatusCodes);
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

async function sendRemoteRequest(
  fetcher: RemoteFetchLike,
  apiKey: string | null,
  method: string,
  url: string,
  payload?: unknown,
  acceptableStatusCodes?: ReadonlySet<number>,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (apiKey !== null) {
    headers['x-session-api-key'] = apiKey;
  }
  const response = await fetcher.request(url, payload === undefined ? { method, headers } : { method, headers, body: JSON.stringify(payload) });
  if (!(acceptableStatusCodes?.has(response.status) ?? response.ok)) {
    throw new Error(`Remote conversation request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function serializeCreateRequest(request: RemoteConversationCreateRequest, server: 'smolpaws' | 'python'): Record<string, unknown> {
  if (request.workspace?.kind !== 'LocalWorkspace' || typeof request.workspace.working_dir !== 'string' || !request.workspace.working_dir) {
    throw new Error('Creation requires a LocalWorkspace with working_dir');
  }
  const payload: Record<string, unknown> = { workspace: request.workspace };
  const hasSettings = request.agentSettings !== undefined && request.agentSettings !== null;
  const hasProfile = request.agentProfileId !== undefined && request.agentProfileId !== null;
  if (server === 'python') {
    if (!hasProfile || hasSettings) {
      throw new Error('Python creation requires agentProfileId; TypeScript AgentSettings are not Python settings');
    }
    payload.agent_profile_id = normalizeUuid(request.agentProfileId);
  } else {
    if (hasProfile || !hasSettings) {
      throw new Error('SmolPaws creation requires agentSettings with an explicit llm_profile_ref; agentProfileId is a Python Agent Profile UUID');
    }
    const settings = validateAgentSettings(request.agentSettings);
    if (settings.agent_kind !== 'openhands') throw new Error('acp_runtime_not_ported');
    payload.agent = settings;
  }
  const fields = {
    worktree: request.worktree,
    initial_message: request.initialMessage,
    max_iterations: request.maxIterations ?? undefined,
    stuck_detection: request.stuckDetection,
    hook_config: request.hookConfig,
    agent_launch_additions: request.agentLaunchAdditions,
    tags: request.tags ?? undefined,
    user_id: request.userId,
    observability_metadata: request.observabilityMetadata,
    observability_tags: request.observabilityTags,
    observability_span_name: request.observabilitySpanName,
    autotitle: request.autotitle,
    title_llm_profile: request.titleLlmProfile,
    title: request.title,
    persistence_dir: request.persistenceDir,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) payload[key] = value;
  }
  if (request.conversationId !== undefined && request.conversationId !== null) payload.conversation_id = normalizeUuid(request.conversationId);
  if (request.parentConversationId !== undefined && request.parentConversationId !== null) payload.parent_conversation_id = normalizeUuid(request.parentConversationId);
  return payload;
}

function extractConversationId(info: unknown): string {
  if (!isRecord(info)) {
    throw new Error('Invalid response from server: missing conversation id');
  }
  const id = info.id ?? info.conversation_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Invalid response from server: missing conversation id');
  }
  try {
    return normalizeUuid(id);
  } catch {
    throw new Error('Invalid response from server: invalid conversation id');
  }
}

function restoreExecutionStatus(info: unknown, state: ConversationState): ConversationState {
  if (!isRecord(info) || typeof info.execution_status !== 'string' || !isExecutionStatus(info.execution_status)) {
    throw new Error('Invalid response from server: missing or invalid execution_status');
  }
  state.executionStatus = info.execution_status;
  return state;
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
