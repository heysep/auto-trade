// TDD tests for FactorBacktest (AQR §5.1 long-only top-N rebalancing backtest).
//
// Design:
//   - Non-degenerate suites generally use ≥3 symbols for observable factor spread.
//     After M1 (winsorize fix), n=2 no longer collapses lo=hi, so z-scores are
//     meaningful for 2 symbols too.  The minimum-2-scorable guard (M2) is the
//     reason rebalance dates need scored.length ≥ 2, not a winsorize concern.
//   - CONSTANT-PERCENTAGE growth prices (geometric) → daily returns are identical,
//     realizedVol = 0 for each symbol independently. This matches the FactorModel test
//     design and avoids vol noise overwhelming the ranking.
//   - SMALL periods so only 4+ bars are needed per symbol (vs 252+ in production).
//
// Union axis [d0..d9], candidates at k=0,2,4,6,8 (rebalanceEvery=2):
//   k=0 (d0): 1 price → not scorable (needs n > momLong=3).
//   k=2 (d2): 3 prices → not scorable.
//   k=4 (d4): 5 prices → FIRST kept rebalance.
//   k=6 (d6): 7 prices → second.
//   k=8 (d8): 9 prices → LAST (no forward window from it).
//
// equityCurve: [{d4,cap},{d6,nav1},{d8,nav2}]  rebalanceCount: 3

import { describe, it, expect } from 'vitest';
import { FactorModel, DEFAULT_WEIGHTS } from './FactorModel.js';
import type { FactorPeriods } from './FactorModel.js';
import { FactorBacktest } from './FactorBacktest.js';
import type { BacktestSymbol, FactorBacktestConfig, PricePoint } from './FactorBacktest.js';

// ── Shared constants ──────────────────────────────────────────────────────────

/**
 * SMALL periods: only 4+ bars needed.
 * momSkip=1, momLong=3, momMid=2, volWindow=3, mddWindow=3.
 */
const SMALL: FactorPeriods = {
  momSkip: 1,
  momLong: 3,
  momMid: 2,
  volWindow: 3,
  mddWindow: 3,
};

/** 10 epoch-ms timestamps one day apart. */
const D: number[] = Array.from({ length: 10 }, (_, i) => (i + 1) * 86_400_000);

const CFG: FactorBacktestConfig = {
  topN: 1,
  rebalanceEvery: 2,
  startCapital: 10_000,
};

// ── Symbol factories ──────────────────────────────────────────────────────────
//
// Constant-percentage growth: close_i = 100 * (1 + dailyPct)^i.
// Produces identical simple returns at every step → realizedVol = 0.
// This is the same technique used in FactorModel.test.ts.

function buildSeries(
  dates: number[],
  dailyPct: number,
  symbol: string,
  sector: string,
): BacktestSymbol {
  return {
    symbol,
    sector,
    series: dates.map((date, i) => ({
      date,
      close: 100 * Math.pow(1 + dailyPct, i),
    })),
  };
}

/** RISING: +5 %/day. Best momentum, vol=0, mdd=0. */
const symA = buildSeries(D, 0.05, 'A', 'Tech');
/** FALLING: −5 %/day. Worst momentum, vol=0, large mdd. */
const symB = buildSeries(D, -0.05, 'B', 'Tech');
/** MILDLY-RISING: +1 %/day. Middle momentum, vol=0, mdd=0. */
const symC = buildSeries(D, 0.01, 'C', 'Tech');

// ── Suite 1: Basic rising-symbol backtest ─────────────────────────────────────
//
// Three-symbol universe ensures winsorize works (n≥3 → lo < hi → valid z-scores).
// B (FALLING) has the worst momentum at EVERY rebalance date; it is never held.
// Either A or C is held — both rise, so nav always increases and finalNav > startCapital.

