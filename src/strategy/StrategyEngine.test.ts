import { describe, it, expect } from 'vitest';
import { StrategyEngine } from './StrategyEngine.js';
import { ThresholdStrategy } from './ThresholdStrategy.js';
import { OrderManager } from '../order/OrderManager.js';
import { RiskManager, type RiskContext } from '../risk/RiskManager.js';
import { PaperBroker } from '../broker/PaperBroker.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import type { Quote, TradingMode } from '../domain/types.js';
import type { Strategy } from './Strategy.js';

const T = 1_700_000_000_000;
const q = (last: number, ts = T): Quote => ({
  symbol: '005930', currency: 'KRW', bid: last, ask: last, last, ts,
});

function wire() {
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  const broker = new PaperBroker(repo, book, { now: () => T, maxQuoteAgeMs: 1e12 });
  const logger = new InMemoryEventLogger();
  const riskContext = (strategy: Strategy, symbol: string): RiskContext => {
    return {
      mode: strategy.mode, status: 'PAPER_TESTING', capital: 2_000_000,
      limits: { maxPositionPct: 100, dailyMaxLoss: 1e9, maxConsecutiveLosses: 99 },
      positions: repo.getPositions(strategy.id, strategy.mode),   // portfolio-wide, not just this symbol
      openOrdersForSymbol: repo.getOpenOrdersBySymbol(symbol, strategy.mode).length,
      dailyRealizedPnl: 0, consecutiveLosses: 0,
    };
  };
  const orderManager = new OrderManager({
    brokerFor: (_m: TradingMode) => broker, risk: new RiskManager(), riskContext, logger, now: () => T,
  });
  const engine = new StrategyEngine({
    orderManager,
    getPosition: (id, sym, mode) => repo.getPosition(id, sym, mode),
  });
  return { repo, book, engine, logger };
}

describe('StrategyEngine integration', () => {
  it('runs a full buy-low / sell-high cycle through risk and the paper broker', async () => {
    const { repo, book, engine, logger } = wire();
    engine.register(new ThresholdStrategy({
      id: 1, symbol: '005930', currency: 'KRW', mode: 'PAPER',
      buyBelow: 70_000, sellAbove: 80_000, orderNotional: 700_000,
    }));

    // Tick below buyBelow -> entry
    book.set(q(69_000));
    await engine.onTick(q(69_000));
    let pos = repo.getPosition(1, '005930', 'PAPER')!;
    expect(pos.quantity).toBe(10);                    // floor(700000/69000)
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1);

    // Tick still low -> no action (already long, below sell level)
    book.set(q(69_500, T + 1000));
    await engine.onTick(q(69_500, T + 1000));
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1);

    // Tick above sellAbove -> exit whole position
    book.set(q(81_000, T + 2000));
    await engine.onTick(q(81_000, T + 2000));
    pos = repo.getPosition(1, '005930', 'PAPER')!;
    expect(pos.quantity).toBe(0);
    expect(pos.realizedPnl).toBeGreaterThan(0);       // sold higher than bought
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(2);
  });

  it('isolates one strategy error from the rest of the tick', async () => {
    const boom: Strategy = {
      id: 9, symbols: new Set(['005930']), currency: 'KRW', mode: 'PAPER',
      evaluate() { throw new Error('strategy blew up'); },
    };
    let captured: unknown;
    const eng = new StrategyEngine({
      orderManager: { handleIntent: async () => { /* never reached */ } } as unknown as OrderManager,
      getPosition: () => undefined,
      onError: (e) => { captured = e; },
    });
    eng.register(boom);
    await expect(eng.onTick(q(69_000))).resolves.toBeUndefined();
    expect(captured).toBeInstanceOf(Error);
  });
});
