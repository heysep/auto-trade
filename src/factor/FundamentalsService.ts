// FundamentalsService: fetches OpenDART financials for the KRX universe and
// computes cross-sectional Value and Quality factor scores.
// Sequential fetch (OpenDART rate limits) + per-symbol failure isolation.
// TTL-cached result + in-flight dedup mirror FactorRankingService's pattern.

import { zscore } from './standardize.js';
import type { DartApiClient } from '../dart/DartApiClient.js';
import type { DartFinancials } from '../dart/types.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MarketCapEntry {
  symbol: string;
  /** marketCap = sharesOutstanding * lastClose. 0 when data unavailable (imputed neutral). */
  marketCap: number;
}

export interface FundamentalsResult {
  /** Cross-sectional value scores, keyed by symbol. Covers EVERY input symbol. */
  value: Map<string, number>;
  /** Cross-sectional quality scores, keyed by symbol. Covers EVERY input symbol. */
  quality: Map<string, number>;
}

export interface FundamentalsDeps {
  dart: DartApiClient;
  /** Fiscal year to fetch (e.g. 2024). Falls back to year-1 on null. */
  year: number;
  /** Injectable clock — defaults to Date.now for production. */
  now?: () => number;
  /** Cache TTL in milliseconds. Default: 6 hours. */
  ttlMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// FundamentalsService
// ---------------------------------------------------------------------------

export class FundamentalsService {
  private readonly dart: DartApiClient;
  private readonly year: number;
  private readonly now: () => number;
  private readonly ttlMs: number;

  /** Cached result from last successful build. */
  private cache: { result: FundamentalsResult; asOf: number } | undefined;
  /** In-flight build promise for thundering-herd dedup. */
  private inflight: Promise<FundamentalsResult> | undefined;