describe('FactorBacktest — rising symbols are picked and nav increases', () => {
  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  const backtest = new FactorBacktest(model, CFG);
  const result = backtest.run([symA, symB, symC]);

  it('finalNav is greater than startCapital', () => {
    expect(result.metrics.finalNav).toBeGreaterThan(CFG.startCapital);
  });

  it('totalReturn is positive', () => {
    expect(result.metrics.totalReturn).toBeGreaterThan(0);
  });

  it('falling symbol B is never picked (always worst momentum)', () => {
    for (const rb of result.rebalances) {
      expect(rb.holdings).not.toContain('B');
    }
  });

  it('holdings length never exceeds topN', () => {
    for (const rb of result.rebalances) {
      expect(rb.holdings.length).toBeLessThanOrEqual(CFG.topN);
    }
  });

  it('equityCurve starts at startCapital', () => {
    const first = result.equityCurve[0];
    expect(first).toBeDefined();
    expect(first!.nav).toBe(CFG.startCapital);
  });

  it('equityCurve nav is monotonically increasing (A or C always rises)', () => {
    const navs = result.equityCurve.map((p) => p.nav);
    for (let i = 1; i < navs.length; i++) {
      expect(navs[i]!).toBeGreaterThan(navs[i - 1]!);
    }
  });

  it('maxDrawdown is 0 when nav never falls', () => {
    expect(result.metrics.maxDrawdown).toBe(0);
  });
});

// ── Suite 2: Rebalance count and equity curve structure ───────────────────────

describe('FactorBacktest — rebalance count and equity curve structure', () => {
  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  const backtest = new FactorBacktest(model, CFG);
  const result = backtest.run([symA, symB, symC]);

  it('rebalanceCount equals 3 (candidates at axis indices 4, 6, 8)', () => {
    // 10 dates, rebalanceEvery=2 → candidates k=0,2,4,6,8.
    // k=0: 1 price → skip. k=2: 3 prices → skip. k=4: 5 prices → kept (first).
    // k=6: 7 prices → kept. k=8: 9 prices → kept (last, no forward window).
    expect(result.metrics.rebalanceCount).toBe(3);
  });

  it('rebalances.length matches rebalanceCount', () => {
    expect(result.rebalances.length).toBe(result.metrics.rebalanceCount);
  });

  it('equityCurve.length matches rebalanceCount', () => {
    expect(result.equityCurve.length).toBe(result.metrics.rebalanceCount);
  });

  it('equityCurve dates are strictly ascending', () => {
    const dates = result.equityCurve.map((p) => p.date);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]!).toBeGreaterThan(dates[i - 1]!);
    }
  });

  it('rebalance dates are strictly ascending', () => {
    const dates = result.rebalances.map((r) => r.date);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]!).toBeGreaterThan(dates[i - 1]!);
    }
  });

  it('equityCurve dates match rebalance dates', () => {
    for (let i = 0; i < result.rebalances.length; i++) {
      expect(result.equityCurve[i]!.date).toBe(result.rebalances[i]!.date);
    }
  });
});

// ── Suite 3: Look-ahead safety ────────────────────────────────────────────────
//
// Universe: CRASH (rises strongly before d4, then collapses at d5+),
//           GOOD (+5%/day always), STABLE (+1%/day always).
//
// DESIGN: topN=2 so CRASH (rank 2 at d4) is held alongside GOOD (rank 1).
//
// At d4 with past-only prices: CRASH has good momentum and ranks 2 of 3.
// If all 10 prices (including the crash) were used to score at d4, CRASH
// would have terrible momentum (−80%) and rank last (3 of 3).
//
// LOOK-AHEAD PROOF:
//   • Backtest at d4: CRASH is IN holdings (rank ≤ 2)
//   • Manual score at d4 with ALL prices: CRASH NOT in top-2
//   → Holdings differ depending on whether future prices are included.
//     The backtest uses past-only data → CRASH is correctly held at d4.
//
// After the crash is visible (d6+): CRASH drops to rank 3 → excluded from
// holdings. Only GOOD and STABLE remain in top-2.

