import { describe, it, expect } from 'vitest';
import { DcaBacktest } from './DcaBacktest.js';
import type { PricePoint } from './DcaBacktest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MS_PER_DAY = 86_400_000;
const WEEK = 7 * MS_PER_DAY;

/** Build a price series starting at `startMs`, one entry per `stepMs`. */
function makePrices(closes: number[], startMs = 0, stepMs: number = MS_PER_DAY): PricePoint[] {
  return closes.map((close, i) => ({ date: startMs + i * stepMs, close }));
}

/** Linear ramp from `lo` to `hi` (inclusive) over `n` points. */
function ramp(lo: number, hi: number, n: number, startMs = 0, stepMs: number = WEEK): PricePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    date: startMs + i * stepMs,
    close: lo + (hi - lo) * (i / Math.max(n - 1, 1)),
  }));
}

// ---------------------------------------------------------------------------
// 1. Degenerate: empty prices → zero result, no throw
// ---------------------------------------------------------------------------
describe('DcaBacktest – degenerate inputs', () => {
  it('returns a zero result for empty prices without throwing', () => {
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'monthly', amount: 100 });
    const r = bt.run([]);
    expect(r.totalInvested).toBe(0);
    expect(r.shares).toBe(0);
    expect(r.finalValue).toBe(0);
    expect(r.uninvestedCash).toBe(0);
    expect(r.avgCost).toBe(0);
    expect(r.moneyWeightedReturn).toBe(0);
    expect(r.timeWeightedReturn).toBe(0);
    expect(r.maxDrawdown).toBe(0);
    expect(r.periods).toBe(0);
    expect(r.contributions).toHaveLength(0);
  });

  it('handles a single price point without throwing', () => {
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'weekly', amount: 100, costPct: 0 });
    const r = bt.run([{ date: 0, close: 100 }]);
    expect(r.shares).toBeCloseTo(1, 5);
    expect(r.finalValue).toBeCloseTo(100, 5);
    expect(r.moneyWeightedReturn).toBe(0); // T=0, no time elapsed
  });
});

// ---------------------------------------------------------------------------
// 2. Vanilla – flat price (monthly cadence, 13 months of daily prices)
//    avgCost ≈ 100, finalValue ≈ totalInvested*(1-cost), IRR near zero
// ---------------------------------------------------------------------------
describe('DcaBacktest – vanilla flat price', () => {
  // 13 months ≈ 396 days of daily flat prices at close=100; monthly cadence
  // fires on the first day of each new UTC month → 13 contributions
  const START = Date.UTC(2023, 0, 1); // Jan 1 2023
  const days = 396;
  const prices = makePrices(Array(days).fill(100), START, MS_PER_DAY);
  const costPct = 0.001;
  const amount = 1_000;

  it('avgCost ≈ 100 on flat series', () => {
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'monthly', amount, costPct });
    const r = bt.run(prices);
    // cost doesn't change the PRICE paid, it reduces shares received
    expect(r.avgCost).toBeCloseTo(100 / (1 - costPct), 3);
    expect(r.contributions.length).toBeGreaterThanOrEqual(12);
  });

  it('finalValue ≈ totalInvested*(1-costPct) on flat series', () => {
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'monthly', amount, costPct });
    const r = bt.run(prices);
    expect(r.finalValue).toBeCloseTo(r.totalInvested * (1 - costPct), 3);
  });

  it('moneyWeightedReturn is near zero (small negative due to cost only)', () => {
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'monthly', amount, costPct });
    const r = bt.run(prices);
    expect(r.moneyWeightedReturn).toBeGreaterThan(-0.05);
    expect(r.moneyWeightedReturn).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------
// 3. Vanilla – steadily rising series (weekly, 8 weeks)
//    finalValue > totalInvested, IRR > 0, avgCost < finalPrice
// ---------------------------------------------------------------------------
describe('DcaBacktest – vanilla rising series', () => {
  // 8 weekly prices 100 → 200 (linear ramp, weekly cadence fires all 8)
  const prices = ramp(100, 200, 8);
  const bt = new DcaBacktest({ type: 'vanilla', cadence: 'weekly', amount: 1_000, costPct: 0 });

  it('finalValue > totalInvested', () => {
    const r = bt.run(prices);
    expect(r.finalValue).toBeGreaterThan(r.totalInvested);
  });

  it('moneyWeightedReturn > 0', () => {
    const r = bt.run(prices);
    expect(r.moneyWeightedReturn).toBeGreaterThan(0);
  });

  it('avgCost < finalPrice', () => {
    const r = bt.run(prices);
    const finalPrice = prices[prices.length - 1]?.close ?? 0;
    expect(r.avgCost).toBeLessThan(finalPrice);
  });
});

