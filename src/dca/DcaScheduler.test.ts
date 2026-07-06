import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DcaScheduler } from './DcaScheduler.js';
import { DcaPlanStore } from './DcaPlanStore.js';
import { DcaPlanRunner } from './DcaPlanRunner.js';
import type { DcaActivePlan } from './DcaPlanRunner.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const t0 = new Date('2024-01-15T00:00:00Z').getTime();
const t_8d = t0 + 8 * 86_400_000; // 8 days later → weekly is due

function makeStore(inputs: Omit<DcaActivePlan, 'id'>[]): DcaPlanStore {
  const store = new DcaPlanStore();
  for (const input of inputs) store.add(input);
  return store;
}

function makePlanInput(overrides: Partial<Omit<DcaActivePlan, 'id'>> = {}): Omit<DcaActivePlan, 'id'> {
  return {
    symbol: 'AAPL',
    plan: { type: 'vanilla', cadence: 'weekly', amount: 100 },
    startedAt: t0,
    totalInvested: 0,
    shares: 0,
    ...overrides,
  };
}

function makeRunner(priceOf?: (s: string) => number | undefined): DcaPlanRunner {
  return new DcaPlanRunner({
    priceOf: priceOf ?? (() => 200),
    currentShares: () => 0,
    submitBuy: vi.fn().mockResolvedValue(undefined),
    isHalted: () => false,
    now: () => t0,
  });
}

// ── start / stop ──────────────────────────────────────────────────────────────

describe('DcaScheduler start/stop', () => {
  it('start arms interval and enabled=true', () => {
    const ticks: (() => void)[] = [];
    const setIntervalFn = vi.fn((fn: () => void) => { ticks.push(fn); return 1 as unknown as ReturnType<typeof setInterval>; });
    const clearIntervalFn = vi.fn();
    const sched = new DcaScheduler({
      store: makeStore([]),
      runner: makeRunner(),
      isHalted: () => false,
      intervalMs: 60_000,
      setIntervalFn,
      clearIntervalFn,
    });
    sched.start();
    expect(sched.enabled).toBe(true);
    expect(setIntervalFn).toHaveBeenCalledOnce();
  });

  it('start is idempotent', () => {
    const setIntervalFn = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const sched = new DcaScheduler({
      store: makeStore([]),
      runner: makeRunner(),
      isHalted: () => false,
      intervalMs: 60_000,
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    });
    sched.start();
    sched.start();
    expect(setIntervalFn).toHaveBeenCalledOnce();
  });

  it('stop clears interval and enabled=false', () => {
    const handle = 99 as unknown as ReturnType<typeof setInterval>;
    const clearIntervalFn = vi.fn();
    const sched = new DcaScheduler({
      store: makeStore([]),
      runner: makeRunner(),
      isHalted: () => false,
      intervalMs: 60_000,
      setIntervalFn: vi.fn(() => handle),
      clearIntervalFn,
    });
    sched.start();
    sched.stop();
    expect(sched.enabled).toBe(false);
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });

  it('stop is idempotent', () => {
    const clearIntervalFn = vi.fn();
    const sched = new DcaScheduler({
      store: makeStore([]),
      runner: makeRunner(),
      isHalted: () => false,
      intervalMs: 60_000,
      setIntervalFn: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearIntervalFn,
    });
    sched.start();
    sched.stop();
    sched.stop();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
  });
});

// ── tick: halt guard ─────────────────────────────────────────────────────────

describe('DcaScheduler tick — halt guard', () => {
  it('skips all plans when halted', async () => {
    const store = makeStore([makePlanInput()]);
    const submitBuy = vi.fn();
    const runner = new DcaPlanRunner({
      priceOf: () => 200,
      currentShares: () => 0,
      submitBuy,
      isHalted: () => false,
      now: () => t0,
    });
    const sched = new DcaScheduler({
      store,
      runner,
      isHalted: () => true, // system halted
      intervalMs: 60_000,
      now: () => t_8d,
    });
    await sched.tick();
    expect(submitBuy).not.toHaveBeenCalled();
  });
});

// ── tick: overlap guard ──────────────────────────────────────────────────────

describe('DcaScheduler tick — overlap guard', () => {
  it('concurrent second tick is a no-op', async () => {
    const store = makeStore([makePlanInput()]);
    let callCount = 0;
    const submitBuy = vi.fn(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 10));
    });
    const runner = new DcaPlanRunner({
      priceOf: () => 200,
      currentShares: () => 0,
      submitBuy,
      isHalted: () => false,
    });
    const sched = new DcaScheduler({
      store,
      runner,
      isHalted: () => false,
      intervalMs: 60_000,
      now: () => t_8d,
    });
    const [, second] = await Promise.all([sched.tick(), sched.tick()]);
    // first tick runs, second is rejected as no-op
    expect(callCount).toBe(1);
  });
});

