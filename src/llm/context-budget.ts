import type { FetchResponseLike, LLMTokenCountTool } from './client.js';
import type { LLMProfile, Message } from './index.js';
import { MODEL_INPUT_LIMITS } from './model-input-limits.js';
import { estimateInputTokens } from './token-count.js';

export type MetadataFetchLike = (url: string, init: { readonly method: 'GET'; readonly redirect: 'error'; readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal }) => Promise<FetchResponseLike>;
export interface ContextBudgetOptions {
  readonly fetch?: MetadataFetchLike;
  readonly headers?: Readonly<Record<string, string>>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function positiveLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function staticLimit(profile: LLMProfile): number | null {
  // Route overrides/custom proxies can serve less than a public model catalog.
  const endpoint = profile.baseUrl ? new URL(profile.baseUrl) : null;
  const host = endpoint?.hostname ?? null;
  if (endpoint && (endpoint.port || !['', '/', '/v1', '/v1/', '/v1beta', '/v1beta/'].includes(endpoint.pathname))) return null;
  const nativeHosts: Readonly<Record<string, string>> = { openai: 'api.openai.com', anthropic: 'api.anthropic.com', gemini: 'generativelanguage.googleapis.com', deepseek: 'api.deepseek.com', moonshot: 'api.moonshot.ai', minimax: 'api.minimax.io', mistral: 'api.mistral.ai', xai: 'api.x.ai', zai: 'api.z.ai' };
  if (!nativeHosts[profile.providerId] || (host && host !== nativeHosts[profile.providerId])) return null;
  const entry = MODEL_INPUT_LIMITS[profile.model] ?? MODEL_INPUT_LIMITS[`${profile.providerId}/${profile.model}`];
  return entry?.provider === profile.providerId ? entry.maxInputTokens : null;
}

/** Native equivalent of llm.py effective limit and provider-aware metadata cache.
 * A profile value always wins. Discovery is bounded and never occurs in a getter.
 */
export class LLMContextBudget {
  readonly tokenCountAccuracy = 'estimate' as const;
  private resolvedLimit: number | null = null;
  private freshUntil = 0;
  private inflight: Promise<void> | undefined;
  constructor(private readonly profile: LLMProfile, private readonly options: ContextBudgetOptions = {}) {}

  get effectiveMaxInputTokens(): number | null {
    return this.profile.maxInputTokens ?? (Date.now() < this.freshUntil ? this.resolvedLimit : null) ?? staticLimit(this.profile);
  }
  getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null> {
    return Promise.resolve(estimateInputTokens(this.profile.model, messages, tools));
  }
  resolveRuntimeMetadata(): Promise<void> {
    if (this.profile.maxInputTokens !== null || Date.now() < this.freshUntil) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.resolve().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async resolve(): Promise<void> {
    this.resolvedLimit = null;
    const profile = this.profile;
    const host = profile.baseUrl ? new URL(profile.baseUrl).hostname : null;
    const openrouter = (profile.providerId === 'openrouter' && (!host || host === 'openrouter.ai')) || host === 'openrouter.ai';
    const proxy = profile.providerId === 'litellm_proxy' || profile.model.startsWith('litellm_proxy/') || (host !== null && /litellm|llm-proxy/u.test(host));
    let url: string | null = null;
    if (openrouter && profile.model.includes('/')) url = `https://openrouter.ai/api/v1/models/${profile.model.replace(/^openrouter\//u, '').split('/').map(encodeURIComponent).join('/')}/endpoints`;
    if (proxy && profile.baseUrl) url = `${profile.baseUrl.replace(/\/v1\/?$|\/$/u, '')}/v1/model/info`;
    if (!url) { this.freshUntil = Date.now() + 300_000; return; }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fetcher: MetadataFetchLike = this.options.fetch ?? ((input, init) => globalThis.fetch(input, init));
      const payload = await Promise.race([
        fetcher(url, { method: 'GET', redirect: 'error', headers: openrouter ? {} : this.options.headers ?? {}, signal: abort.signal }).then(async response => {
          if (!response.ok) throw new Error('Metadata unavailable');
          return await response.json();
        }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('Metadata timeout')); }, 10_000); }),
      ]);
      const data = record(payload).data;
      if (openrouter) {
        const endpoints = record(Array.isArray(data) ? data[0] : data).endpoints;
        if (Array.isArray(endpoints)) {
          const limits = endpoints.map(item => positiveLimit(record(item).context_length)).filter((value): value is number => value !== null);
          this.resolvedLimit = limits.length ? Math.min(...limits) : null;
        }
      } else if (Array.isArray(data)) {
        const model = profile.model.replace(/^litellm_proxy\//u, '');
        const matches = data.map(record).filter(item => item.model_name === model || record(item.litellm_params).model === model);
        const limits = matches.map(item => positiveLimit(record(item.model_info).max_input_tokens));
        // Multiple deployments of an alias may have different context windows.
        this.resolvedLimit = limits.length && limits.every((value): value is number => value !== null) ? Math.min(...limits) : null;
      }
    } catch { this.resolvedLimit = null; }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      this.freshUntil = Date.now() + (this.resolvedLimit === null ? 300_000 : 3_600_000);
    }
  }
}
