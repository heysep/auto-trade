import { describe, it, expect } from 'vitest';
import { BacktestEngine, type Bar } from './BacktestEngine.js';
import { ThresholdStrategy } from '../strategy/ThresholdStrategy.js';
import { MovingAverageCrossStrategy } from '../strategy/MovingAverageCrossStrategy.js';
import type { Strategy } from '../strategy/Strategy.js';

const bars = (prices: number[]): Bar[] => prices.map((price, i) => ({ ts: i + 1, price }));
const engine = new BacktestEngine();

describe('BacktestEngine', () => {
  it('buys the dip and sells the rip with NEXT-BAR fills, booking a winning round-trip', async () => {
    const strat = new ThresholdStrategy({
      id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', buyBelow: 90, sellAbove: 110, orderNotional: 900,
    });
    // signal at 85 -> fills at next bar 86; signal at 130 -> fills at next bar 130
    const res = await engine.run(strat, bars([100, 85, 86, 130, 130]), { capital: 2000, currency: 'KRW' });

    expect(res.trades).toHaveLength(1);
    expect(res.metrics.winRate).toBe(1);
    expect(res.metrics.totalReturn).toBeGreaterThan(0);
    expect(res.equityCurve).toHaveLength(6);
    expect(res.finalPosition).toBeUndefined();       // flat at end -> omitted
    expect(res.rejected).toBe(0);
  });

  it('books a losing round-trip with a negative return and drawdown', async () => {
    const strat = new ThresholdStrategy({
      id: 2, symbol: 'X', currency: 'KRW', mode: 'PAPER', buyBelow: 200, sellAbove: 0, orderNotional: 1000,
    });
    const res = await engine.run(strat, bars([100, 90, 80]), { capital: 2000, currency: 'KRW' });
    expect(res.trades).toHaveLength(1);
    expect(res.metrics.winRate).toBe(0);
    expect(res.metrics.totalReturn).toBeLessThan(0);
    expect(res.metrics.maxDrawdown).toBeLessThan(0);
  });

  it('stays flat when an MA strategy sees no cross', async () => {
    const strat = new MovingAverageCrossStrategy({
      id: 3, symbol: 'X', currency: 'KRW', mode: 'PAPER', fastPeriod: 2, slowPeriod: 4, orderNotional: 1000,
    });
    const res = await engine.run(strat, bars([100, 100, 100, 100, 100]), { capital: 1000, currency: 'KRW' });
    expect(res.trades).toHaveLength(0);
    expect(res.metrics.totalReturn).toBe(0);
  });

  it('handles an empty series', async () => {
    const strat = new ThresholdStrategy({
      id: 4, symbol: 'X', currency: 'KRW', mode: 'PAPER', buyBelow: 90, sellAbove: 110, orderNotional: 850,
    });
    const res = await engine.run(strat, [], { capital: 1000, currency: 'KRW' });
    expect(res.equityCurve).toEqual([1000]);
    expect(res.metrics.tradeCount).toBe(0);
  });

  it('rejects multi-symbol strategies and invalid bars', async () => {
    const multi: Strategy = { id: 9, symbols: new Set(['A', 'B']), currency: 'KRW', mode: 'PAPER', evaluate: () => null };
    await expect(engine.run(multi, bars([100]), { capital: 1000, currency: 'KRW' })).rejects.toThrow(/single-symbol/);

    const strat = new ThresholdStrategy({
      id: 5, symbol: 'X', currency: 'KRW', mode: 'PAPER', buyBelow: 90, sellAbove: 110, orderNotional: 850,
    });
    await expect(engine.run(strat, [{ ts: 1, price: -5 }], { capital: 1000, currency: 'KRW' })).rejects.toThrow(/invalid bar price/);
    await expect(engine.run(strat, [{ ts: 2, price: 10 }, { ts: 1, price: 10 }], { capital: 1000, currency: 'KRW' }))
      .rejects.toThrow(/strictly increasing/);
  });
});
