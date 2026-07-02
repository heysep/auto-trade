// Universe factor-ranking service: assembles KRX universe, fetches daily candles
// sequentially (respecting rate limits), runs FactorModel, and caches the full
// ranked result with a configurable TTL. `limit` only slices on return; no refetch.

import type { TossStock, TossCandle } from '../toss/types.js';
import type { FactorModel, ScoredSymbol } from './FactorModel.js';

export interface FactorRankingDeps {
  /** Supplier of the universe; called on every cache miss. May be sync or async. */
  universe: () => TossStock[] | Promise<TossStock[]>;
  /** Fetch daily candles for one symbol. Called sequentially, NOT concurrently. */
  getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  /** Pre-constructed FactorModel (carries its own weights + periods). */
  model: FactorModel;
  /** Injectable clock — defaults to Date.now for production. */
  now?: () => number;
  /** Cache TTL in milliseconds. Default: 15 minutes. */
  ttlMs?: number;
  /** Number of daily candles to fetch per symbol. Default: 280 (needs >252 for 12-month momentum). */
  candleCount?: number;
}

export interface RankingResult {
  /** Epoch ms when this ranking was computed. */
  asOf: number;
  /** Full scored list sorted by rank (1 = best). */
  scored: ScoredSymbol[];
  /** Total symbols in the universe (including skipped). */
  universeSize: number;
  /** Number of symbols with valid candles that entered FactorModel. */
  fetched: number;
  /** Symbols skipped due to fetch error or empty candles. */
  skipped: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class FactorRankingService {
  private readonly universe: () => TossStock[] | Promise<TossStock[]>;
  private readonly getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  private readonly model: FactorModel;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly candleCount: number;

  private cache: RankingResult | undefined;
  private inflight: Promise<RankingResult> | undefined;

  constructor(deps: FactorRankingDeps) {
    this.universe = deps.universe;
    this.getCandles = deps.getCandles;
    this.model = deps.model;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.candleCount = deps.candleCount ?? 280;
  }

  /**
   * Return the full (or sliced) factor ranking.
   * Cached result is reused when `now() - asOf < ttlMs`.
   * Concurrent cold-cache calls join a single in-flight rebuild (thundering-herd guard).
   * `limit` only slices the returned `scored` array — universe/fetched/skipped
   * always reflect the full computation.
   */
  async rank(limit?: number): Promise<RankingResult> {
    const now = this.now();

    // Cache hit: age strictly less than ttlMs
    if (this.cache !== undefined && now - this.cache.asOf < this.ttlMs) {
      return this.slice(this.cache, limit);
    }

    // In-flight dedup: join the pending rebuild instead of starting a new one.
    if (this.inflight !== undefined) {
      const result = await this.inflight;
      return this.slice(result, limit);
    }

    // Start rebuild; store the promise synchronously so concurrent callers join it.
    this.inflight = this.buildRanking(now);
    try {
      const result = await this.inflight;
      this.cache = result;
      return this.slice(result, limit);
    } finally {
      this.inflight = undefined;
    }
  }

  private async buildRanking(now: number): Promise<RankingResult> {
    const stocks = await this.universe();
    const universeSize = stocks.length;

    let fetched = 0;
    let skipped = 0;

    // UniverseEntry shape FactorModel expects
    const entries: Array<{ symbol: string; sector: string; prices: number[] }> = [];

    // Sequential — one symbol at a time to respect rate limits
    for (const stock of stocks) {
      try {
        const candles = await this.getCandles(stock.symbol, '1d', this.candleCount);
        if (candles.length === 0) {
          skipped++;
          continue;
        }

        // Sort by timestamp ascending, secondary by close (guard parse failures)
        const sorted = [...candles].sort((a, b) => {
          const ta = Date.parse(a.timestamp);
          const tb = Date.parse(b.timestamp);
          if (ta !== tb) return ta - tb;
          return Number(a.closePrice) - Number(b.closePrice);
        });

        // Extract close prices; drop NaN
        const prices = sorted
          .map((c) => Number(c.closePrice))
          .filter((p) => !Number.isNaN(p));

        if (prices.length === 0) {
          skipped++;
          continue;
        }

        entries.push({
          symbol: stock.symbol,
          sector: stock.market || 'KR',
          prices,
        });
        fetched++;
      } catch {
        // Per-symbol isolation: skip on any error
        skipped++;
      }
    }

    const scored = this.model.score(entries);
    return { asOf: now, scored, universeSize, fetched, skipped };
  }

  private slice(result: RankingResult, limit: number | undefined): RankingResult {
    if (limit === undefined) return result;
    return {
      ...result,
      scored: result.scored.slice(0, limit),
    };
  }
}
