import { describe, it, expect } from 'vitest';
import { signalToIntent } from './signal.js';

const opts = { currency: 'KRW' as const, price: 100, orderNotional: 1000 };

describe('signalToIntent', () => {
  it('BULLISH while flat -> BUY sized from notional (KR integer)', () => {
    expect(signalToIntent('BULLISH', 0, opts)).toMatchObject({ side: 'BUY', quantity: 10, orderType: 'MARKET' });
  });
  it('BEARISH while long -> SELL the whole position', () => {
    expect(signalToIntent('BEARISH', 7, opts)).toMatchObject({ side: 'SELL', quantity: 7 });
  });
  it('holds otherwise (already long & bullish, flat & bearish, neutral)', () => {
    expect(signalToIntent('BULLISH', 5, opts)).toBeNull();
    expect(signalToIntent('BEARISH', 0, opts)).toBeNull();
    expect(signalToIntent('NEUTRAL', 0, opts)).toBeNull();
    expect(signalToIntent('NEUTRAL', 5, opts)).toBeNull();
  });
  it('returns null when notional buys < 1 share', () => {
    expect(signalToIntent('BULLISH', 0, { ...opts, orderNotional: 50 })).toBeNull();
  });
});
