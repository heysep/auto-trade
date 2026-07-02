// Point-in-time long-only top-N rebalancing backtest (AQR §5.1).
// Pure/deterministic — no I/O, no Date.now, no Math.random.
//
// Look-ahead safety guarantee:
//   At each rebalance date d, only prices with date ≤ d are fed to the model.
//   Future prices are never observed during scoring.
//
// Last rebalance boundary note:
//   The final kept rebalance date records holdings but has no forward window
//   (there is no subsequent rebalance date d'). It IS the endpoint of the
//   preceding equity step, but originates no new equity step.

import { type FactorModel, type UniverseEntry } from './FactorModel.js';
import { maxDrawdown } from '../performance/PerformanceAnalyzer.js';

// ── Public interfaces ─────────────────────────────────────────────────────────

/** A single price observation for a symbol. `date` is epoch milliseconds. */
export interface PricePoint {
  date: number;
  close: number;
}

/**
 * A symbol's full price history, ascending by date.
 * All PricePoint.date values must be unique within a series.
 */
export interface BacktestSymbol {
  symbol: string;
  sector: string;
  /** Ascending by date. */
  series: PricePoint[];
}

export interface FactorBacktestConfig {
  /** Hold the top-N symbols by composite rank at each rebalance. */
  topN: number;
  /**
   * Rebalance at every Nth index on the union date axis.
   * E.g. 21 ≈ monthly rebalancing on daily data.
   */
  rebalanceEvery: number;
  /** Starting portfolio value in dollars (or any currency unit). */
  startCapital: number;
}

/** Holdings selected at one rebalance date. */
export interface RebalancePoint {
  date: number;
  holdings: string[];
}

