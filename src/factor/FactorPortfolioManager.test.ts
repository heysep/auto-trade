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
import { OrderManager } from '../order/OrderManager.js';
import { RiskManager, type RiskContext } from '../risk/RiskManager.js';
import { PaperBroker } from '../broker/PaperBroker.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import { FACTOR_PORTFOLIO_STRATEGY_ID } from '../app/TradingSystem.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { Quote } from '../domain/types.js';

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

// ---------------------------------------------------------------------------
// C1 + C2 Integration: real OrderManager + RiskManager + PaperBroker
// ---------------------------------------------------------------------------
//
// Verifies the production wire-up in src/index.ts:
//   C1 – factor portfolio uses capital=100M / maxPositionPct=15% so a ₩10M
//        per-name slice is not blocked by the risk gate.
//   C2 – when the risk gate blocks an order the C2 submitIntent bridge throws,
//        routing the intent to `skipped` instead of `ordersSubmitted`.
//
// Math:
//   price = 500_000 KRW
//   referencePrice = ask * (1 + 50 bps) = 500_000 * 1.005 = 502_500
//
//   C1: totalNotional=20M, topN=2 → perName=10M
//       targetQty = floor(10M / 500_000) = 20
//       notional  = 20 * 502_500 = 10_050_000  ≤ 15M  → PLACED
//
//   C2: totalNotional=50M, topN=2 → perName=25M
//       targetQty = floor(25M / 500_000) = 50
//       notional  = 50 * 502_500 = 25_125_000  > 15M  → BLOCKED → skipped
// ---------------------------------------------------------------------------

describe('FactorPortfolioManager C1+C2 integration (real OrderManager/RiskManager/PaperBroker)', () => {
  const NOW = 1_700_000_000_000;
  const PRICE = 500_000;
  const FACTOR_CAPITAL = 100_000_000;
  const FACTOR_LIMITS = { maxPositionPct: 15, dailyMaxLoss: 10_000_000, maxConsecutiveLosses: 10 };

  const factorStrategy: Strategy = {
    id: FACTOR_PORTFOLIO_STRATEGY_ID,
    symbols: new Set<string>(),
    currency: 'KRW',
    mode: 'PAPER',
    evaluate: () => null,
  };

  /** Wire a real pipeline identical to production but with injectable capital/limits. */
  function wireIntegration(capital: number, limits: typeof FACTOR_LIMITS) {
    const repo    = new InMemoryRepository();
    const book    = new QuoteBook();
    const broker  = new PaperBroker(repo, book, { now: () => NOW, maxQuoteAgeMs: 1e12 });
    const logger  = new InMemoryEventLogger();
    const risk    = new RiskManager();

    const riskContext = (_strategy: Strategy, symbol: string): RiskContext => ({
      mode: 'PAPER',
      status: 'PAPER_TESTING',
      capital,
      limits,
      positions: repo.getPositions(FACTOR_PORTFOLIO_STRATEGY_ID, 'PAPER'),
      openOrdersForSymbol: repo.getOpenOrdersBySymbol(symbol, 'PAPER').length,
      dailyRealizedPnl: 0,
      consecutiveLosses: 0,
    });

    const orderManager = new OrderManager({
      brokerFor: () => broker,
      risk,
      riskContext,
      logger,
      now: () => NOW,
    });

    /** C2-aware bridge: mirrors src/index.ts submitIntent */
    const submitIntent = async (pIntent: PortfolioOrderIntent): Promise<void> => {
      const quote = book.getQuote(pIntent.symbol);
      if (quote === undefined) throw new Error(`no quote for ${pIntent.symbol}`);
      const outcome = await orderManager.handleIntent(
        factorStrategy,
        { side: pIntent.side, quantity: pIntent.quantity, orderType: 'MARKET', reason: pIntent.reason },
        quote,
      );
      if (outcome.status !== 'placed') {
        const msg = outcome.status === 'blocked'
          ? (outcome.reason ?? 'risk blocked')
          : String((outcome as { error?: unknown }).error ?? outcome.status);
        throw new Error(msg);
      }
    };

    return { repo, book, broker, logger, risk, orderManager, submitIntent };
  }

  function makeQuote(symbol: string): Quote {
    return { symbol, currency: 'KRW', bid: PRICE, ask: PRICE, last: PRICE, ts: NOW };
  }

  function makeRankingFor(symbols: string[]) {
    return {
      rank: async (limit?: number) => ({
        scored: (limit !== undefined ? symbols.slice(0, limit) : symbols).map((s) => ({ symbol: s })),
      }),
    };
  }

  it('C1: factor portfolio risk config allows ₩10M per-name BUY — orders are placed', async () => {
    const symbols = ['A', 'B'];
    const { book, submitIntent } = wireIntegration(FACTOR_CAPITAL, FACTOR_LIMITS);

    // Pre-populate quotes
    for (const sym of symbols) book.set(makeQuote(sym));

    const manager = new FactorPortfolioManager(
      {
        ranking:      makeRankingFor(symbols),
        priceOf:      (sym) => book.getQuote(sym)?.last,
        currentQty:   () => 0,
        heldSymbols:  () => [],
        submitIntent,
        isHalted:     () => false,
        now:          () => NOW,
      },
      {
        strategyId:    FACTOR_PORTFOLIO_STRATEGY_ID,
        topN:          2,
        totalNotional: 20_000_000,   // perName = 10M → 20 shares @ 500K → notional ≈ 10.05M ≤ 15M ✓
        currency:      'KRW',
        mode:          'PAPER',
      },
    );

    const plan = await manager.rebalance();

    expect(plan.halted).toBe(false);
    // Both symbols must be submitted (not skipped)
    expect(plan.ordersSubmitted).toHaveLength(2);
    expect(plan.skipped).toHaveLength(0);
    // Both are BUY orders
    for (const order of plan.ordersSubmitted) {
      expect(order.side).toBe('BUY');
    }
  });

  it('C2: over-concentrated BUY is blocked by risk gate and lands in skipped (not ordersSubmitted)', async () => {
    const symbols = ['A', 'B'];
    const { book, submitIntent } = wireIntegration(FACTOR_CAPITAL, FACTOR_LIMITS);

    // Pre-populate quotes
    for (const sym of symbols) book.set(makeQuote(sym));

    const manager = new FactorPortfolioManager(
      {
        ranking:      makeRankingFor(symbols),
        priceOf:      (sym) => book.getQuote(sym)?.last,
        currentQty:   () => 0,
        heldSymbols:  () => [],
        submitIntent,
        isHalted:     () => false,
        now:          () => NOW,
      },
      {
        strategyId:    FACTOR_PORTFOLIO_STRATEGY_ID,
        topN:          2,
        totalNotional: 50_000_000,   // perName = 25M → 50 shares @ 500K → notional ≈ 25.125M > 15M → BLOCKED
        currency:      'KRW',
        mode:          'PAPER',
      },
    );

    const plan = await manager.rebalance();

    expect(plan.halted).toBe(false);
    // All blocked intents must be in skipped — not ordersSubmitted (C2 regression guard)
    expect(plan.ordersSubmitted).toHaveLength(0);
    expect(plan.skipped.length).toBeGreaterThan(0);
    // Reason string must reflect the risk-gate denial
    for (const s of plan.skipped) {
      expect(s.reason).toMatch(/exceeds max position 15%/);
    }
  });
});

