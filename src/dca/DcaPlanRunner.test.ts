import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DcaPlanRunner } from './DcaPlanRunner.js';
import type { DcaActivePlan, DcaRunnerDeps } from './DcaPlanRunner.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const t0 = new Date('2024-01-15T00:00:00Z').getTime();
const t_1w = t0 + 7 * 86_400_000;
const t_14d = t0 + 14 * 86_400_000;
const t_31d = t0 + 31 * 86_400_000; // crosses month boundary

function makePlan(overrides: Partial<DcaActivePlan> = {}): DcaActivePlan {
  return {
    id: 1,
    symbol: 'AAPL',
    plan: { type: 'vanilla', cadence: 'weekly', amount: 100 },
    startedAt: t0,
    totalInvested: 0,
    shares: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DcaRunnerDeps> = {}): DcaRunnerDeps {
  return {
    priceOf: () => 200,
    currentShares: () => 0,
    submitBuy: vi.fn().mockResolvedValue(undefined),
    isHalted: () => false,
    now: () => t0,
    ...overrides,
  };
}

// ── isDue ─────────────────────────────────────────────────────────────────────

describe('DcaPlanRunner.isDue', () => {
  it('weekly: not due before 7 days', () => {
    const runner = new DcaPlanRunner(makeDeps());
    const plan = makePlan({ plan: { type: 'vanilla', cadence: 'weekly', amount: 100 } });
    expect(runner.isDue(plan, t0 + 6 * 86_400_000)).toBe(false);
  });

  it('weekly: due at exactly 7 days', () => {
    const runner = new DcaPlanRunner(makeDeps());
    const plan = makePlan({ plan: { type: 'vanilla', cadence: 'weekly', amount: 100 } });
    expect(runner.isDue(plan, t_1w)).toBe(true);
  });

  it('biweekly: due at 14 days, not before', () => {
    const runner = new DcaPlanRunner(makeDeps());
    const plan = makePlan({ plan: { type: 'vanilla', cadence: 'biweekly', amount: 100 } });
    expect(runner.isDue(plan, t_1w)).toBe(false);
    expect(runner.isDue(plan, t_14d)).toBe(true);
  });

  it('monthly: due when calendar month changes', () => {
    const runner = new DcaPlanRunner(makeDeps());
    // t0 = Jan 15, t_31d = Feb 15 — different month
    const plan = makePlan({ plan: { type: 'vanilla', cadence: 'monthly', amount: 100 } });
    expect(runner.isDue(plan, t0 + 15 * 86_400_000)).toBe(false); // still Jan 30
    expect(runner.isDue(plan, t_31d)).toBe(true);
  });

  it('uses lastContributionAt when set, not startedAt', () => {
    const runner = new DcaPlanRunner(makeDeps());
    const plan = makePlan({
      plan: { type: 'vanilla', cadence: 'weekly', amount: 100 },
      lastContributionAt: t0 + 3 * 86_400_000, // contributed 3 days after start
    });
    // 7 days after startedAt but only 4 days after lastContributionAt → NOT due
    expect(runner.isDue(plan, t_1w)).toBe(false);
    // 7 days after lastContributionAt → due
    expect(runner.isDue(plan, t0 + 3 * 86_400_000 + 7 * 86_400_000)).toBe(true);
  });

  it('monthly: same month but different year → due', () => {
    const runner = new DcaPlanRunner(makeDeps());
    const janThisYear = new Date('2024-01-15T00:00:00Z').getTime();
    const janNextYear = new Date('2025-01-15T00:00:00Z').getTime();
    const plan = makePlan({
      plan: { type: 'vanilla', cadence: 'monthly', amount: 100 },
      startedAt: janThisYear,
    });
    expect(runner.isDue(plan, janNextYear)).toBe(true);
  });
});

// ── contribute: guards ────────────────────────────────────────────────────────

describe('DcaPlanRunner.contribute — guards', () => {
  it('returns skipped:halted when halted', async () => {
    const runner = new DcaPlanRunner(makeDeps({ isHalted: () => true }));
    const result = await runner.contribute(makePlan());
    expect(result).toEqual({ skipped: 'halted' });
  });

  it('returns skipped:no price when priceOf returns undefined', async () => {
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => undefined }));
    const result = await runner.contribute(makePlan());
    expect(result).toEqual({ skipped: 'no price' });
  });

  it('returns skipped:no price when price is 0', async () => {
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 0 }));
    const result = await runner.contribute(makePlan());
    expect(result).toEqual({ skipped: 'no price' });
  });

  it('returns skipped message for trendFiltered', async () => {
    const runner = new DcaPlanRunner(makeDeps());
    const plan = makePlan({ plan: { type: 'trendFiltered', cadence: 'weekly', amount: 100, trendWindow: 200 } });
    const result = await runner.contribute(plan);
    expect(result).toMatchObject({ skipped: expect.stringContaining('trendFiltered') });
  });

  it('returns skipped message for valueAveraging', async () => {
    const runner = new DcaPlanRunner(makeDeps());
    const plan = makePlan({ plan: { type: 'valueAveraging', cadence: 'monthly', amount: 500 } });
    const result = await runner.contribute(plan);
    expect(result).toMatchObject({ skipped: expect.stringContaining('valueAveraging') });
  });

  it('returns skipped message for lumpSum', async () => {
    const runner = new DcaPlanRunner(makeDeps());
    const plan = makePlan({ plan: { type: 'lumpSum', cadence: 'weekly', amount: 1000 } });
    const result = await runner.contribute(plan);
    expect(result).toMatchObject({ skipped: expect.stringContaining('lumpSum') });
  });
});

