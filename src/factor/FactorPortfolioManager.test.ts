// TDD: tests written BEFORE the implementation.
// FactorPortfolioManager: top-N equal-weight AQR factor portfolio rebalancer.
// Pure orchestration — all side-effects (ranking, price lookup, order submission) injected.

import { describe, it, expect, vi } from 'vitest';
import {
  FactorPortfolioManager,
  type FactorPortfolioDeps,
  type RebalanceConfig,
  type PortfolioOrderIntent,
} from './FactorPortfolioManager.js';

// ── Shared helpers ─────────────────────────────────────────────────────────────

const BASE_CONFIG: RebalanceConfig = {
  strategyId: 42,
  topN: 2,
  totalNotional: 10_000,
  currency: 'KRW',
  mode: 'PAPER',
};

function makeRanking(symbols: string[]) {
  return {
    rank: async (limit?: number) => ({
      scored: (limit !== undefined ? symbols.slice(0, limit) : symbols).map((symbol) => ({ symbol })),
    }),
  };
}

function noop(): Promise<void> {
  return Promise.resolve();
}

/** Recording submitIntent: captures intents in call order. */
function makeRecorder(): {
  submitIntent: (intent: PortfolioOrderIntent) => Promise<void>;
  calls: PortfolioOrderIntent[];
} {
  const calls: PortfolioOrderIntent[] = [];
  return {
    calls,
    submitIntent: async (intent: PortfolioOrderIntent) => {
      calls.push(intent);
    },
  };
}

// ── Suite 1: Happy path — flat start, topN=2 out of 3 ranked ─────────────────
describe('FactorPortfolioManager.rebalance – happy path (flat start)', () => {
  it('submits 2 BUY intents with correct qty and populates targets', async () => {
    // Ranking returns 3 symbols; topN=2 → only A and B are targeted.
    const recorder = makeRecorder();
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A', 'B', 'C']),
      currentQty: (_symbol) => 0,
      heldSymbols: () => [],
      priceOf: (symbol) => ({ A: 100, B: 200, C: 50 })[symbol],
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 1_000,
    };
    const mgr = new FactorPortfolioManager(deps, { ...BASE_CONFIG, topN: 2 });
    const plan = await mgr.rebalance();

    // Plan shape
    expect(plan.halted).toBe(false);
    expect(plan.asOf).toBe(1_000);
    expect(plan.targets).toHaveLength(2);
    expect(plan.sells).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);

    // A: perName=5000, price=100 → targetQty=50
    const holdingA = plan.targets.find((t) => t.symbol === 'A');
    expect(holdingA).toBeDefined();
    expect(holdingA!.targetQty).toBe(50);
    expect(holdingA!.currentQty).toBe(0);
    expect(holdingA!.deltaQty).toBe(50);
    expect(holdingA!.targetNotional).toBe(5_000);
    expect(holdingA!.price).toBe(100);

    // B: perName=5000, price=200 → targetQty=25
    const holdingB = plan.targets.find((t) => t.symbol === 'B');
    expect(holdingB!.targetQty).toBe(25);
    expect(holdingB!.deltaQty).toBe(25);

    // Orders: 2 BUY intents, none for C
    expect(plan.ordersSubmitted).toHaveLength(2);
    const symbols = plan.ordersSubmitted.map((o) => o.symbol);
    expect(symbols).toContain('A');
    expect(symbols).toContain('B');
    expect(symbols).not.toContain('C');
    for (const o of plan.ordersSubmitted) {
      expect(o.side).toBe('BUY');
    }

    // Recorder saw same 2 BUY intents with correct fields
    expect(recorder.calls).toHaveLength(2);
    const recA = recorder.calls.find((c) => c.symbol === 'A');
    expect(recA?.side).toBe('BUY');
    expect(recA?.quantity).toBe(50);
    expect(recA?.orderType).toBe('MARKET');
    expect(recA?.strategyId).toBe(42);
    expect(recA?.currency).toBe('KRW');
    expect(recA?.mode).toBe('PAPER');
  });
});

