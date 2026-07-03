// Universe backtest service: caches the expensive BacktestSymbol[] price matrix
// per TTL (default 1 hour), then runs FactorBacktest cheaply on each request.
// Same TTL / sequential-fetch / per-symbol-isolation pattern as FactorRankingService.

import type { TossStock, TossCandle } from '../toss/types.js';
import type { FactorModel } from './FactorModel.js';
import { FactorBacktest, type BacktestSymbol, type FactorBacktestResult } from './FactorBacktest.js';

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface FactorBacktestServiceDeps {
  /** Supplier of the universe; called on every cache miss. */
  universe: () => TossStock[] | Promise<TossStock[]>;
  /** Fetch daily candles for one symbol. Called sequentially, NOT concurrently. */
  getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  /** Pre-constructed FactorModel (carries its own weights + periods). */
  model: FactorModel;
  /** Injectable clock — defaults to Date.now for production. */
  now?: () => number;
  /** Cache TTL in milliseconds. Default: 1 hour. */
  ttlMs?: number;
  /** Number of daily candles to fetch per symbol. Default: 500. */
  historyBars?: number;
}

export interface FactorBacktestParams {
  /** Top-N symbols to hold at each rebalance. Default: 10. */
  topN?: number;
  /** Rebalance every N bars on the union date axis. Default: 21. */
  rebalanceEvery?: number;
  /** Starting portfolio value. Default: 10_000_000. */
  startCapital?: number;
}

export interface FactorBacktestReport {
  /** The raw backtest result from the engine. */
  result: FactorBacktestResult;
  /** Total symbols in the universe (including skipped). */
  universeSize: number;
  /** Number of symbols with valid candles that entered the matrix. */
  fetched: number;
  /** Symbols skipped due to fetch error or empty/invalid candles. */
  skipped: number;
  /** Epoch ms when the matrix was built. */
  asOf: number;
}

// ── Internal cache shape ──────────────────────────────────────────────────────

interface MatrixCache {
  matrix: BacktestSymbol[];
  asOf: number;
  universeSize: number;
  fetched: number;
  skipped: number;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_TOP_N = 10;
const DEFAULT_REBALANCE_EVERY = 21;
const DEFAULT_START_CAPITAL = 10_000_000;
const DEFAULT_TTL_MS = 3_600_000;   // 1 hour
const DEFAULT_HISTORY_BARS = 500;

// ── Service ───────────────────────────────────────────────────────────────────

export class FactorBacktestService {
  private readonly universe: () => TossStock[] | Promise<TossStock[]>;
  private readonly getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  private readonly model: FactorModel;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly historyBars: number;

  private cache: MatrixCache | undefined;
  private inflight: Promise<MatrixCache> | undefined;

  constructor(deps: FactorBacktestServiceDeps) {
    this.universe = deps.universe;
    this.getCandles = deps.getCandles;
    this.model = deps.model;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.historyBars = deps.historyBars ?? DEFAULT_HISTORY_BARS;
  }

  /**
   * Run a factor backtest over the cached universe matrix.
   * The expensive price-matrix fetch is only repeated when the TTL expires.
   * Each call can supply different backtest params without triggering a refetch.
   */
  async run(params?: FactorBacktestParams): Promise<FactorBacktestReport> {
    const matrixCache = await this.getMatrix();

    const topN         = params?.topN         ?? DEFAULT_TOP_N;
    const rebalanceEvery = params?.rebalanceEvery ?? DEFAULT_REBALANCE_EVERY;
    const startCapital  = params?.startCapital  ?? DEFAULT_START_CAPITAL;

    const engine = new FactorBacktest(this.model, { topN, rebalanceEvery, startCapital });
    const result = engine.run(matrixCache.matrix);

    return {
      result,
      universeSize: matrixCache.universeSize,
      fetched: matrixCache.fetched,
      skipped: matrixCache.skipped,
      asOf: matrixCache.asOf,
    };
  }

  /**
   * Return (or build) the BacktestSymbol[] matrix.
   * Concurrent cold-cache calls join a single in-flight rebuild (thundering-herd guard).
   */
  private async getMatrix(): Promise<MatrixCache> {
    const now = this.now();

    // Cache hit: age strictly less than ttlMs (same guard as FactorRankingService)
    if (this.cache !== undefined && now - this.cache.asOf < this.ttlMs) {
      return this.cache;
    }

    // In-flight dedup: join the pending rebuild instead of starting a new one.
    if (this.inflight !== undefined) {
      return this.inflight;
    }

    // Start rebuild; store the promise synchronously so concurrent callers join it.
    this.inflight = this.buildMatrix(now);
    try {
      const entry = await this.inflight;
      this.cache = entry;
      return entry;
    } finally {
      this.inflight = undefined;
    }
  }

  private async buildMatrix(now: number): Promise<MatrixCache> {
    const stocks = await this.universe();
    const universeSize = stocks.length;

    let fetched = 0;
    let skipped = 0;
    const matrix: BacktestSymbol[] = [];

    // Sequential — one symbol at a time to respect rate limits
    for (const stock of stocks) {
      try {
        const candles = await this.getCandles(stock.symbol, '1d', this.historyBars);
        if (candles.length === 0) {
          skipped++;
          continue;
        }

        // Sort ascending by ISO timestamp
        const sorted = [...candles].sort(
          (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        );

        // Build PricePoint series; drop NaN and non-positive closes
        const series = sorted
          .map((c) => ({ date: Date.parse(c.timestamp), close: Number(c.closePrice) }))
          .filter((pt) => !Number.isNaN(pt.close) && pt.close > 0);

        if (series.length === 0) {
          skipped++;
          continue;
        }

        matrix.push({
          symbol: stock.symbol,
          sector: stock.sector ?? stock.market ?? 'KR',
          series,
        });
        fetched++;
      } catch {
        // Per-symbol isolation: skip on any upstream error
        skipped++;
      }
    }

    return { matrix, asOf: now, universeSize, fetched, skipped };
  }
}
