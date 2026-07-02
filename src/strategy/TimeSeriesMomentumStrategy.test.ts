import { describe, it, expect, beforeEach } from 'vitest';
import { TimeSeriesMomentumStrategy } from './TimeSeriesMomentumStrategy.js';
import type { Quote } from '../domain/types.js';

let ts = 0;
beforeEach(() => { ts = 0; });
const q = (last: number): Quote => ({ symbol: 'X', currency: 'KRW', bid: last, ask: last, last, ts: ++ts });
const make = (o: Partial<{ lookback: number; threshold: number }> = {}) => new TimeSeriesMomentumStrategy({
  id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', lookback: 3, orderNotional: 1000, ...o,
});

describe('TimeSeriesMomentumStrategy (AQR TSMOM)', () => {
  it('is NEUTRAL until lookback+1 bars are seen', () => {
    const s = make();
    expect(s.signal!(q(100))).toBe('NEUTRAL');
    expect(s.signal!(q(100))).toBe('NEUTRAL');
    expect(s.signal!(q(100))).toBe('NEUTRAL');
    expect(s.signal!(q(100))).toBe('NEUTRAL');   // 4th: trailing return 0 -> NEUTRAL
  });

  it('BULLISH on a positive trailing return, BEARISH on a negative one', () => {
    const s = make();
    for (const p of [100, 100, 100, 100]) s.signal!(q(p));
    expect(s.signal!(q(130))).toBe('BULLISH');   // (130-100)/100 = +0.30
    expect(s.signal!(q(70))).toBe('BEARISH');    // window [100,100,130,70] -> (70-100)/100 = -0.30
  });

  it('respects the dead-band threshold', () => {
    const s = make({ threshold: 0.05 });
    for (const p of [100, 100, 100, 100]) s.signal!(q(p));
    expect(s.signal!(q(103))).toBe('NEUTRAL');   // +3% within ±5% band
    expect(s.signal!(q(120))).toBe('BULLISH');   // window shifted; > +5%
  });

  it('ignores re-delivered (non-increasing) timestamps', () => {
    const s = make();
    const dup: Quote = { symbol: 'X', currency: 'KRW', bid: 100, ask: 100, last: 100, ts: 5 };
    expect(s.signal!(dup)).toBe('NEUTRAL');
    expect(s.signal!(dup)).toBe('NEUTRAL');       // same ts -> guarded, window not advanced
  });

  it('rejects invalid configs', () => {
    expect(() => make({ lookback: 0 })).toThrow();
    expect(() => make({ lookback: 2.5 })).toThrow();
    expect(() => make({ threshold: -0.1 })).toThrow();
  });

  it('serializes and restores its window', () => {
    const s = make();
    for (const p of [100, 100, 100, 130]) s.signal!(q(p));
    const s2 = make();
    s2.deserialize(s.serialize());
    expect(s2.signal!(q(130))).toBe('BULLISH');   // restored window makes the next bar bullish
  });
});