  constructor(deps: FundamentalsDeps) {
    this.dart = deps.dart;
    this.year = deps.year;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Compute Value and Quality factor maps for all input symbols.
   *
   * Returns maps covering EVERY symbol in `entries` (imputes 0 for missing data)
   * so FactorModel.score always includes both factors.
   *
   * Cached for TTL ms; concurrent cold-cache callers join the single in-flight
   * computation (thundering-herd guard).
   *
   * Symbols absent from the cached maps (e.g. added after the cache was primed)
   * are projected to 0 (neutral) so FactorModel's all-or-nothing coverage gate
   * never silently drops Value + Quality for the whole cross-section.
   */
  async compute(entries: MarketCapEntry[]): Promise<FundamentalsResult> {
    const nowMs = this.now();

    // Cache hit — project onto the currently requested entry set so new symbols
    // introduced since the cache was built receive neutral (0) scores.
    if (this.cache !== undefined && nowMs - this.cache.asOf < this.ttlMs) {
      return this.projectEntries(this.cache.result, entries);
    }

    // In-flight dedup: join the pending rebuild then project.
    if (this.inflight !== undefined) {
      const result = await this.inflight;
      return this.projectEntries(result, entries);
    }

    // Start build
    this.inflight = this.buildResult(entries);
    try {
      const result = await this.inflight;
      this.cache = { result, asOf: nowMs };
      return this.projectEntries(result, entries);
    } finally {
      this.inflight = undefined;
    }
  }

  /**
   * Project cached maps onto a (potentially different) entry set.
   * Any symbol absent from the cached maps receives neutral scores (0)
   * so downstream callers always see full coverage.
   */
  private projectEntries(result: FundamentalsResult, entries: MarketCapEntry[]): FundamentalsResult {
    const value = new Map<string, number>();
    const quality = new Map<string, number>();
    for (const e of entries) {
      value.set(e.symbol, result.value.get(e.symbol) ?? 0);
      quality.set(e.symbol, result.quality.get(e.symbol) ?? 0);
    }
    return { value, quality };
  }

  // ---------------------------------------------------------------------------
  // Private: build
  // ---------------------------------------------------------------------------

  private async buildResult(entries: MarketCapEntry[]): Promise<FundamentalsResult> {
    // 1. Resolve corp codes
    const corpMap = await this.dart.corpCodeMap();

    // 2. Fetch financials sequentially (OpenDART rate limits).
    //    Per-symbol try/catch — one failure does not abort the whole batch.
    const financialsMap = new Map<string, DartFinancials>();

    for (const entry of entries) {
      const corpCode = corpMap.get(entry.symbol);
      if (corpCode === undefined) continue;

      try {
        let fin = await this.dart.financials(corpCode, this.year);
        if (fin === null) {
          // Fallback to prior year once
          fin = await this.dart.financials(corpCode, this.year - 1);
        }
        if (fin !== null) {
          financialsMap.set(entry.symbol, fin);
        }
      } catch {
        // Treat fetch failures as "no data" — symbol gets neutral scores
      }
    }

    // 3. Compute raw sub-metrics where inputs exist and denominators > 0
    //    Value:   earningsYield = netIncome / marketCap
    //             bookToMarket  = totalEquity / marketCap
    //    Quality: roe           = netIncome / totalEquity
    //             gpToAssets    = grossProfit / totalAssets
    //             debtToEquity  = totalLiabilities / totalEquity  (inverted: lower = better)

    const eyRaw  = new Map<string, number>(); // earningsYield
    const btmRaw = new Map<string, number>(); // bookToMarket
    const roeRaw = new Map<string, number>(); // ROE
    const gpaRaw = new Map<string, number>(); // gpToAssets
    const dteRaw = new Map<string, number>(); // debtToEquity

    for (const entry of entries) {
      const fin = financialsMap.get(entry.symbol);
      if (fin === undefined) continue;

      const mc = entry.marketCap;

      // Value sub-metrics (require positive marketCap)
      if (fin.netIncome !== undefined && mc > 0) {
        eyRaw.set(entry.symbol, fin.netIncome / mc);
      }
      if (fin.totalEquity !== undefined && mc > 0) {
        btmRaw.set(entry.symbol, fin.totalEquity / mc);
      }

      // Quality sub-metrics (no marketCap dependency)
      if (fin.netIncome !== undefined && fin.totalEquity !== undefined && fin.totalEquity > 0) {
        roeRaw.set(entry.symbol, fin.netIncome / fin.totalEquity);
      }
      if (fin.grossProfit !== undefined && fin.totalAssets !== undefined && fin.totalAssets > 0) {
        gpaRaw.set(entry.symbol, fin.grossProfit / fin.totalAssets);
      }
      if (fin.totalLiabilities !== undefined && fin.totalEquity !== undefined && fin.totalEquity > 0) {
        dteRaw.set(entry.symbol, fin.totalLiabilities / fin.totalEquity);
      }
    }

    // 4. Cross-section z-score each sub-metric over symbols that have it.
    //    Symbols missing a sub-metric are treated as 0 (neutral) after z.

    // zscore per sub-metric (spec: "standardize each sub-metric with zscore").
    // winsorize not applied here — sub-metrics are first-pass standardized, and
    // the outer FactorModel applies winsorize+zscore on the combined factor score.
    const computeZMap = (rawMap: Map<string, number>): Map<string, number> => {
      const syms = [...rawMap.keys()];
      if (syms.length === 0) return new Map();
      const vals = syms.map((s) => rawMap.get(s) as number);
      const zVals = zscore(vals);
      return new Map(syms.map((s, i) => [s, zVals[i] ?? 0]));
    };

    const eyZ  = computeZMap(eyRaw);
    const btmZ = computeZMap(btmRaw);
    const roeZ = computeZMap(roeRaw);
    const gpaZ = computeZMap(gpaRaw);
    const dteZ = computeZMap(dteRaw);

    // 5. Combine sub-metrics: mean of present components.
    //    Missing component → treated as absent (not included in mean).
    //    Symbol with no components → score = 0.

    const valueMap   = new Map<string, number>();
    const qualityMap = new Map<string, number>();

    for (const entry of entries) {
      const sym = entry.symbol;

      // Value score: mean(present of [z(EY), z(B2M)])
      const vComponents: number[] = [];
      const eyZv = eyZ.get(sym);
      if (eyZv !== undefined) vComponents.push(eyZv);
      const btmZv = btmZ.get(sym);
      if (btmZv !== undefined) vComponents.push(btmZv);
      const vScore = vComponents.length > 0
        ? vComponents.reduce((s, v) => s + v, 0) / vComponents.length
        : 0;
      valueMap.set(sym, vScore);

      // Quality score: mean(present of [z(ROE), z(gpToAssets), -z(debtToEquity)])
      const qComponents: number[] = [];
      const roeZv = roeZ.get(sym);
      if (roeZv !== undefined) qComponents.push(roeZv);
      const gpaZv = gpaZ.get(sym);
      if (gpaZv !== undefined) qComponents.push(gpaZv);
      const dteZv = dteZ.get(sym);
      if (dteZv !== undefined) qComponents.push(-dteZv); // inverted: lower leverage = higher quality
      const qScore = qComponents.length > 0
        ? qComponents.reduce((s, v) => s + v, 0) / qComponents.length
        : 0;
      qualityMap.set(sym, qScore);
    }

    return { value: valueMap, quality: qualityMap };
  }
}