// ── tick: isDue filtering ─────────────────────────────────────────────────────

describe('DcaScheduler tick — isDue filtering', () => {
  it('skips plans that are not yet due', async () => {
    // t0 + 3 days → weekly not due
    const store = makeStore([makePlanInput()]);
    const submitBuy = vi.fn().mockResolvedValue(undefined);
    const runner = new DcaPlanRunner({
      priceOf: () => 200,
      currentShares: () => 0,
      submitBuy,
      isHalted: () => false,
    });
    const sched = new DcaScheduler({
      store,
      runner,
      isHalted: () => false,
      intervalMs: 60_000,
      now: () => t0 + 3 * 86_400_000, // 3 days — not due
    });
    await sched.tick();
    expect(submitBuy).not.toHaveBeenCalled();
  });

  it('contributes for due plan and updates store', async () => {
    const store = makeStore([makePlanInput()]);
    const submitBuy = vi.fn().mockResolvedValue(undefined);
    const runner = new DcaPlanRunner({
      priceOf: () => 200,
      currentShares: () => 0,
      submitBuy,
      isHalted: () => false,
    });
    const sched = new DcaScheduler({
      store,
      runner,
      isHalted: () => false,
      intervalMs: 60_000,
      now: () => t_8d,
    });
    await sched.tick();
    expect(submitBuy).toHaveBeenCalledWith('AAPL', 100, 200);
    const plan = store.list()[0]!;
    expect(plan.totalInvested).toBe(100);
    expect(plan.shares).toBe(0.5);
    expect(plan.lastContributionAt).toBe(t_8d);
  });
});

// ── tick: per-plan failure isolation ─────────────────────────────────────────

describe('DcaScheduler tick — per-plan failure isolation', () => {
  it('plan B still runs when plan A throws', async () => {
    const store = makeStore([
      makePlanInput({ symbol: 'FAIL' }),
      makePlanInput({ symbol: 'AAPL' }),
    ]);
    const submitBuyB = vi.fn().mockResolvedValue(undefined);
    const runner = new DcaPlanRunner({
      priceOf: () => 200,
      currentShares: () => 0,
      submitBuy: vi.fn(async (symbol: string) => {
        if (symbol === 'FAIL') throw new Error('broker error');
        return submitBuyB(symbol);
      }),
      isHalted: () => false,
    });
    const logger = { log: vi.fn() };
    const sched = new DcaScheduler({
      store,
      runner,
      isHalted: () => false,
      intervalMs: 60_000,
      now: () => t_8d,
      logger,
    });
    await sched.tick();
    expect(submitBuyB).toHaveBeenCalledWith('AAPL');
    // logger called for the failing plan
    expect(logger.log).toHaveBeenCalled();
  });
});

// ── tick: dipBuying dipPeak update ────────────────────────────────────────────

describe('DcaScheduler tick — dipPeak tracking', () => {
  it('updates dipPeak to max(existing, price) after contribution', async () => {
    const store = makeStore([
      makePlanInput({
        plan: { type: 'dipBuying', cadence: 'weekly', amount: 100, dipExtra: 50, dipDrawdownPct: 0.05 },
        dipPeak: 150,
      }),
    ]);
    const runner = new DcaPlanRunner({
      priceOf: () => 200, // price 200 > peak 150 → new peak = 200
      currentShares: () => 0,
      submitBuy: vi.fn().mockResolvedValue(undefined),
      isHalted: () => false,
    });
    const sched = new DcaScheduler({
      store,
      runner,
      isHalted: () => false,
      intervalMs: 60_000,
      now: () => t_8d,
    });
    await sched.tick();
    expect(store.list()[0]?.dipPeak).toBe(200);
  });

  it('vanilla plan does not set dipPeak', async () => {
    const store = makeStore([makePlanInput()]);
    const runner = new DcaPlanRunner({
      priceOf: () => 200,
      currentShares: () => 0,
      submitBuy: vi.fn().mockResolvedValue(undefined),
      isHalted: () => false,
    });
    const sched = new DcaScheduler({
      store,
      runner,
      isHalted: () => false,
      intervalMs: 60_000,
      now: () => t_8d,
    });
    await sched.tick();
    expect(store.list()[0]?.dipPeak).toBeUndefined();
  });
});
