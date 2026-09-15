import { describe, expect, it } from 'vitest';
import { llmProfileSchema } from '../index.js';
import { estimateUsageCost, type PriceableUsage } from '../pricing.js';

const profile = llmProfileSchema.parse({
  profileId: 'deepseek', providerId: 'deepseek', model: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
});
const peak = Date.parse('2026-09-15T02:00:00.000Z');
const usage: PriceableUsage = {
  promptTokens: 3_000_000, cacheReadTokens: 1_000_000, cacheMissTokens: 2_000_000,
  completionTokens: 3_000_000, totalTokens: 6_000_000,
};
const estimate = (input: PriceableUsage | null = usage, start = peak, end = start + 1_000) =>
  estimateUsageCost(profile, input, start, end);

describe('dated DeepSeek Flash price estimates', () => {
  it('retains the quote and all rates separately from provider-reported cost', () => {
    expect(estimate()).toEqual({
      amount: 0.006 + 0.6 + 3.6, currency: 'USD', source: 'calculated',
      pricing: {
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing/',
        checkedAt: '2026-09-15', model: 'DeepSeek-V4.1-Flash', band: 'peak',
        rates: { cachedInputPerMillion: 0.006, uncachedInputPerMillion: 0.3, outputPerMillion: 1.2 },
      },
    });
  });

  it('uses cache misses as ordinary input, without charging reasoning a second time', () => {
    expect(estimate({ ...usage, cacheWriteTokens: 0, reasoningTokens: 1_000_000 })?.amount)
      .toEqual(estimate()?.amount);
    expect(estimate({ cacheReadTokens: 0, cacheMissTokens: 100, completionTokens: 1 })?.amount)
      .toBe((100 * 0.3 + 1.2) / 1_000_000);
  });

  it('derives only a missing total or missing cache miss count from known inclusive input', () => {
    expect(estimate({ ...usage, promptTokens: null })?.amount).toBe(4.206);
    expect(estimate({ ...usage, cacheMissTokens: null })?.amount).toBe(4.206);
  });

  it('preserves a reported zero estimate, without manufacturing missing counts', () => {
    expect(estimate({ cacheReadTokens: 0, cacheMissTokens: 0, completionTokens: 0 })?.amount).toBe(0);
    for (const input of [null, {}, { promptTokens: 0, completionTokens: 0 },
      { cacheReadTokens: 0, completionTokens: 0 }, { cacheReadTokens: 0, cacheMissTokens: 0 }]) {
      expect(estimate(input)).toBeNull();
    }
  });

  it('does not round small per-call costs away before accumulation', () => {
    const quote = estimate({ cacheReadTokens: 1, cacheMissTokens: 0, completionTokens: 0 });
    expect(quote?.amount).toBe(0.006 / 1_000_000);
    expect((quote?.amount ?? 0) * 1_000_000).toBeCloseTo(0.006, 14);
  });

  it('rejects contradictory or invalid provider usage', () => {
    for (const changes of [
      { promptTokens: 2_999_999 }, { cacheReadTokens: 3_000_001 },
      { totalTokens: 6_000_001 }, { cacheWriteTokens: 1 },
      { reasoningTokens: 3_000_001 }, { completionTokens: -1 },
      { cacheReadTokens: 0.5 }, { cacheMissTokens: Number.NaN },
      { completionTokens: Number.POSITIVE_INFINITY }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(estimate({ ...usage, ...changes })).toBeNull();
  });

  it.each(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])(
    'quotes the explicitly documented alias %s', (model) => {
      expect(estimateUsageCost({ ...profile, model }, usage, peak, peak + 1)?.pricing.model)
        .toBe('DeepSeek-V4.1-Flash');
    },
  );

  it('accepts explicit undefined usage fields without treating them as reported zero', () => {
    expect(estimate({ ...usage, promptTokens: undefined })?.amount).toBe(4.206);
    expect(estimate({ ...usage, cacheReadTokens: undefined })).toBeNull();
  });

  it('checks an actual served model before using the requested Flash price', () => {
    for (const model of ['deepseek-v4-pro', 'deepseek-chat', 'unrecognized-model', '']) {
      expect(estimateUsageCost(profile, usage, peak, peak + 1, model)).toBeNull();
    }
    for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
      'DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash']) {
      expect(estimateUsageCost(profile, usage, peak, peak + 1, model)?.amount).toBe(4.206);
    }
    // The requested name and direct endpoint must still match the quote.
    expect(estimateUsageCost({ ...profile, model: 'unrecognized-model' }, usage, peak, peak + 1, 'deepseek-flash'))
      .toBeNull();
  });

  it('does not infer prices for an unknown model, proxy, subscription, or lookalike endpoint', () => {
    for (const changes of [
      { model: 'deepseek-v4-pro' }, { model: 'deepseek-chat' }, { model: 'deepseek/flash' },
      { authType: 'subscription' as const }, { baseUrl: null },
      { baseUrl: 'https://openrouter.ai/api/v1' }, { baseUrl: 'https://api.deepseek.com.example.com' },
      { baseUrl: 'http://api.deepseek.com' }, { baseUrl: 'https://api.deepseek.com:8443' },
      { baseUrl: 'https://user:pass@api.deepseek.com' },
      { baseUrl: 'https://api.deepseek.com/proxy' }, { baseUrl: 'https://api.deepseek.com?provider=other' },
    ]) expect(estimateUsageCost({ ...profile, ...changes }, usage, peak, peak + 1)).toBeNull();
  });

  it.each(['https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/',
    'https://api.deepseek.com/anthropic'])(
    'recognizes the direct API base %s', (baseUrl) => {
      expect(estimateUsageCost({ ...profile, baseUrl }, usage, peak, peak + 1)?.amount).toBe(4.206);
    },
  );

  it.each([
    ['2026-09-15T00:59:59.999Z', 'off_peak'],
    ['2026-09-15T01:00:00.000Z', 'peak'],
    ['2026-09-15T03:59:59.999Z', 'peak'],
    ['2026-09-15T04:00:00.000Z', 'off_peak'],
    ['2026-09-15T06:00:00.000Z', 'peak'],
    ['2026-09-15T10:00:00.000Z', 'off_peak'],
    ['2026-09-19T02:00:00.000Z', 'off_peak'],
    ['2026-09-20T08:00:00.000Z', 'off_peak'],
    ['2026-09-21T00:59:59.999Z', 'off_peak'],
    ['2026-09-21T01:00:00.000Z', 'peak'],
  ])('uses UTC weekday windows at %s', (instant, band) => {
    const timestamp = Date.parse(instant);
    const quote = estimate(usage, timestamp, timestamp);
    expect(quote?.pricing.band).toBe(band);
    expect(quote?.amount).toBe((estimate()?.amount ?? 0) / (band === 'peak' ? 1 : 2));
  });

  it('declines requests crossing an unknown provider billing cutoff, even with matching endpoint bands', () => {
    for (const [start, end] of [
      ['2026-09-15T00:59:59.999Z', '2026-09-15T01:00:00.000Z'],
      ['2026-09-15T03:59:59.999Z', '2026-09-15T04:00:00.001Z'],
      ['2026-09-15T05:59:59.999Z', '2026-09-15T06:00:00.001Z'],
      ['2026-09-15T09:59:59.999Z', '2026-09-15T10:00:00.001Z'],
      ['2026-09-15T00:00:00.000Z', '2026-09-15T05:00:00.000Z'],
      ['2026-09-15T02:00:00.000Z', '2026-09-15T08:00:00.000Z'],
      ['2026-09-19T00:00:00.000Z', '2026-09-26T00:00:00.000Z'],
    ]) expect(estimate(usage, Date.parse(start!), Date.parse(end!))).toBeNull();
  });

  it('allows an interval entirely within weekend off-peak hours', () => {
    expect(estimate(usage, Date.parse('2026-09-19T00:00:00Z'), Date.parse('2026-09-21T00:00:00Z'))?.pricing.band)
      .toBe('off_peak');
  });

  it('rejects invalid or reversed timestamps', () => {
    for (const [start, end] of [[peak + 1, peak], [Number.NaN, peak], [peak, Infinity], [0, 1e20]]) {
      expect(estimate(usage, start, end)).toBeNull();
    }
  });
});
