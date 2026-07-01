import { describe, it, expect } from 'vitest';
import { CompositeStrategy } from './CompositeStrategy.js';
import type { Strategy } from './Strategy.js';
import type { Signal } from './signal.js';

const stub = (sig: Signal): Strategy => ({ id: 0, symbols: new Set(['X']), currency: 'KRW', mode: 'PAPER', evaluate: () => null, signal: () => sig });
const q = (last: number) => ({ symbol: 'X', currency: 'KRW' as const, bid: last, ask: last, last, ts: 1 });
const comp = (combine: 'AND' | 'OR', a: Signal, b: Signal) =>
  new CompositeStrategy({ id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', orderNotional: 1000, combine }, stub(a), stub(b)).signal!(q(100));

describe('CompositeStrategy.signal', () => {
  it('AND: BULLISH only if both bullish; BEARISH if either bearish', () => {
    expect(comp('AND', 'BULLISH', 'BULLISH')).toBe('BULLISH');
    expect(comp('AND', 'BULLISH', 'NEUTRAL')).toBe('NEUTRAL');
    expect(comp('AND', 'BULLISH', 'BEARISH')).toBe('BEARISH');
  });
  it('OR: BULLISH if either bullish; BEARISH only if both bearish', () => {
    expect(comp('OR', 'BULLISH', 'BEARISH')).toBe('BULLISH');
    expect(comp('OR', 'NEUTRAL', 'BEARISH')).toBe('NEUTRAL');
    expect(comp('OR', 'BEARISH', 'BEARISH')).toBe('BEARISH');
  });
});