// ---------------------------------------------------------------------------
// 4. IRR precision: single lump-sum that exactly doubles in one year → IRR ≈ 1.0
// ---------------------------------------------------------------------------
describe('DcaBacktest – IRR precision', () => {
  it('single contribution that doubles over exactly 1 year → IRR ≈ 1.0 (100%)', () => {
    // costPct=0 so IRR = finalValue/invested - 1 exactly
    // lumpSum: invest all on day 0 at price 100, check at day 365 at price 200
    // Only 2 price points; with 'biweekly' cadence, count = 2 (day 0 and day 365 are 365 days apart)
    // → lumpSumTotal = amount * count; IRR = closeEnd/closeStart - 1 = 1.0 regardless of count
    const prices: PricePoint[] = [
      { date: 0, close: 100 },
      { date: 365 * MS_PER_DAY, close: 200 },
    ];
    const bt = new DcaBacktest({ type: 'lumpSum', cadence: 'biweekly', amount: 1_000, costPct: 0 });
    const r = bt.run(prices);
    // invested all at t=0, worth 2× at t=1yr → IRR = 100%
    expect(r.moneyWeightedReturn).toBeCloseTo(1.0, 2);
  });
});

// ---------------------------------------------------------------------------
// 5. maxDrawdown: mid-window crash → exactly -0.5 (hand-traced)
// ---------------------------------------------------------------------------
describe('DcaBacktest – maxDrawdown', () => {
  it('computes -0.5 for a 50% mid-window crash (hand-traced)', () => {
    // Day 0: contribution → 1 share @ 100 → portfolio = 100, peak = 100
    // Day 1: no contribution  → portfolio = 1 * 50 = 50, drawdown = (50-100)/100 = -0.5
    // Day 7: contribution     → buy 100/200 = 0.5 more shares → portfolio = 1.5*200 = 300, new peak
    const prices: PricePoint[] = [
      { date: 0, close: 100 },
      { date: MS_PER_DAY, close: 50 },
      { date: 7 * MS_PER_DAY, close: 200 },
    ];
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'weekly', amount: 100, costPct: 0 });
    const r = bt.run(prices);
    expect(r.maxDrawdown).toBeCloseTo(-0.5, 5);
  });

  it('maxDrawdown is 0 on a monotonically rising series (no drawdown)', () => {
    const prices = ramp(100, 200, 8); // always rising
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'weekly', amount: 100, costPct: 0 });
    const r = bt.run(prices);
    expect(r.maxDrawdown).toBeGreaterThanOrEqual(-1e-9); // essentially 0
  });
});

// ---------------------------------------------------------------------------
// 6. lumpSum vs vanilla on rising series → lumpSum finalValue > vanilla finalValue
// ---------------------------------------------------------------------------
describe('DcaBacktest – lumpSum vs vanilla comparison', () => {
  const risingPrices = ramp(100, 200, 8); // 8 weekly prices 100→200
  const amount = 1_000;

  it('lumpSum wins in a rising market (more finalValue)', () => {
    const vanilla = new DcaBacktest({ type: 'vanilla', cadence: 'weekly', amount, costPct: 0 });
    const lump   = new DcaBacktest({ type: 'lumpSum', cadence: 'weekly', amount, costPct: 0 });
    const vr = vanilla.run(risingPrices);
    const lr = lump.run(risingPrices);
    // Both invest the same total (amount * 8), but lump-sum buys all at the cheapest price
    expect(lr.totalInvested).toBeCloseTo(vr.totalInvested, 2);
    expect(lr.finalValue).toBeGreaterThan(vr.finalValue);
  });

  it('DCA avgCost < lumpSum purchase price on a V-shaped dip-then-recover series', () => {
    // V-shape: 9 weekly prices 100→50 (dip) →100 (recovery)
    // LumpSum buys at 100 (day 0); DCA buys at 100, 93.75, 87.5, 81.25, 75, 81.25, 87.5, 93.75, 100
    const vShape: PricePoint[] = [
      { date: 0 * WEEK, close: 100 },
      { date: 1 * WEEK, close: 87.5 },
      { date: 2 * WEEK, close: 75 },
      { date: 3 * WEEK, close: 62.5 },
      { date: 4 * WEEK, close: 50 },
      { date: 5 * WEEK, close: 62.5 },
      { date: 6 * WEEK, close: 75 },
      { date: 7 * WEEK, close: 87.5 },
      { date: 8 * WEEK, close: 100 },
    ];
    const vanilla = new DcaBacktest({ type: 'vanilla', cadence: 'weekly', amount, costPct: 0 });
    const lump   = new DcaBacktest({ type: 'lumpSum', cadence: 'weekly', amount, costPct: 0 });
    const vr = vanilla.run(vShape);
    const lr = lump.run(vShape);
    // lumpSum's "avgCost" = 100 (bought all at 100); DCA averaged through the dip → cheaper
    const lumpPrice = vShape[0]?.close ?? 100;
    expect(vr.avgCost).toBeLessThan(lumpPrice);
    // lumpSum finalValue ≈ totalInvested (price recovered to 100)
    expect(lr.finalValue).toBeCloseTo(lr.totalInvested, 0);
    // DCA finalValue > totalInvested (avgCost < 100, price recovered to 100)
    expect(vr.finalValue).toBeGreaterThan(vr.totalInvested);
  });
});

