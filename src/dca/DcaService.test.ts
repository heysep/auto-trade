import { describe, it, expect, vi } from 'vitest';
import { validatePlan } from './dcaPlanValidation.js';

describe('validatePlan', () => {
  it('accepts a valid vanilla plan', () => {
    expect(validatePlan({ type: 'vanilla', cadence: 'monthly', amount: 500 })).toEqual({ ok: true });
  });
  it('rejects unknown type', () => {
    const r = validatePlan({ type: 'unknown', cadence: 'monthly', amount: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/type/);
  });
  it('rejects bad cadence', () => {
    const r = validatePlan({ type: 'vanilla', cadence: 'daily', amount: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cadence/);
  });
  it('rejects amount <= 0', () => {
    const r = validatePlan({ type: 'vanilla', cadence: 'monthly', amount: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/amount/);
  });
  it('rejects dipBuying without dipExtra', () => {
    const r = validatePlan({ type: 'dipBuying', cadence: 'monthly', amount: 500, dipDrawdownPct: 0.05 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dipExtra/);
  });
  it('rejects dipBuying without dipDrawdownPct', () => {
    const r = validatePlan({ type: 'dipBuying', cadence: 'monthly', amount: 500, dipExtra: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/dipDrawdownPct/);
  });
  it('accepts valid dipBuying', () => {
    expect(validatePlan({ type: 'dipBuying', cadence: 'monthly', amount: 500, dipExtra: 200, dipDrawdownPct: 0.05 })).toEqual({ ok: true });
  });
  it('rejects trendFiltered without trendWindow', () => {
    const r = validatePlan({ type: 'trendFiltered', cadence: 'monthly', amount: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/trendWindow/);
  });
  it('accepts valid trendFiltered', () => {
    expect(validatePlan({ type: 'trendFiltered', cadence: 'monthly', amount: 500, trendWindow: 200 })).toEqual({ ok: true });
  });
  it('rejects costPct > 0.05', () => {
    const r = validatePlan({ type: 'vanilla', cadence: 'monthly', amount: 500, costPct: 0.06 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/costPct/);
  });
  it('accepts costPct = 0', () => {
    expect(validatePlan({ type: 'vanilla', cadence: 'monthly', amount: 500, costPct: 0 })).toEqual({ ok: true });
  });
});

// --- DcaService tests ---
import { DcaService } from './DcaService.js';
import type { TossCandle } from '../toss/types.js';
import type { DcaPlan } from './DcaBacktest.js';

// Build a fake TossCandle series (rising price, one per month for N months).
// Toss candles are returned newest-first; DcaService must sort them ascending.
function makeCandles(closePrices: number[], startMs = Date.UTC(2020, 0, 1)): TossCandle[] {
  const MS_PER_MONTH = 30 * 86_400_000;
  // Return newest-first (as Toss does)
  return [...closePrices]
    .map((close, i) => ({
      timestamp: new Date(startMs + i * MS_PER_MONTH).toISOString(),
      openPrice: String(close),
      highPrice: String(close),
      lowPrice: String(close),
      closePrice: String(close),
    }))
    .reverse();
}

const RISING_CLOSES = Array.from({ length: 60 }, (_, i) => 100 + i); // 60 monthly prices: 100→159

describe('DcaService – compare', () => {
  it('returns results for each plan + lumpSum benchmark', async () => {
    const getCandles = vi.fn().mockResolvedValue(makeCandles(RISING_CLOSES));
    const svc = new DcaService({ getCandles, now: () => 0, ttlMs: 60_000 });
    const plans: DcaPlan[] = [
      { type: 'vanilla', cadence: 'monthly', amount: 500 },
      { type: 'dipBuying', cadence: 'monthly', amount: 500, dipExtra: 250, dipDrawdownPct: 0.05 },
    ];
    const result = await svc.compare({ symbol: 'SPY', plans });

    expect(result.symbol).toBe('SPY');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.plan.type).toBe('vanilla');
    expect(result.results[1]?.plan.type).toBe('dipBuying');
    expect(result.benchmark.lumpSum.totalInvested).toBeGreaterThan(0);
    // lumpSum invests same capital as the largest plan
    const maxInvested = Math.max(...plans.map((_, idx) => result.results[idx]?.result.totalInvested ?? 0));
    expect(Math.abs(result.benchmark.lumpSum.totalInvested - maxInvested)).toBeLessThan(1);
    expect(result.benchmark.assetReturn).toBeGreaterThan(0); // rising prices
    expect(result.years).toBeGreaterThan(0);
  });

  it('caches — second call with same symbol+count does not call getCandles again', async () => {
    const getCandles = vi.fn().mockResolvedValue(makeCandles(RISING_CLOSES));
    const svc = new DcaService({ getCandles, now: () => 0, ttlMs: 60_000 });
    const plans: DcaPlan[] = [{ type: 'vanilla', cadence: 'monthly', amount: 500 }];
    await svc.compare({ symbol: 'SPY', plans });
    await svc.compare({ symbol: 'SPY', plans });
    expect(getCandles).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after TTL expiry', async () => {
    let nowMs = 0;
    const getCandles = vi.fn().mockResolvedValue(makeCandles(RISING_CLOSES));
    const svc = new DcaService({ getCandles, now: () => nowMs, ttlMs: 1_000 });
    const plans: DcaPlan[] = [{ type: 'vanilla', cadence: 'monthly', amount: 500 }];
    await svc.compare({ symbol: 'SPY', plans });
    nowMs = 2_000; // past TTL
    await svc.compare({ symbol: 'SPY', plans });
    expect(getCandles).toHaveBeenCalledTimes(2);
  });

  it('deduplicates in-flight requests — two concurrent calls share one fetch', async () => {
    let resolve!: (v: TossCandle[]) => void;
    const deferred = new Promise<TossCandle[]>((res) => { resolve = res; });
    const getCandles = vi.fn().mockReturnValue(deferred);
    const svc = new DcaService({ getCandles, now: () => 0, ttlMs: 60_000 });
    const plans: DcaPlan[] = [{ type: 'vanilla', cadence: 'monthly', amount: 500 }];
    const p1 = svc.compare({ symbol: 'SPY', plans });
    const p2 = svc.compare({ symbol: 'SPY', plans });
    resolve(makeCandles(RISING_CLOSES));
    await Promise.all([p1, p2]);
    expect(getCandles).toHaveBeenCalledTimes(1);
  });

  it('sets windowNote on a monotonically-rising series', async () => {
    const getCandles = vi.fn().mockResolvedValue(makeCandles(RISING_CLOSES));
    const svc = new DcaService({ getCandles, now: () => 0, ttlMs: 60_000 });
    const result = await svc.compare({
      symbol: 'SPY',
      plans: [{ type: 'vanilla', cadence: 'monthly', amount: 500 }],
    });
    expect(result.windowNote).toMatch(/상승장/);
  });

  it('propagates upstream fetch errors', async () => {
    const getCandles = vi.fn().mockRejectedValue(new Error('network error'));
    const svc = new DcaService({ getCandles, now: () => 0, ttlMs: 60_000 });
    await expect(
      svc.compare({ symbol: 'SPY', plans: [{ type: 'vanilla', cadence: 'monthly', amount: 500 }] }),
    ).rejects.toThrow('network error');
  });
});
