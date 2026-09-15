import type { LLMProfile } from './index.js';

export interface PriceableUsage {
  readonly promptTokens?: number | null | undefined;
  readonly completionTokens?: number | null | undefined;
  readonly totalTokens?: number | null | undefined;
  readonly cacheReadTokens?: number | null | undefined;
  readonly cacheMissTokens?: number | null | undefined;
  readonly cacheWriteTokens?: number | null | undefined;
  readonly reasoningTokens?: number | null | undefined;
}

export interface UsageCostEstimate {
  readonly amount: number;
  readonly currency: 'USD';
  readonly source: 'calculated';
  readonly pricing: {
    readonly sourceUrl: string;
    readonly checkedAt: string;
    readonly model: string;
    readonly band: 'peak' | 'off_peak';
    readonly rates: {
      readonly cachedInputPerMillion: number;
      readonly uncachedInputPerMillion: number;
      readonly outputPerMillion: number;
    };
  };
}

const DEEPSEEK_FLASH_MODELS = new Set([
  'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
]);
const DEEPSEEK_FLASH_RESPONSE_MODELS = new Set([
  ...DEEPSEEK_FLASH_MODELS, 'DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash',
]);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * An estimate from a dated public quote, never a claim about the provider's bill.
 * Times are epoch milliseconds bracketing the request. When a request crosses a
 * tariff boundary the provider's cutoff rule is undocumented, so return unknown.
 * Callers must prefer provider-reported cost and retain this quote with estimates.
 * Supply the response's model when available; an unexpected served model must not
 * inherit the requested model's price.
 */
export function estimateUsageCost(
  profile: LLMProfile,
  usage: PriceableUsage | null,
  startedAtMs: number,
  completedAtMs: number,
  servedModel?: string,
): UsageCostEstimate | null {
  if (!isDirectDeepSeekFlash(profile) || usage === null) return null;
  if (servedModel !== undefined && !DEEPSEEK_FLASH_RESPONSE_MODELS.has(servedModel)) return null;
  const tokens = priceableDeepSeekTokens(usage);
  const band = requestPriceBand(startedAtMs, completedAtMs);
  if (tokens === null || band === null) return null;
  const rates = band === 'peak'
    ? { cachedInputPerMillion: 0.006, uncachedInputPerMillion: 0.3, outputPerMillion: 1.2 }
    : { cachedInputPerMillion: 0.003, uncachedInputPerMillion: 0.15, outputPerMillion: 0.6 };
  return {
    amount: (tokens.hit * rates.cachedInputPerMillion
      + tokens.miss * rates.uncachedInputPerMillion
      + tokens.output * rates.outputPerMillion) / 1_000_000,
    currency: 'USD',
    source: 'calculated',
    pricing: {
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
      checkedAt: '2026-09-15',
      model: 'DeepSeek-V4.1-Flash',
      band,
      rates,
    },
  };
}

function isDirectDeepSeekFlash(profile: LLMProfile): boolean {
  if (profile.authType === 'subscription' || !DEEPSEEK_FLASH_MODELS.has(profile.model) || !profile.baseUrl) return false;
  try {
    const url = new URL(profile.baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com'
      && url.port === '' && url.username === '' && url.password === ''
      && url.search === '' && url.hash === ''
      && ['', '/v1', '/anthropic'].includes(url.pathname.replace(/\/+$/u, ''));
  } catch {
    return false;
  }
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPresent(value: number | null | undefined): value is number {
  return value !== undefined && value !== null;
}

function priceableDeepSeekTokens(usage: PriceableUsage): { hit: number; miss: number; output: number } | null {
  const counts = [usage.promptTokens, usage.completionTokens, usage.totalTokens,
    usage.cacheReadTokens, usage.cacheMissTokens, usage.cacheWriteTokens, usage.reasoningTokens];
  if (counts.some(value => isPresent(value) && !isTokenCount(value))) return null;

  const hit = usage.cacheReadTokens;
  const output = usage.completionTokens;
  if (!isPresent(hit) || !isPresent(output)) return null;
  const miss = usage.cacheMissTokens ?? (isPresent(usage.promptTokens) ? usage.promptTokens - hit : null);
  if (miss === null || !isTokenCount(miss)) return null;

  const prompt = hit + miss;
  if (!isTokenCount(prompt) || !isTokenCount(prompt + output)) return null;
  if (isPresent(usage.promptTokens) && usage.promptTokens !== prompt) return null;
  if (isPresent(usage.totalTokens) && usage.totalTokens !== prompt + output) return null;
  // DeepSeek cache misses are ordinary input, not a separately priced cache write.
  if (isPresent(usage.cacheWriteTokens) && usage.cacheWriteTokens !== 0) return null;
  // Thinking tokens are already included in completion tokens for this API.
  if (isPresent(usage.reasoningTokens) && usage.reasoningTokens > output) return null;
  return { hit, miss, output };
}

function requestPriceBand(start: number, end: number): 'peak' | 'off_peak' | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
    || !Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime())) return null;
  // Every full week contains tariff transitions; bound the search even for bad inputs.
  if (end - start >= 7 * DAY_MS) return null;
  for (let day = Math.floor(start / DAY_MS) * DAY_MS; day <= end; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const hour of [1, 4, 6, 10]) {
      const boundary = day + hour * HOUR_MS;
      if (boundary > start && boundary <= end) return null;
    }
  }
  const date = new Date(start);
  const weekday = date.getUTCDay();
  const hour = date.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))
    ? 'peak' : 'off_peak';
}
