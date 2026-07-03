import { describe, it, expect } from 'vitest';
import { BacktestEngine, type Bar } from './BacktestEngine.js';
import { TimeSeriesMomentumStrategy } from '../strategy/TimeSeriesMomentumStrategy.js';
import type { Strategy } from '../strategy/Strategy.js';

const bars = (prices: number[]): Bar[] => prices.map((price, i) => ({ ts: i + 1, price }));
const engine = new BacktestEngine();

describe('BacktestEngine', () => {
  it('follows momentum and books a winning round-trip with NEXT-BAR fills', async () => {
    // lookback=2 → needs 3 bars warmup
    // Bar 1-3 (100,100,100): NEUTRAL
    // Bar 4 (110): past=100, return=+10% → BULLISH, BUY queued
    // Bar 5 (130): BUY fills at 130; past=100, return=+30% → BULLISH, null
    // Bar 6 (100): past=110, return=-9% → BEARISH, SELL queued
    // Bar 7 (160): SELL fills at 160 → profit=(160-130)*qty > 0
    const strat = new TimeSeriesMomentumStrategy({
      id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', lookback: 2, orderNotional: 1_000,
    });
    const res = await engine.run(strat, bars([100, 100, 100, 110, 130, 100, 160]), { capital: 2_000, currency: 'KRW' });

    expect(res.trades).toHaveLength(1);
    expect(res.metrics.winRate).toBe(1);
    expect(res.metrics.totalReturn).toBeGreaterThan(0);
    expect(res.equityCurve).toHaveLength(8);      // 7 bars + baseline
    expect(res.finalPosition).toBeUndefined();    // flat at end
    expect(res.rejected).toBe(0);

    expect(res.fills).toHaveLength(2);
    expect(res.fills[0]?.side).toBe('BUY');
    expect(res.fills[1]?.side).toBe('SELL');
  });

  it('books a losing round-trip with a negative return and drawdown', async () => {
    // Bar 1-3: NEUTRAL warmup
    // Bar 4 (110): BULLISH, BUY queued
    // Bar 5 (130): BUY fills at 130; [100,110,130] → BULLISH, null
    // Bar 6 (80): [110,130,80], past=110, return=-27% → BEARISH, SELL queued
    // Bar 7 (70): SELL fills at 70 → loss=(70-130)*qty < 0
    const strat = new TimeSeriesMomentumStrategy({
      id: 2, symbol: 'X', currency: 'KRW', mode: 'PAPER', lookback: 2, orderNotional: 1_000,
    });
    const res = await engine.run(strat, bars([100, 100, 100, 110, 130, 80, 70]), { capital: 2_000, currency: 'KRW' });
    expect(res.trades).toHaveLength(1);
    expect(res.metrics.winRate).toBe(0);
    expect(res.metrics.totalReturn).toBeLessThan(0);
    expect(res.metrics.maxDrawdown).toBeLessThan(0);
  });

  it('stays flat when trailing returns are always zero (no momentum signal)', async () => {
    const strat = new TimeSeriesMomentumStrategy({
      id: 3, symbol: 'X', currency: 'KRW', mode: 'PAPER', lookback: 2, orderNotional: 1_000,
    });
    const res = await engine.run(strat, bars([100, 100, 100, 100, 100]), { capital: 1_000, currency: 'KRW' });
    expect(res.trades).toHaveLength(0);
    expect(res.metrics.totalReturn).toBe(0);
  });

  it('handles an empty series', async () => {
    const strat = new TimeSeriesMomentumStrategy({
      id: 4, symbol: 'X', currency: 'KRW', mode: 'PAPER', lookback: 2, orderNotional: 850,
    });
    const res = await engine.run(strat, [], { capital: 1_000, currency: 'KRW' });
    expect(res.equityCurve).toEqual([1_000]);
    expect(res.metrics.tradeCount).toBe(0);
  });

  it('rejects multi-symbol strategies and invalid bars', async () => {
    const multi: Strategy = { id: 9, symbols: new Set(['A', 'B']), currency: 'KRW', mode: 'PAPER', evaluate: () => null };
    await expect(engine.run(multi, bars([100]), { capital: 1_000, currency: 'KRW' })).rejects.toThrow(/single-symbol/);

    const strat = new TimeSeriesMomentumStrategy({
      id: 5, symbol: 'X', currency: 'KRW', mode: 'PAPER', lookback: 2, orderNotional: 850,
    });
    await expect(engine.run(strat, [{ ts: 1, price: -5 }], { capital: 1_000, currency: 'KRW' })).rejects.toThrow(/invalid bar price/);
    await expect(engine.run(strat, [{ ts: 2, price: 10 }, { ts: 1, price: 10 }], { capital: 1_000, currency: 'KRW' }))
      .rejects.toThrow(/strictly increasing/);
  });
});