export interface FactorBacktestResult {
  /**
   * NAV at each rebalance boundary.
   * First point = firstRebalanceDate at startCapital.
   * Subsequent points = d' after each forward step.
   * Length equals rebalances.length.
   */
  equityCurve: { date: number; nav: number }[];
  /** All rebalance events, including the last (which has no forward window). */
  rebalances: RebalancePoint[];
  metrics: {
    /** (finalNav / startCapital) - 1. Zero when no rebalances occurred. */
    totalReturn: number;
    /** Worst peak-to-trough on the NAV series. Non-positive. */
    maxDrawdown: number;
    /** Total number of rebalance events (= rebalances.length). */
    rebalanceCount: number;
    finalNav: number;
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class FactorBacktest {
  private readonly model: FactorModel;
  private readonly cfg: FactorBacktestConfig;

  constructor(model: FactorModel, cfg: FactorBacktestConfig) {
    this.model = model;
    this.cfg = cfg;
  }

  /**
   * Run the backtest over the given universe.
   *
   * Algorithm:
   * 1. Build the union date axis = sorted unique dates across all series.
   * 2. Candidate rebalance indices: 0, rebalanceEvery, 2*rebalanceEvery, …
   *    Only keep a date when scoring at that date yields ≥ 1 holding.
   * 3. At each kept date d, score using only prices with date ≤ d (look-ahead safe).
   *    Take the symbols with rank ≤ topN as equal-weight holdings.
   * 4. Forward return from d to next kept date d': equal-weight mean of per-symbol
   *    returns. closeAt uses carry-forward (last known price on or before the query date).
   * 5. equityCurve starts at {firstRebalanceDate, startCapital} then appends after each step.
   * 6. The LAST rebalance date has no d' → holdings are recorded, no equity step.
   */
  run(universe: BacktestSymbol[]): FactorBacktestResult {
    // ── Step 1: Build union date axis ─────────────────────────────────────────
    const dateSet = new Set<number>();
    for (const sym of universe) {
      for (const pt of sym.series) {
        dateSet.add(pt.date);
      }
    }
    const axis = [...dateSet].sort((a, b) => a - b);

    if (axis.length === 0) {
      return this.emptyResult();
    }

    // Build O(1) symbol lookup
    const symMap = new Map<string, BacktestSymbol>();
    for (const sym of universe) {
      symMap.set(sym.symbol, sym);
    }

    // ── Steps 2 & 3: Collect kept rebalance dates ─────────────────────────────
    interface RebalanceInfo {
      date: number;
      holdings: string[];
    }
    const keptRebalances: RebalanceInfo[] = [];

    for (let k = 0; k < axis.length; k += this.cfg.rebalanceEvery) {
      const d = axis[k];
      if (d === undefined) continue;

      // Build universe entries: ONLY prices with date ≤ d  (look-ahead safety)
      const entries: UniverseEntry[] = [];
      for (const sym of universe) {
        const prices: number[] = [];
        for (const pt of sym.series) {
          if (pt.date <= d) {
            prices.push(pt.close);
          } else {
            break; // series is ascending by date
          }
        }
        if (prices.length >= 1) {
          entries.push({ symbol: sym.symbol, sector: sym.sector, prices });
        }
      }

      // Score and select holdings
      const scored = this.model.score(entries);
      const holdings = scored
        .filter((s) => s.rank <= this.cfg.topN)
        .map((s) => s.symbol);

      if (holdings.length >= 1) {
        keptRebalances.push({ date: d, holdings });
      }
    }

    if (keptRebalances.length === 0) {
      return this.emptyResult();
    }

    // ── Steps 4 & 5: Build equity curve ───────────────────────────────────────
    const equityCurve: { date: number; nav: number }[] = [];
    const rebalances: RebalancePoint[] = [];
    let nav = this.cfg.startCapital;

    // Safety: keptRebalances.length > 0 checked above.
    const firstRebalance = keptRebalances[0]!;
    equityCurve.push({ date: firstRebalance.date, nav });
    rebalances.push({ date: firstRebalance.date, holdings: firstRebalance.holdings });

    for (let i = 1; i < keptRebalances.length; i++) {
      // Safety: both indices are within bounds by loop invariant.
      const prev = keptRebalances[i - 1]!;
      const curr = keptRebalances[i]!;

      // Forward return for each held symbol from prev.date to curr.date
      const symbolReturns: number[] = [];
      for (const holdingSymbol of prev.holdings) {
        const sym = symMap.get(holdingSymbol);
        if (sym === undefined) continue;

        const priceAtD = closeAt(sym, prev.date);
        // prev.date is a scored date — symbol was in the universe and had ≥1 price.
        // Defensive guard in case of unexpected data.
        if (priceAtD === null || !(priceAtD > 0)) continue;

        // carry-forward: uses the last known close on or before curr.date.
        const priceAtDPrime = closeAt(sym, curr.date);
        if (priceAtDPrime === null || !(priceAtDPrime > 0)) continue;

        symbolReturns.push(priceAtDPrime / priceAtD - 1);
      }

      const portfolioReturn =
        symbolReturns.length > 0
          ? symbolReturns.reduce((sum, r) => sum + r, 0) / symbolReturns.length
          : 0;

      nav = nav * (1 + portfolioReturn);
      equityCurve.push({ date: curr.date, nav });
      rebalances.push({ date: curr.date, holdings: curr.holdings });
    }

    // Note: the LAST rebalance in keptRebalances has been appended to `rebalances`
    // but no forward step originates from it (it IS the d' of the penultimate step).

    const navs = equityCurve.map((pt) => pt.nav);
    // Safety: equityCurve.length >= 1 (at least firstRebalance was pushed).
    const finalNav = navs[navs.length - 1] ?? this.cfg.startCapital;

    return {
      equityCurve,
      rebalances,
      metrics: {
        totalReturn: finalNav / this.cfg.startCapital - 1,
        maxDrawdown: maxDrawdown(navs),
        rebalanceCount: rebalances.length,
        finalNav,
      },
    };
  }

  /** Returns the canonical empty result when no rebalances occur. */
  private emptyResult(): FactorBacktestResult {
    return {
      equityCurve: [],
      rebalances: [],
      metrics: {
        totalReturn: 0,
        maxDrawdown: 0,
        finalNav: this.cfg.startCapital,
        rebalanceCount: 0,
      },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the close price for the latest PricePoint in `sym.series` with
 * date ≤ atDate (carry-forward). Returns null if no such point exists.
 * Relies on series being ascending by date for early termination.
 */
function closeAt(sym: BacktestSymbol, atDate: number): number | null {
  let result: number | null = null;
  for (const pt of sym.series) {
    if (pt.date <= atDate) {
      result = pt.close;
    } else {
      break; // ascending — no later point can qualify
    }
  }
  return result;
}