describe('FactorBacktest — look-ahead safety: future crash does not affect past scoring', () => {
  const crashSeries: PricePoint[] = [
    { date: D[0]!, close: 100 * Math.pow(1.08, 0) },
    { date: D[1]!, close: 100 * Math.pow(1.08, 1) },
    { date: D[2]!, close: 100 * Math.pow(1.08, 2) },
    { date: D[3]!, close: 100 * Math.pow(1.08, 3) },
    { date: D[4]!, close: 100 * Math.pow(1.08, 4) }, // ← first rebalance; peak
    { date: D[5]!, close: 20 },                        // crash starts AFTER d4
    { date: D[6]!, close: 10 },
    { date: D[7]!, close: 5 },
    { date: D[8]!, close: 2 },
    { date: D[9]!, close: 1 },
  ];

  const symCrash: BacktestSymbol = { symbol: 'CRASH', sector: 'Tech', series: crashSeries };
  const symGood = buildSeries(D, 0.05, 'GOOD', 'Tech');
  const symStable = buildSeries(D, 0.01, 'STABLE', 'Tech');

  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  // topN=2: CRASH (rank 2 at d4 with past data) is included in the portfolio.
  const laBacktest = new FactorBacktest(model, { ...CFG, topN: 2 });
  const result = laBacktest.run([symCrash, symGood, symStable]);

  it('at least one rebalance occurs', () => {
    expect(result.rebalances.length).toBeGreaterThanOrEqual(1);
  });

  it('CRASH is held at the first rebalance date (look-ahead safe)', () => {
    // With past-only prices (d0..d4), CRASH has rising momentum → rank 2 → held.
    // At d4 with past data: CRASH composite > STABLE composite (STABLE has worst momentum).
    const firstRb = result.rebalances[0];
    expect(firstRb).toBeDefined();
    expect(firstRb!.holdings).toContain('CRASH');
  });

  it('scoring with all future data would EXCLUDE CRASH at d4 (look-ahead counterfactual)', () => {
    // If d5+ prices were used, CRASH's crash makes its momentum terrible → rank 3.
    // This proves WHY the look-ahead test matters: future data changes the result.
    const allDataEntries = [symCrash, symGood, symStable].map((sym) => ({
      symbol: sym.symbol,
      sector: sym.sector,
      prices: sym.series.map((pt) => pt.close), // ALL prices — future included
    }));
    const fullScored = model.score(allDataEntries);
    const top2 = fullScored.filter((s) => s.rank <= 2).map((s) => s.symbol);
    // With all data visible, CRASH ranks last → not in top-2
    expect(top2).not.toContain('CRASH');
  });

  it('CRASH drops out of holdings at later rebalances (crash is visible)', () => {
    // At d6: CRASH prices include the collapse → worst momentum → rank 3 → excluded.
    if (result.rebalances.length > 1) {
      const laterHoldings = result.rebalances.slice(1).flatMap((r) => r.holdings);
      expect(laterHoldings).not.toContain('CRASH');
      expect(laterHoldings).toContain('GOOD'); // GOOD consistently ranks 1 after crash
    }
  });

  it('holding CRASH through the d4→d6 window causes a drawdown', () => {
    // CRASH is held at d4 (rank 2). Between d4 and d6 it crashes from ~136 to 10.
    // Equal-weight portfolio with GOOD (rises) and CRASH (crashes) → net loss → mdd<0.
    if (result.equityCurve.length >= 2) {
      expect(result.metrics.maxDrawdown).toBeLessThan(0);
    }
  });
});

// ── Suite 4: Degenerate — universe too short to ever score ────────────────────

