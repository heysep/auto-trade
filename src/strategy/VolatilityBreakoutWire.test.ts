import { describe, it, expect } from 'vitest';
import { StrategyEngine } from './StrategyEngine.js';
import { VolatilityBreakoutStrategy } from './VolatilityBreakoutStrategy.js';
import { OrderManager } from '../order/OrderManager.js';
import { RiskManager, type RiskContext } from '../risk/RiskManager.js';
import { PaperBroker } from '../broker/PaperBroker.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import type { Quote, TradingMode } from '../domain/types.js';
import type { Strategy } from './Strategy.js';
import type { Broker } from '../broker/Broker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Quote at an exact KST time. */
function makeQuote(last: number, dateStr: string, hhmm: string): Quote {
  return {
    symbol: '011200',
    currency: 'KRW',
    bid: last,
    ask: last,
    last,
    ts: Date.parse(`${dateStr}T${hhmm}:00+09:00`),
  };
}

const DATE = '2026-07-03'; // KRX trading day

/** Fake range: todayOpen=100, prevHigh=110, prevLow=90 → target = 100 + 0.5*20 = 110 */
const fakeRange = async (_sym: string) => ({ prevHigh: 110, prevLow: 90, todayOpen: 100 });

const STRATEGY_ID = 3;
const BUDGET = 100_000;

/** Shared wire function for integration tests. */
function wire(brokerOverride?: { LIVE: Broker }) {
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  const broker = new PaperBroker(repo, book, { now: () => Date.now(), maxQuoteAgeMs: 1e12 });
  const logger = new InMemoryEventLogger();

  const riskContext = (strategy: Strategy, symbol: string): RiskContext => ({
    mode: strategy.mode,
    status: 'PAPER_TESTING',
    capital: BUDGET,
    limits: {
      maxPositionPct: 100,
      dailyMaxLoss: Math.round(BUDGET * 0.1),
      maxConsecutiveLosses: 3,
    },
    positions: repo.getPositions(strategy.id, strategy.mode),
    openOrdersForSymbol: repo.getOpenOrdersBySymbol(symbol, strategy.mode).length,
    dailyRealizedPnl: 0,
    consecutiveLosses: 0,
  });

  const orderManager = new OrderManager({
    brokerFor: brokerOverride
      ? (mode: TradingMode) => mode === 'LIVE' ? brokerOverride.LIVE : broker
      : () => broker,
    risk: new RiskManager(),
    riskContext,
    logger,
    now: () => Date.now(),
    // Zero slippage buffer so floor(budget/price)*price never slightly exceeds capital;
    // this test exercises strategy logic and broker flow, not worst-case slippage.
    marketBufferBps: 0,
  });

  const engine = new StrategyEngine({
    orderManager,
    getPosition: (id, sym, mode) => repo.getPosition(id, sym, mode),
  });

  return { repo, book, engine, logger, broker };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('VolatilityBreakoutWire integration', () => {
  it('places BUY when price crosses target inside entry window, qty = floor(budget/price)', async () => {
    const { repo, book, engine, logger } = wire();
    engine.register(new VolatilityBreakoutStrategy({
      id: STRATEGY_ID, symbol: '011200', currency: 'KRW', mode: 'PAPER',
      k: 0.5, budget: BUDGET,
      getDailyRange: fakeRange,
    }));

    // First tick — kicks async range fetch (target=110 once resolved)
    const q0 = makeQuote(100, DATE, '09:10');
    book.set(q0);
    await engine.onTick(q0);
    await Promise.resolve(); // flush microtask so range resolves
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(0); // below target

    // Second tick at price=115 ≥ target=110 → BUY floor(100_000/115) = 869
    const q1 = makeQuote(115, DATE, '09:11');
    book.set(q1);
    await engine.onTick(q1);
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1);
    const pos = repo.getPosition(STRATEGY_ID, '011200', 'PAPER')!;
    expect(pos.quantity).toBe(Math.floor(BUDGET / 115)); // 869
  });

  it('places SELL for full position at 15:11 KST (force liquidation at >= 15:10)', async () => {
    const { repo, book, engine, logger } = wire();
    engine.register(new VolatilityBreakoutStrategy({
      id: STRATEGY_ID, symbol: '011200', currency: 'KRW', mode: 'PAPER',
      k: 0.5, budget: BUDGET,
      getDailyRange: fakeRange,
    }));

    // Enter at 10:00 (kick fetch) then 10:01 (above target)
    const q0 = makeQuote(100, DATE, '10:00');
    book.set(q0);
    await engine.onTick(q0);
    await Promise.resolve();

    const qEntry = makeQuote(115, DATE, '10:01');
    book.set(qEntry);
    await engine.onTick(qEntry);
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1);
    const qty = repo.getPosition(STRATEGY_ID, '011200', 'PAPER')!.quantity;
    expect(qty).toBeGreaterThan(0);

    // Exit at 15:11 (>= exitMin=15:10)
    const qExit = makeQuote(112, DATE, '15:11');
    book.set(qExit);
    await engine.onTick(qExit);
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(2);
    const posAfter = repo.getPosition(STRATEGY_ID, '011200', 'PAPER')!;
    expect(posAfter.quantity).toBe(0);
  });

  it('does NOT re-enter after exit on the same day', async () => {
    const { repo: _repo, book, engine, logger } = wire();
    engine.register(new VolatilityBreakoutStrategy({
      id: STRATEGY_ID, symbol: '011200', currency: 'KRW', mode: 'PAPER',
      k: 0.5, budget: BUDGET,
      getDailyRange: fakeRange,
    }));

    const q0 = makeQuote(100, DATE, '10:00');
    book.set(q0);
    await engine.onTick(q0);
    await Promise.resolve();

    // Enter
    const qEntry = makeQuote(115, DATE, '10:01');
    book.set(qEntry);
    await engine.onTick(qEntry);

    // Exit at 15:11
    const qExit = makeQuote(112, DATE, '15:11');
    book.set(qExit);
    await engine.onTick(qExit);

    // Attempt re-entry same day at 15:15 — must be blocked (enteredToday=true after exit)
    const qRetry = makeQuote(120, DATE, '15:15');
    book.set(qRetry);
    await engine.onTick(qRetry);
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(2); // still only buy + sell
  });
});

// ---------------------------------------------------------------------------
// brokerFor routing
// ---------------------------------------------------------------------------

describe('brokerFor routing', () => {
  it('PAPER mode strategy never touches live broker (routes to paperBroker)', async () => {
    let liveTouched = false;
    const fakeLiveBroker: Broker = {
      placeOrder: async () => { liveTouched = true; throw new Error('should not be called'); },
      cancelOrder: async () => {},
      getOpenOrders: async () => [],
      getFills: async () => [],
    };

    const { engine, book, logger } = wire({ LIVE: fakeLiveBroker });
    engine.register(new VolatilityBreakoutStrategy({
      id: STRATEGY_ID, symbol: '011200', currency: 'KRW',
      mode: 'PAPER', // PAPER → paperBroker, never fakeLiveBroker
      k: 0.5, budget: BUDGET,
      getDailyRange: fakeRange,
    }));

    const q0 = makeQuote(100, DATE, '10:00');
    book.set(q0);
    await engine.onTick(q0);
    await Promise.resolve();

    const qEntry = makeQuote(115, DATE, '10:01');
    book.set(qEntry);
    await engine.onTick(qEntry);

    expect(liveTouched).toBe(false);
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1); // went through paper broker fine
  });
});
