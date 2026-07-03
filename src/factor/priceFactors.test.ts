import { describe, it, expect } from 'vitest';
import { momentum12_1, realizedVol, maxDrawdown } from './priceFactors.js';

describe('momentum12_1', () => {
  it('computes 12-1 momentum by hand with small skip/lookback', () => {
    // prices=[100,100,110,120,130], n=5, skip=1, lookback=3
    // prices[n-1-skip] = prices[3] = 120
    // prices[n-1-lookback] = prices[1] = 100
    // result = 120/100 - 1 = 0.2
    const prices = [100, 100, 110, 120, 130];
    expect(momentum12_1(prices, 1, 3)).toBeCloseTo(0.2);
  });

  it('returns null when series length is not greater than longLookback', () => {
    // n=3 is NOT > longLookback=3
    expect(momentum12_1([100, 110, 120], 1, 3)).toBeNull();
    // n=2 also too short
    expect(momentum12_1([100, 110], 1, 3)).toBeNull();
  });

  it('returns null when the lookback denominator price is zero', () => {
    // prices[n-1-lookback] = prices[1] = 0 → guard triggers
    const prices = [100, 0, 110, 120, 130];
    expect(momentum12_1(prices, 1, 3)).toBeNull();
  });

  it('returns null when the lookback denominator price is negative', () => {
    const prices = [100, -10, 110, 120, 130];
    expect(momentum12_1(prices, 1, 3)).toBeNull();
  });
});

describe('realizedVol', () => {
  it('returns 0 for a flat price series (all returns = 0)', () => {
    // n=5 > window=3; prices all 100 → returns all 0 → population std = 0
    const prices = [100, 100, 100, 100, 100];
    expect(realizedVol(prices, 3)).toBe(0);
  });

  it('returns > 0 for a varied price series', () => {
    const prices = [100, 110, 90, 105, 95, 115];
    const vol = realizedVol(prices, 3);
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(0);
  });

  it('returns null when series length is not greater than window', () => {
    // n=3 is NOT > window=3
    expect(realizedVol([100, 110, 120], 3)).toBeNull();
    expect(realizedVol([100, 110], 3)).toBeNull();
  });
});

describe('maxDrawdown (priceFactors)', () => {
  it('returns -0.25 for [100,120,90,110] covering all prices in window', () => {
    // Running peak:
    // 100 → peak=100, dd=0
    // 120 → peak=120, dd=0
    // 90  → dd=(90-120)/120 = -0.25, mdd=-0.25
    // 110 → dd=(110-120)/120≈-0.083, mdd stays -0.25
    expect(maxDrawdown([100, 120, 90, 110], 252)).toBeCloseTo(-0.25);
  });

  it('returns 0 for a monotonically increasing series (no drawdown)', () => {
    expect(maxDrawdown([100, 110, 120, 130], 252)).toBe(0);
  });

  it('returns null when fewer than 2 prices are in the window', () => {
    expect(maxDrawdown([100], 252)).toBeNull();
    expect(maxDrawdown([], 252)).toBeNull();
  });

  it('respects the window parameter and only looks at the last window prices', () => {
    // prices=[50, 100, 120, 90, 110], window=4
    // last 4 prices=[100,120,90,110] → maxDrawdown = -0.25 (same as above)
    // The leading 50 is excluded, so it doesn't affect the peak
    expect(maxDrawdown([50, 100, 120, 90, 110], 4)).toBeCloseTo(-0.25);
  });
});