// ── Suite 2: Rebalance from an existing book ──────────────────────────────────
describe('FactorPortfolioManager.rebalance – existing book', () => {
  it('sends delta BUY/SELL for A (resized) and exit SELL for Z (dropped)', async () => {
    // ranking = [A, B]  (topN=2)
    // held: A (qty=30, target=50 → delta +20 BUY), Z (dropped → exit SELL qty=10)
    // B is new (qty=0 → BUY 25)
    const recorder = makeRecorder();
    const currentQtys: Record<string, number> = { A: 30, Z: 10 };
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A', 'B']),
      currentQty: (symbol) => currentQtys[symbol] ?? 0,
      heldSymbols: () => ['A', 'Z'],
      priceOf: (symbol) => ({ A: 100, B: 200 })[symbol],
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 2_000,
    };
    const mgr = new FactorPortfolioManager(deps, BASE_CONFIG);
    const plan = await mgr.rebalance();

    expect(plan.halted).toBe(false);

    // targets: A and B
    expect(plan.targets).toHaveLength(2);
    const tA = plan.targets.find((t) => t.symbol === 'A')!;
    expect(tA.targetQty).toBe(50);
    expect(tA.currentQty).toBe(30);
    expect(tA.deltaQty).toBe(20);

    const tB = plan.targets.find((t) => t.symbol === 'B')!;
    expect(tB.targetQty).toBe(25);
    expect(tB.currentQty).toBe(0);
    expect(tB.deltaQty).toBe(25);

    // sells: Z only
    expect(plan.sells).toHaveLength(1);
    expect(plan.sells[0]!.symbol).toBe('Z');
    expect(plan.sells[0]!.qty).toBe(10);

    // 3 orders: Z-SELL, A-BUY delta, B-BUY
    expect(plan.ordersSubmitted).toHaveLength(3);
    const zOrder = plan.ordersSubmitted.find((o) => o.symbol === 'Z');
    expect(zOrder?.side).toBe('SELL');
    expect(zOrder?.qty).toBe(10);

    const aOrder = plan.ordersSubmitted.find((o) => o.symbol === 'A');
    expect(aOrder?.side).toBe('BUY');
    expect(aOrder?.qty).toBe(20);

    const bOrder = plan.ordersSubmitted.find((o) => o.symbol === 'B');
    expect(bOrder?.side).toBe('BUY');
    expect(bOrder?.qty).toBe(25);
  });

  it('sends delta SELL when held qty exceeds new target', async () => {
    // A is held at 80, new target = 50 → delta -30, SELL
    const recorder = makeRecorder();
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A', 'B']),
      currentQty: (symbol) => ({ A: 80, B: 0 })[symbol] ?? 0,
      heldSymbols: () => ['A'],
      priceOf: (symbol) => ({ A: 100, B: 200 })[symbol],
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 3_000,
    };
    const mgr = new FactorPortfolioManager(deps, BASE_CONFIG);
    const plan = await mgr.rebalance();

    const tA = plan.targets.find((t) => t.symbol === 'A')!;
    expect(tA.deltaQty).toBe(-30);

    const aOrder = plan.ordersSubmitted.find((o) => o.symbol === 'A')!;
    expect(aOrder.side).toBe('SELL');
    expect(aOrder.qty).toBe(30);
  });
});

// ── Suite 3: Halted ───────────────────────────────────────────────────────────
describe('FactorPortfolioManager.rebalance – halted', () => {
  it('returns halted=true plan with no orders or targets when isHalted returns true', async () => {
    const recorder = makeRecorder();
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A', 'B']),
      currentQty: () => 0,
      heldSymbols: () => ['A'],
      priceOf: () => 100,
      submitIntent: recorder.submitIntent,
      isHalted: () => true,
      now: () => 5_000,
    };
    const mgr = new FactorPortfolioManager(deps, BASE_CONFIG);
    const plan = await mgr.rebalance();

    expect(plan.halted).toBe(true);
    expect(plan.targets).toHaveLength(0);
    expect(plan.sells).toHaveLength(0);
    expect(plan.ordersSubmitted).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
    // No orders submitted
    expect(recorder.calls).toHaveLength(0);
  });
});

// ── Suite 4: Missing price ────────────────────────────────────────────────────
describe('FactorPortfolioManager.rebalance – missing price', () => {
  it('skips symbols with no price, still processes the rest', async () => {
    const recorder = makeRecorder();
    const deps: FactorPortfolioDeps = {
      // A has price, B does not
      ranking: makeRanking(['A', 'B']),
      currentQty: () => 0,
      heldSymbols: () => [],
      priceOf: (symbol) => (symbol === 'A' ? 100 : undefined),
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 6_000,
    };
    const mgr = new FactorPortfolioManager(deps, BASE_CONFIG);
    const plan = await mgr.rebalance();

    expect(plan.halted).toBe(false);

    // B is skipped
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.symbol).toBe('B');
    expect(plan.skipped[0]!.reason).toBe('no price');

    // A still has a target and an order
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.symbol).toBe('A');

    // Only A's BUY submitted
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.symbol).toBe('A');
    expect(recorder.calls[0]!.side).toBe('BUY');
  });
});