// ── Suite 8: Affordability-fill — ₩100k budget walks past expensive symbols ──
describe('FactorPortfolioManager.rebalance – affordability-fill (₩100k budget)', () => {
  it('fills topN=3 slots by walking past unaffordable top-ranked symbols', async () => {
    // Ranking (rank order): EXPENSIVE(₩2.2M), CHEAP1(₩20k), EXPENSIVE2(₩300k), CHEAP2(₩15k), CHEAP3(₩30k)
    // Budget ₩100k, topN=3 → perName = 100_000/3 ≈ ₩33,333
    //   EXPENSIVE:  floor(33333/2_200_000) = 0 → unaffordable (slot NOT consumed)
    //   CHEAP1:     floor(33333/20_000)    = 1 → slot 1
    //   EXPENSIVE2: floor(33333/300_000)   = 0 → unaffordable (slot NOT consumed)
    //   CHEAP2:     floor(33333/15_000)    = 2 → slot 2
    //   CHEAP3:     floor(33333/30_000)    = 1 → slot 3  (topN filled, loop stops)
    const recorder = makeRecorder();
    const prices: Record<string, number> = {
      EXPENSIVE:  2_200_000,
      CHEAP1:     20_000,
      EXPENSIVE2: 300_000,
      CHEAP2:     15_000,
      CHEAP3:     30_000,
    };
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['EXPENSIVE', 'CHEAP1', 'EXPENSIVE2', 'CHEAP2', 'CHEAP3']),
      currentQty: () => 0,
      heldSymbols: () => [],
      priceOf: (symbol) => prices[symbol],
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 10_000,
    };
    const mgr = new FactorPortfolioManager(deps, {
      strategyId: 42,
      topN: 3,
      totalNotional: 100_000,
      currency: 'KRW',
      mode: 'PAPER',
    });
    const plan = await mgr.rebalance();

    expect(plan.halted).toBe(false);

    // Exactly 3 slots filled with affordable symbols
    expect(plan.targets).toHaveLength(3);
    const targetSymbols = plan.targets.map((t) => t.symbol);
    expect(targetSymbols).toContain('CHEAP1');
    expect(targetSymbols).toContain('CHEAP2');
    expect(targetSymbols).toContain('CHEAP3');
    expect(targetSymbols).not.toContain('EXPENSIVE');
    expect(targetSymbols).not.toContain('EXPENSIVE2');

    // The 2 unaffordable symbols appear in skipped
    expect(plan.skipped).toHaveLength(2);
    const skippedSymbols = plan.skipped.map((s) => s.symbol);
    expect(skippedSymbols).toContain('EXPENSIVE');
    expect(skippedSymbols).toContain('EXPENSIVE2');
    for (const s of plan.skipped) {
      expect(s.reason).toBe('unaffordable');
    }

    // 3 BUY orders, each with qty >= 1
    expect(plan.ordersSubmitted).toHaveLength(3);
    for (const o of plan.ordersSubmitted) {
      expect(o.side).toBe('BUY');
      expect(o.qty).toBeGreaterThanOrEqual(1);
    }

    // Verify target quantities (perName = 100_000/3 = 33_333.33…)
    const perName = 100_000 / 3;
    const tCheap1 = plan.targets.find((t) => t.symbol === 'CHEAP1')!;
    expect(tCheap1.targetQty).toBe(Math.floor(perName / 20_000));   // 1
    expect(tCheap1.targetQty).toBeGreaterThanOrEqual(1);

    const tCheap2 = plan.targets.find((t) => t.symbol === 'CHEAP2')!;
    expect(tCheap2.targetQty).toBe(Math.floor(perName / 15_000));   // 2
    expect(tCheap2.targetQty).toBeGreaterThanOrEqual(1);

    const tCheap3 = plan.targets.find((t) => t.symbol === 'CHEAP3')!;
    expect(tCheap3.targetQty).toBe(Math.floor(perName / 30_000));   // 1
    expect(tCheap3.targetQty).toBeGreaterThanOrEqual(1);
  });

  it('exits a held symbol that is no longer in the filled target set', async () => {
    // EXPENSIVE was held from a prior rebalance; new run can't afford it → exit SELL
    const recorder = makeRecorder();
    const prices: Record<string, number> = { EXPENSIVE: 2_200_000, CHEAP: 20_000 };
    const deps: FactorPortfolioDeps = {
      ranking: makeRanking(['EXPENSIVE', 'CHEAP']),
      currentQty: (sym) => ({ EXPENSIVE: 1, CHEAP: 0 })[sym] ?? 0,
      heldSymbols: () => ['EXPENSIVE'],
      priceOf: (symbol) => prices[symbol],
      submitIntent: recorder.submitIntent,
      isHalted: () => false,
      now: () => 11_000,
    };
    // topN=1, budget=100k → perName=100k
    // EXPENSIVE: floor(100000/2200000)=0 → unaffordable → skip, slot NOT consumed
    // CHEAP: floor(100000/20000)=5 → slot 1
    // EXPENSIVE is held but not in targets → exit SELL
    const mgr = new FactorPortfolioManager(deps, {
      strategyId: 42,
      topN: 1,
      totalNotional: 100_000,
      currency: 'KRW',
      mode: 'PAPER',
    });
    const plan = await mgr.rebalance();

    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]!.symbol).toBe('CHEAP');

    // EXPENSIVE was held but is unaffordable → appears in skipped (unaffordable) AND sells (exit)
    expect(plan.skipped.some((s) => s.symbol === 'EXPENSIVE' && s.reason === 'unaffordable')).toBe(true);
    expect(plan.sells).toHaveLength(1);
    expect(plan.sells[0]!.symbol).toBe('EXPENSIVE');

    // Order sequence: SELL EXPENSIVE first, then BUY CHEAP
    const sellIdx = recorder.calls.findIndex((c) => c.symbol === 'EXPENSIVE' && c.side === 'SELL');
    const buyIdx  = recorder.calls.findIndex((c) => c.symbol === 'CHEAP' && c.side === 'BUY');
    expect(sellIdx).toBeGreaterThanOrEqual(0);
    expect(buyIdx).toBeGreaterThanOrEqual(0);
    expect(sellIdx).toBeLessThan(buyIdx);
  });
});
