import { describe, it, expect } from 'vitest';
import { buildStrategy, type StrategySpec } from './strategySpec.js';

const q = (last: number) => ({ symbol: 'X', currency: 'KRW' as const, bid: last, ask: last, last, ts: 1 });

describe('buildStrategy', () => {
  it('builds a threshold strategy', () => {
    const s = buildStrategy(1, 'X', 'KRW', 'PAPER', { type: 'threshold', params: { buyBelow: 90, sellAbove: 110, orderNotional: 1000 } });
    expect(s.signal!(q(85))).toBe('BULLISH');
  });
  it('builds a composite of sma AND threshold', () => {
    const spec: StrategySpec = { type: 'composite', combine: 'AND', orderNotional: 1000,
      a: { type: 'threshold', params: { buyBelow: 90, sellAbove: 110, orderNotional: 1 } },
      b: { type: 'sma', params: { fastPeriod: 2, slowPeriod: 3, orderNotional: 1 } } };
    const s = buildStrategy(2, 'X', 'KRW', 'PAPER', spec);
    expect(s.symbols.has('X')).toBe(true);
    expect(typeof s.signal).toBe('function');
  });
  it('throws on an unknown spec type', () => {
    expect(() => buildStrategy(3, 'X', 'KRW', 'PAPER', { type: 'nope' } as unknown as StrategySpec)).toThrow();
  });
});