describe('FactorBacktest — degenerate: universe too short to ever produce holdings', () => {
  // 3 dates → max 3 prices; SMALL needs n>3 for vol/momentum → 0 kept rebalances.
  const shortSeries: PricePoint[] = [
    { date: D[0]!, close: 100 },
    { date: D[1]!, close: 101 },
    { date: D[2]!, close: 102 },
  ];
  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  const backtest = new FactorBacktest(model, CFG);
  const result = backtest.run([
    { symbol: 'SA', sector: 'Tech', series: shortSeries },
    { symbol: 'SB', sector: 'Tech', series: shortSeries },
    { symbol: 'SC', sector: 'Tech', series: shortSeries },
  ]);

  it('rebalances is empty', () => {
    expect(result.rebalances).toHaveLength(0);
  });

  it('equityCurve is empty', () => {
    expect(result.equityCurve).toHaveLength(0);
  });

  it('finalNav equals startCapital', () => {
    expect(result.metrics.finalNav).toBe(CFG.startCapital);
  });

  it('totalReturn is 0', () => {
    expect(result.metrics.totalReturn).toBe(0);
  });

  it('rebalanceCount is 0', () => {
    expect(result.metrics.rebalanceCount).toBe(0);
  });
});

// ── Suite 5: Empty universe ───────────────────────────────────────────────────

describe('FactorBacktest — degenerate: empty universe', () => {
  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  const backtest = new FactorBacktest(model, CFG);
  const result = backtest.run([]);

  it('returns empty result with startCapital', () => {
    expect(result.rebalances).toHaveLength(0);
    expect(result.equityCurve).toHaveLength(0);
    expect(result.metrics.finalNav).toBe(CFG.startCapital);
    expect(result.metrics.totalReturn).toBe(0);
    expect(result.metrics.rebalanceCount).toBe(0);
    expect(result.metrics.maxDrawdown).toBe(0);
  });
});

// ── Suite 6: topN=2 — multiple holdings per rebalance ─────────────────────────

describe('FactorBacktest — topN=2: two holdings per rebalance', () => {
  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  const cfg2: FactorBacktestConfig = { ...CFG, topN: 2 };
  const backtest = new FactorBacktest(model, cfg2);
  // 3 symbols, topN=2 → always hold the top 2.
  const result = backtest.run([symA, symB, symC]);

  it('rebalances always have exactly 2 holdings', () => {
    for (const rb of result.rebalances) {
      expect(rb.holdings.length).toBe(2);
    }
  });

  it('falling symbol B is never in top-2 (always worst momentum)', () => {
    for (const rb of result.rebalances) {
      expect(rb.holdings).not.toContain('B');
    }
  });
});

// ── Suite 7M2: Min-2-scorable guard (M2 fix) ─────────────────────────────────
//
// Before M2: `if (holdings.length >= 1)` kept any date where ≥1 degenerate holding
// was produced, even when only 1 symbol had enough history.  Such single-symbol
// rebalances are concentrated (model.score returns composite=0 for all symbols when
// scorable.length < 2) and should be skipped.
//
// After M2: guard changed to `if (scored.length >= 2)`.
//
// Universe design:
//   EARLY: full series D[0..9] (10 prices).  Scorable from d4 onwards (needs n≥5).
//   LATE:  series starts at D[4]  → at d4: 1 price, at d6: 3 prices, at d8: 5 prices.
//
// Candidate dates (rebalanceEvery=2, SMALL periods, n≥5 required):
//   d0 (D[0]): EARLY 1 price → 0 scorable → skip (both old and new)
//   d2 (D[2]): EARLY 3 prices → 0 scorable → skip (both old and new)
//   d4 (D[4]): EARLY 5 prices (scorable), LATE 1 price (not scorable) → 1 scorable
//              OLD (holdings.length≥1): KEEP (degenerate composite=0 holding)
//              NEW (scored.length≥2):   SKIP
//   d6 (D[6]): EARLY 7 prices (scorable), LATE 3 prices (not scorable) → 1 scorable
//              OLD: KEEP. NEW: SKIP.
//   d8 (D[8]): EARLY 9 prices (scorable), LATE 5 prices (scorable) → 2 scorable
//              BOTH OLD and NEW: KEEP.
//
// Expected with M2 fix: rebalanceCount=1 (only d8 survives the guard).