// ---------------------------------------------------------------------------
// 7. dipBuying: extra shares purchased when price crosses dip threshold
// ---------------------------------------------------------------------------
describe('DcaBacktest – dipBuying', () => {
  it('buys dipExtra shares on a drawdown day vs vanilla', () => {
    // Day 0 @ 100: dipPeak=0 (first fire), normal contribution
    // Day 7 @ 110: dipPeak=100 before check, 110 <= 100*0.9=90? NO. Normal.
    //              After check, dipPeak→110
    // Day 14 @ 98: 98 <= 110*(1-0.10)=99? YES. Extra contribution.
    const prices: PricePoint[] = [
      { date: 0,           close: 100 },
      { date: 7 * MS_PER_DAY,  close: 110 },
      { date: 14 * MS_PER_DAY, close: 98  },
    ];
    const basePlan = { cadence: 'weekly' as const, amount: 100, costPct: 0 };
    const vanilla = new DcaBacktest({ type: 'vanilla',   ...basePlan });
    const dip     = new DcaBacktest({
      type: 'dipBuying', ...basePlan,
      dipExtra: 200, dipDrawdownPct: 0.10,
    });

    const vr = vanilla.run(prices);
    const dr = dip.run(prices);

    // On the dip day (day 14 @ 98), dip strategy buys 300/98 shares vs vanilla 100/98
    const vanillaLastShares = vr.contributions[2]?.shares ?? 0;
    const dipLastShares     = dr.contributions[2]?.shares ?? 0;
    expect(dipLastShares).toBeGreaterThan(vanillaLastShares);

    // dipBuying total invested > vanilla total invested (extra amount on dip day)
    expect(dr.totalInvested).toBeGreaterThan(vr.totalInvested);
  });

  it('dipBuying does NOT trigger extra when price is not in drawdown', () => {
    // Monotonically rising → no dip → same totalInvested as vanilla
    const prices = ramp(100, 200, 4, 0, WEEK);
    const basePlan = { cadence: 'weekly' as const, amount: 100, costPct: 0 };
    const vanilla = new DcaBacktest({ type: 'vanilla',   ...basePlan });
    const dip     = new DcaBacktest({
      type: 'dipBuying', ...basePlan,
      dipExtra: 500, dipDrawdownPct: 0.05,
    });
    const vr = vanilla.run(prices);
    const dr = dip.run(prices);
    expect(dr.totalInvested).toBeCloseTo(vr.totalInvested, 5);
  });
});

// ---------------------------------------------------------------------------
// 8. valueAveraging: invests less on rising, more on falling
// ---------------------------------------------------------------------------
describe('DcaBacktest – valueAveraging', () => {
  it('totalInvested < vanilla on a rising series (market does work, fewer buys needed)', () => {
    // Rising: each period the portfolio is ahead of target → buy less
    const prices = ramp(100, 150, 6, 0, WEEK);
    const plan = { cadence: 'weekly' as const, amount: 100, costPct: 0 };
    const vanilla = new DcaBacktest({ type: 'vanilla',        ...plan });
    const va      = new DcaBacktest({ type: 'valueAveraging', ...plan });
    const vr = vanilla.run(prices);
    const var_ = va.run(prices);
    expect(var_.totalInvested).toBeLessThan(vr.totalInvested);
  });

  it('totalInvested > vanilla on a falling series (market falls → must buy more to hit target)', () => {
    // Falling: each period the portfolio is behind target → buy more
    const prices = ramp(100, 50, 6, 0, WEEK);
    const plan = { cadence: 'weekly' as const, amount: 100, costPct: 0 };
    const vanilla = new DcaBacktest({ type: 'vanilla',        ...plan });
    const va      = new DcaBacktest({ type: 'valueAveraging', ...plan });
    const vr = vanilla.run(prices);
    const var_ = va.run(prices);
    expect(var_.totalInvested).toBeGreaterThan(vr.totalInvested);
  });

  it('valueAveraging is buy-only (never sells even when ahead of target)', () => {
    // Big single jump → currentValue >> target → investAmount clamped to 0 (no sell)
    const prices: PricePoint[] = [
      { date: 0,       close: 100 },  // period 1: target=100, buy 100/100=1 share
      { date: 1*WEEK,  close: 1000 }, // period 2: target=200, currentValue=1000 >> 200 → 0
    ];
    const va = new DcaBacktest({ type: 'valueAveraging', cadence: 'weekly', amount: 100, costPct: 0 });
    const r = va.run(prices);
    expect(r.contributions).toHaveLength(1); // only period 1 invested
    expect(r.shares).toBeCloseTo(1, 5);      // still holds the 1 share (no sell)
  });
});

