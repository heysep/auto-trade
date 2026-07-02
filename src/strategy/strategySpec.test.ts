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
});
