import { describe, it, expect, beforeEach } from 'vitest';
import { MovingAverageCrossStrategy } from './MovingAverageCrossStrategy.js';
import type { Quote, Position } from '../domain/types.js';

let ts = 0;
beforeEach(() => { ts = 0; });
const q = (last: number): Quote => ({ symbol: 'X', currency: 'KRW', bid: last, ask: last, last, ts: ++ts });
const longPos: Position = { strategyId: 1, symbol: 'X', mode: 'PAPER', quantity: 10, avgPrice: 16, realizedPnl: 0 };
const make = () => new MovingAverageCrossStrategy({
  id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', fastPeriod: 2, slowPeriod: 3, orderNotional: 160,
});

describe('MovingAverageCrossStrategy', () => {
  it('emits nothing until the slow window is full', () => {
    const s = make();
    expect(s.evaluate({ quote: q(10), position: undefined })).toBeNull();
    expect(s.evaluate({ quote: q(10), position: undefined })).toBeNull();
    expect(s.evaluate({ quote: q(10), position: undefined })).toBeNull();   // fast==slow -> hold
  });

  it('buys when fast>slow and flat; sells the whole position when fast<slow and long', () => {
    const s = make();
    for (const p of [10, 10, 10]) s.evaluate({ quote: q(p), position: undefined });
    expect(s.evaluate({ quote: q(16), position: undefined })).toMatchObject({ side: 'BUY', quantity: 10, orderType: 'MARKET' });
    expect(s.evaluate({ quote: q(1), position: longPos })).toMatchObject({ side: 'SELL', quantity: 10 });
  });

  it('RE-EMITS a blocked entry next tick (state-targeting, not one-shot edge)', () => {
    const s = make();
    for (const p of [10, 10, 10]) s.evaluate({ quote: q(p), position: undefined });
    expect(s.evaluate({ quote: q(16), position: undefined })?.side).toBe('BUY');   // signal 1 (assume blocked -> still flat)
    expect(s.evaluate({ quote: q(17), position: undefined })?.side).toBe('BUY');   // retried while still flat & fast>slow
  });

  it('suppresses a re-entry once the position is held (at target)', () => {
    const s = make();
    for (const p of [10, 10, 10]) s.evaluate({ quote: q(p), position: undefined });
    s.evaluate({ quote: q(16), position: undefined });
    expect(s.evaluate({ quote: q(20), position: longPos })).toBeNull();            // fast>slow but already long
  });

  it('does nothing on a down-move while already flat', () => {
    const s = make();
    for (const p of [20, 20, 20]) s.evaluate({ quote: q(p), position: undefined });
    expect(s.evaluate({ quote: q(1), position: undefined })).toBeNull();           // fast<slow but flat -> no SELL
  });

  it('ignores a re-delivered tick with a non-increasing timestamp', () => {
    const s = make();
    const dup: Quote = { symbol: 'X', currency: 'KRW', bid: 10, ask: 10, last: 10, ts: 5 };
    expect(s.evaluate({ quote: dup, position: undefined })).toBeNull();
    // same ts again -> guarded out, window not advanced (still length 1)
    expect(s.evaluate({ quote: dup, position: undefined })).toBeNull();
    expect(s.evaluate({ quote: { ...dup, ts: 4 }, position: undefined })).toBeNull();   // older ts ignored
  });

  it('rejects invalid configs', () => {
    const bad = (o: Partial<{ fastPeriod: number; slowPeriod: number }>) => () => new MovingAverageCrossStrategy({
      id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', fastPeriod: 2, slowPeriod: 3, orderNotional: 100, ...o,
    });
    expect(bad({ fastPeriod: 5, slowPeriod: 3 })).toThrow();    // fast >= slow
    expect(bad({ fastPeriod: 0 })).toThrow();                   // non-positive
    expect(bad({ slowPeriod: 3.5 })).toThrow();                 // non-integer
  });
});