// ---------------------------------------------------------------------------
// 9. trendFiltered: skips below SMA, accumulates cash; resumes above SMA
// ---------------------------------------------------------------------------
describe('DcaBacktest – trendFiltered', () => {
  it('skips contributions below SMA (uninvestedCash grows) and invests above SMA', () => {
    // 8 weekly prices, trendWindow=3
    // i=0: warmup (0 prior), skip           → cash += 100
    // i=1: warmup (1 prior), skip           → cash += 100
    // i=2: warmup (2 prior < 3), skip       → cash += 100
    // i=3: 3 prior [80,75,70] SMA=75, close=65<75, skip → cash += 100
    // i=4: 3 prior [75,70,65] SMA=70, close=60<70, skip → cash += 100
    // i=5: 3 prior [70,65,60] SMA=65, close=90>65, INVEST
    // i=6: 3 prior [65,60,90] SMA=71.7, close=95>71.7, INVEST
    // i=7: 3 prior [60,90,95] SMA=81.7, close=100>81.7, INVEST
    const prices: PricePoint[] = [
      { date: 0 * WEEK, close: 80  },
      { date: 1 * WEEK, close: 75  },
      { date: 2 * WEEK, close: 70  },
      { date: 3 * WEEK, close: 65  },
      { date: 4 * WEEK, close: 60  },
      { date: 5 * WEEK, close: 90  },
      { date: 6 * WEEK, close: 95  },
      { date: 7 * WEEK, close: 100 },
    ];
    const bt = new DcaBacktest({
      type: 'trendFiltered', cadence: 'weekly',
      amount: 100, costPct: 0, trendWindow: 3,
    });
    const r = bt.run(prices);

    // 5 skips × 100 = 500 uninvested cash
    expect(r.uninvestedCash).toBeCloseTo(500, 5);

    // 3 investments: at closes 90, 95, 100
    expect(r.contributions).toHaveLength(3);
    expect(r.shares).toBeCloseTo(100 / 90 + 100 / 95 + 100 / 100, 5);

    // finalValue = shares * lastClose + uninvestedCash
    const expectedShares = 100 / 90 + 100 / 95 + 100 / 100;
    const expectedFinal  = expectedShares * 100 + 500;
    expect(r.finalValue).toBeCloseTo(expectedFinal, 3);
  });

  it('finalValue includes uninvestedCash in the total', () => {
    const prices: PricePoint[] = [
      { date: 0 * WEEK, close: 80 },
      { date: 1 * WEEK, close: 75 },
      { date: 2 * WEEK, close: 70 },
      { date: 3 * WEEK, close: 65 },
    ];
    // All 4 periods: 3 warmup + 1 below SMA → all skipped
    // SMA at i=3: [80,75,70]=75, close=65<75 → skip
    const bt = new DcaBacktest({
      type: 'trendFiltered', cadence: 'weekly',
      amount: 100, costPct: 0, trendWindow: 3,
    });
    const r = bt.run(prices);
    expect(r.uninvestedCash).toBeCloseTo(400, 5);
    expect(r.shares).toBe(0);
    expect(r.finalValue).toBeCloseTo(400, 5); // all cash
  });
});

// ---------------------------------------------------------------------------
// 10. timeWeightedReturn: buy&hold annualized
// ---------------------------------------------------------------------------
describe('DcaBacktest – timeWeightedReturn', () => {
  it('TWR = 0 for flat series', () => {
    const prices = makePrices(Array(365).fill(100), 0, MS_PER_DAY);
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'monthly', amount: 100 });
    const r = bt.run(prices);
    expect(r.timeWeightedReturn).toBeCloseTo(0, 5);
  });

  it('TWR = 1.0 when price doubles over exactly 1 year', () => {
    const prices: PricePoint[] = [
      { date: 0, close: 100 },
      { date: 365 * MS_PER_DAY, close: 200 },
    ];
    const bt = new DcaBacktest({ type: 'vanilla', cadence: 'biweekly', amount: 100 });
    const r = bt.run(prices);
    expect(r.timeWeightedReturn).toBeCloseTo(1.0, 5);
  });
});