describe('FactorBacktest — M2: dates with only 1 scorable symbol are skipped', () => {
  // EARLY: rising +5%/day from D[0] (10 prices total)
  const earlySymbol: BacktestSymbol = {
    symbol: 'EARLY',
    sector: 'Tech',
    series: D.map((date, i) => ({ date, close: 100 * Math.pow(1.05, i) })),
  };

  // LATE: flat +3%/day but only has prices from D[4] onward (6 prices)
  const lateSymbol: BacktestSymbol = {
    symbol: 'LATE',
    sector: 'Tech',
    series: D.slice(4).map((date, i) => ({ date, close: 100 * Math.pow(1.03, i) })),
  };

  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  const backtest = new FactorBacktest(model, CFG); // topN=1, rebalanceEvery=2
  const result = backtest.run([earlySymbol, lateSymbol]);

  it('rebalanceCount is 1 (only d8 has ≥2 scorable symbols)', () => {
    // d4 and d6 each have only 1 scorable symbol → skipped by M2 guard.
    // d8 has EARLY (9 prices) and LATE (5 prices) → both scorable → kept.
    expect(result.metrics.rebalanceCount).toBe(1);
  });

  it('the single kept rebalance date is d8 (the date ≥2 symbols become scorable)', () => {
    expect(result.rebalances).toHaveLength(1);
    expect(result.rebalances[0]!.date).toBe(D[8]);
  });

  it('holdings at d8 contain exactly topN=1 symbol chosen from the 2 scorable ones', () => {
    expect(result.rebalances[0]!.holdings).toHaveLength(1);
    const held = result.rebalances[0]!.holdings[0];
    expect(['EARLY', 'LATE']).toContain(held);
  });

  it('equityCurve has exactly 1 point (the d8 rebalance)', () => {
    // Only one rebalance → one equity-curve point; no forward step originates from it.
    expect(result.equityCurve).toHaveLength(1);
    expect(result.equityCurve[0]!.date).toBe(D[8]);
    expect(result.equityCurve[0]!.nav).toBe(CFG.startCapital);
  });
});

// ── Suite 7: Carry-forward close (sparse series) ─────────────────────────────

describe('FactorBacktest — carry-forward close for a symbol missing a rebalance date', () => {
  // SPARSE is missing D[6] from its series. When computing the d6→d8 forward
  // return, closeAt(SPARSE, d6) returns D[5]'s close (carry-forward).
  // This tests that the engine handles data gaps without crashing.

  const sparseSeries: PricePoint[] = [
    { date: D[0]!, close: 100 },
    { date: D[1]!, close: 105 },
    { date: D[2]!, close: 110.25 },
    { date: D[3]!, close: 115.76 },
    { date: D[4]!, close: 121.55 },
    { date: D[5]!, close: 127.63 },
    // D[6] intentionally missing — closeAt() will carry D[5]'s close for d6 queries
    { date: D[7]!, close: 140.71 },
    { date: D[8]!, close: 147.75 },
    { date: D[9]!, close: 155.13 },
  ];

  // Must have ≥3 symbols total so winsorize produces valid z-scores.
  const model = new FactorModel(DEFAULT_WEIGHTS, SMALL);
  const backtest = new FactorBacktest(model, CFG);
  const result = backtest.run([
    { symbol: 'SPARSE', sector: 'Tech', series: sparseSeries },
    symB, // falling (rank 2 or 3)
    symC, // mildly rising (rank 2 or 3)
  ]);

  it('backtest completes without error even with a missing date', () => {
    expect(result.metrics.rebalanceCount).toBeGreaterThanOrEqual(1);
  });

  it('finalNav is defined and positive', () => {
    expect(result.metrics.finalNav).toBeGreaterThan(0);
  });
});
