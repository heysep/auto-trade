import { describe, it, expect } from 'vitest';
import { StrategyEngine } from './StrategyEngine.js';
import { TimeSeriesMomentumStrategy } from './TimeSeriesMomentumStrategy.js';
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
      positions: repo.getPositions(strategy.id, strategy.mode),
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
  it('runs a full momentum buy / exit cycle through risk and the paper broker', async () => {
    const { repo, book, engine, logger } = wire();
    engine.register(new TimeSeriesMomentumStrategy({
      id: 1, symbol: '005930', currency: 'KRW', mode: 'PAPER',
      lookback: 2, orderNotional: 700_000,
    }));

    // lookback=2 → need 3 bars warmup before first signal
    // Tick 1: NEUTRAL (1 bar seen)
    book.set(q(50_000));
    await engine.onTick(q(50_000));
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(0);

    // Tick 2: NEUTRAL (2 bars seen)
    book.set(q(60_000, T + 1000));
    await engine.onTick(q(60_000, T + 1000));
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(0);

    // Tick 3: prices=[50k,60k,70k] → past=50k, return=+40% → BULLISH → BUY qty=floor(700k/70k)=10
    book.set(q(70_000, T + 2000));
    await engine.onTick(q(70_000, T + 2000));
    let pos = repo.getPosition(1, '005930', 'PAPER')!;
    expect(pos.quantity).toBe(10);
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1);

    // Tick 4: prices=[60k,70k,90k] → past=60k, return=+50% → BULLISH, held>0 → null
    book.set(q(90_000, T + 3000));
    await engine.onTick(q(90_000, T + 3000));
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1);

    // Tick 5: prices=[70k,90k,100k] → past=70k, return=+42.8% → BULLISH, held>0 → null
    book.set(q(100_000, T + 4000));
    await engine.onTick(q(100_000, T + 4000));
    expect(logger.ofType('ORDER_PLACED')).toHaveLength(1);

    // Tick 6: prices=[90k,100k,80k] → past=90k, return=(80k-90k)/90k=-11% → BEARISH → SELL all at 80k
    // bought at 70k, sold at 80k → realizedPnl = (80k-70k)*10 = 100k > 0
    book.set(q(80_000, T + 5000));
    await engine.onTick(q(80_000, T + 5000));
    pos = repo.getPosition(1, '005930', 'PAPER')!;
    expect(pos.quantity).toBe(0);
    expect(pos.realizedPnl).toBeGreaterThan(0);
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
