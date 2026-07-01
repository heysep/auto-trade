import { describe, it, expect } from 'vitest';
import { ThresholdStrategy } from './ThresholdStrategy.js';

describe('ThresholdStrategy', () => {
  it('signal(): BULLISH below buyBelow, BEARISH above sellAbove, else NEUTRAL', () => {
    const s = new ThresholdStrategy({ id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', buyBelow: 90, sellAbove: 110, orderNotional: 1000 });
    expect(s.signal!({ symbol: 'X', currency: 'KRW', bid: 85, ask: 85, last: 85, ts: 1 })).toBe('BULLISH');
    expect(s.signal!({ symbol: 'X', currency: 'KRW', bid: 115, ask: 115, last: 115, ts: 2 })).toBe('BEARISH');
    expect(s.signal!({ symbol: 'X', currency: 'KRW', bid: 100, ask: 100, last: 100, ts: 3 })).toBe('NEUTRAL');
  });
});