// ── contribute: vanilla ───────────────────────────────────────────────────────

describe('DcaPlanRunner.contribute — vanilla', () => {
  it('submits buy and returns correct result', async () => {
    const submitBuy = vi.fn().mockResolvedValue(undefined);
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 200, submitBuy }));
    const plan = makePlan({ plan: { type: 'vanilla', cadence: 'weekly', amount: 100 } });
    const result = await runner.contribute(plan);
    expect(result).toEqual({ invested: 100, shares: 0.5, price: 200 });
    expect(submitBuy).toHaveBeenCalledWith('AAPL', 100, 200);
  });

  it('fractional shares: no floor applied', async () => {
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 333.33 }));
    const plan = makePlan({ plan: { type: 'vanilla', cadence: 'weekly', amount: 100 } });
    const result = await runner.contribute(plan);
    if ('skipped' in result) throw new Error('Expected success');
    expect(result.shares).toBeCloseTo(100 / 333.33, 6);
  });

  it('propagates submitBuy rejection', async () => {
    const runner = new DcaPlanRunner(makeDeps({
      submitBuy: vi.fn().mockRejectedValue(new Error('order failed')),
    }));
    await expect(runner.contribute(makePlan())).rejects.toThrow('order failed');
  });
});

// ── contribute: dipBuying ─────────────────────────────────────────────────────

describe('DcaPlanRunner.contribute — dipBuying', () => {
  const dipPlan = (dipPeak?: number): DcaActivePlan => makePlan({
    plan: { type: 'dipBuying', cadence: 'weekly', amount: 100, dipExtra: 50, dipDrawdownPct: 0.05 },
    ...(dipPeak !== undefined ? { dipPeak } : {}),
  });

  it('invests base amount when no prior peak (dipPeak=0)', async () => {
    const submitBuy = vi.fn().mockResolvedValue(undefined);
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 200, submitBuy }));
    const result = await runner.contribute(dipPlan(0));
    expect(result).toEqual({ invested: 100, shares: 0.5, price: 200 });
    expect(submitBuy).toHaveBeenCalledWith('AAPL', 100, 200);
  });

  it('invests base amount when no dipPeak set (undefined)', async () => {
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 200 }));
    const result = await runner.contribute(dipPlan(undefined));
    if ('skipped' in result) throw new Error('Expected success');
    expect(result.invested).toBe(100);
  });

  it('invests base amount when price is above peak threshold', async () => {
    // peak=100, price=96, threshold=100*0.95=95 → price ABOVE threshold → not a dip
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 96 }));
    const result = await runner.contribute(dipPlan(100));
    if ('skipped' in result) throw new Error('Expected success');
    expect(result.invested).toBe(100);
  });

  it('invests base+extra when price at or below dip threshold', async () => {
    // peak=100, drawdown=5% → threshold=95. price=95 → isDip
    const submitBuy = vi.fn().mockResolvedValue(undefined);
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 95, submitBuy }));
    const result = await runner.contribute(dipPlan(100));
    expect(result).toEqual({ invested: 150, shares: 150 / 95, price: 95 });
    expect(submitBuy).toHaveBeenCalledWith('AAPL', 150, 95);
  });

  it('invests base+extra when price well below threshold', async () => {
    // peak=200, drawdown=5% → threshold=190. price=180
    const runner = new DcaPlanRunner(makeDeps({ priceOf: () => 180 }));
    const result = await runner.contribute(dipPlan(200));
    if ('skipped' in result) throw new Error('Expected success');
    expect(result.invested).toBe(150);
  });
});