// ── Suite 5: Per-order failure isolation ──────────────────────────────────────
describe('FactorPortfolioManager.rebalance – submitIntent failure isolation', () => {
  it('adds failing symbol to skipped, continues submitting the rest', async () => {
    const submitted: string[] = [];
    let callCount = 0;
    const failingSubmit = async (intent: PortfolioOrderIntent): Promise<void> => {
      callCount++;
      if (intent.symbol === 'B') throw new Error('broker rejected B');
      submitted.push(intent.symbol);
    };

    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A', 'B', 'C']),
      currentQty: () => 0,
      heldSymbols: () => [],
      priceOf: (_symbol) => 100,
      submitIntent: failingSubmit,
      isHalted: () => false,
      now: () => 7_000,
    };
    // topN=3 so all three are targeted
    const mgr = new FactorPortfolioManager(deps, { ...BASE_CONFIG, topN: 3 });
    const plan = await mgr.rebalance();

    // B fails → skipped with the error message
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.symbol).toBe('B');
    expect(plan.skipped[0]!.reason).toContain('broker rejected B');

    // A and C still submitted
    expect(submitted).toContain('A');
    expect(submitted).toContain('C');
    expect(submitted).not.toContain('B');
    expect(plan.ordersSubmitted).toHaveLength(2);
  });
});

// ── Suite 6: Sell-before-buy ordering ────────────────────────────────────────
describe('FactorPortfolioManager.rebalance – order submission sequence', () => {
  it('submits all SELLs (exits + delta sells) before any BUYs', async () => {
    // Scenario:
    //   ranking = [A, B]  (topN=2)
    //   heldSymbols = [A, X, Y]
    //   A: currentQty=80, targetQty=50 → delta SELL 30
    //   X: not in top-N → exit SELL qty=15
    //   Y: not in top-N → exit SELL qty=5
    //   B: new → BUY 25
    const recorder = makeRecorder();
    const currentQtys: Record<string, number> = { A: 80, X: 15, Y: 5 };
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A', 'B']),
      currentQty: (symbol) => currentQtys[symbol] ?? 0,
      heldSymbols: () => ['A', 'X', 'Y'],
      priceOf: (symbol) => ({ A: 100, B: 200 })[symbol],
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 8_000,
    };
    const mgr = new FactorPortfolioManager(deps, BASE_CONFIG);
    const plan = await mgr.rebalance();

    expect(plan.ordersSubmitted.length).toBeGreaterThan(0);

    // All SELLs must appear before any BUY in call order
    const firstBuyIdx = recorder.calls.findIndex((c) => c.side === 'BUY');
    const lastSellIdx = recorder.calls.reduce(
      (acc, c, i) => (c.side === 'SELL' ? i : acc),
      -1,
    );

    // There must be at least one SELL and one BUY
    expect(firstBuyIdx).toBeGreaterThan(-1);
    expect(lastSellIdx).toBeGreaterThan(-1);

    // Last SELL comes before first BUY
    expect(lastSellIdx).toBeLessThan(firstBuyIdx);
  });

  it('skips symbols with no change (deltaQty=0) without submitting orders', async () => {
    // A is already at exact target qty → deltaQty=0 → no order
    const recorder = makeRecorder();
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A', 'B']),
      currentQty: (symbol) => ({ A: 50, B: 0 })[symbol] ?? 0,
      heldSymbols: () => ['A'],
      priceOf: (symbol) => ({ A: 100, B: 200 })[symbol],
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 9_000,
    };
    const mgr = new FactorPortfolioManager(deps, BASE_CONFIG);
    const plan = await mgr.rebalance();

    // A has deltaQty=0 → no order for A; B is new → BUY 25
    expect(plan.ordersSubmitted).toHaveLength(1);
    expect(plan.ordersSubmitted[0]!.symbol).toBe('B');
    expect(plan.ordersSubmitted[0]!.side).toBe('BUY');
    expect(recorder.calls).toHaveLength(1);
  });
});

// ── Suite 7: now() default ────────────────────────────────────────────────────
describe('FactorPortfolioManager.rebalance – asOf timestamp', () => {
  it('uses Date.now when no now() injected', async () => {
    const before = Date.now();
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['A']),
      currentQty: () => 0,
      heldSymbols: () => [],
      priceOf: () => 100,
      submitIntent: noop,
      isHalted: () => false,
      // no now
    };
    const mgr = new FactorPortfolioManager(deps, { ...BASE_CONFIG, topN: 1 });
    const plan = await mgr.rebalance();
    const after = Date.now();
    expect(plan.asOf).toBeGreaterThanOrEqual(before);
    expect(plan.asOf).toBeLessThanOrEqual(after);
  });
});
