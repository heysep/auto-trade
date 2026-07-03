import { describe, it, expect } from 'vitest';
import { buildStrategy, type StrategySpec } from './strategySpec.js';

let ts = 0;
const q = (last: number) => ({ symbol: 'X', currency: 'KRW' as const, bid: last, ask: last, last, ts: ++ts });

describe('buildStrategy', () => {
  it('builds a tsmom strategy and emits BULLISH after warmup', () => {
    const s = buildStrategy(1, 'X', 'KRW', 'PAPER', {
      type: 'tsmom',
      params: { lookback: 2, orderNotional: 1000 },
    });
    // warmup: 3 bars required (lookback+1)
    expect(s.signal!(q(100))).toBe('NEUTRAL');
    expect(s.signal!(q(100))).toBe('NEUTRAL');
    expect(s.signal!(q(100))).toBe('NEUTRAL');   // return = 0 → NEUTRAL
    expect(s.signal!(q(130))).toBe('BULLISH');   // (130-100)/100 = +0.30 → BULLISH
  });

  it('builds a composite of tsmom AND tsmom', () => {
    const spec: StrategySpec = {
      type: 'composite',
      combine: 'AND',
      orderNotional: 1000,
      a: { type: 'tsmom', params: { lookback: 2, orderNotional: 1 } },
      b: { type: 'tsmom', params: { lookback: 3, orderNotional: 1 } },
    };
    const s = buildStrategy(2, 'X', 'KRW', 'PAPER', spec);
    expect(s.symbols.has('X')).toBe(true);
    expect(typeof s.signal).toBe('function');
  });

  it('throws on an unknown spec type', () => {
    expect(() => buildStrategy(3, 'X', 'KRW', 'PAPER', { type: 'nope' } as unknown as StrategySpec)).toThrow();
  });

  it('builds a volbreakout strategy that returns null when range not yet resolved then BUYs after resolve', async () => {
    let resolve!: (val: { prevHigh: number; prevLow: number; todayOpen: number }) => void;
    const p = new Promise<{ prevHigh: number; prevLow: number; todayOpen: number }>((res) => {
      resolve = res;
    });
    const s = buildStrategy(4, 'A005930', 'KRW', 'PAPER',
      { type: 'volbreakout', params: { k: 0.5, budget: 100_000, symbols: ['A005930'] } },
      { getDailyRange: () => p },
    );
    expect(s.symbols.has('A005930')).toBe(true);
    // First tick: range not yet resolved → null
    const ts = Date.parse('2026-07-03T10:00:00+09:00');
    const quote = { symbol: 'A005930', currency: 'KRW' as const, bid: 120, ask: 120, last: 120, ts };
    expect(s.evaluate({ quote, position: undefined })).toBeNull();
    // Resolve: target = 100 + 0.5 * 20 = 110; 120 > 110 → BUY
    resolve({ prevHigh: 110, prevLow: 90, todayOpen: 100 });
    await Promise.resolve();
    const quote2 = { ...quote, ts: ts + 60_000 };
    expect(s.evaluate({ quote: quote2, position: undefined })?.side).toBe('BUY');
  });
});
