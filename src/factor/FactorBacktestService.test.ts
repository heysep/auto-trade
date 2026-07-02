// TDD: tests written BEFORE the implementation.
// FactorBacktestService: caches BacktestSymbol[] matrix (expensive), re-runs
// FactorBacktest engine per-request (cheap). Same TTL / sequential-fetch /
// per-symbol-isolation pattern as FactorRankingService.

import { describe, it, expect } from 'vitest';
import { FactorBacktestService } from './FactorBacktestService.js';
import { FactorModel } from './FactorModel.js';
import type { TossStock, TossCandle } from '../toss/types.js';

// Short periods so a ~12-bar series is enough for all four raw factors.
// momSkip=1, momLong=3 → needs n>3 ✓
// volWindow=3          → needs n>3 ✓
// mddWindow=3          → needs ≥2  ✓
const SMALL_PERIODS = { momSkip: 1, momLong: 3, momMid: 2, volWindow: 3, mddWindow: 3 };

/** Build TossCandle[] from an array of close prices (oldest→newest). */
function makeCandles(closes: number[]): TossCandle[] {
  return closes.map((close, i) => ({
    // One day apart so each date is unique and in ascending order
    timestamp: new Date(86_400_000 * (i + 1)).toISOString(),
    openPrice: String(close),
    highPrice: String(close),
    lowPrice: String(close),
    closePrice: String(close),
  }));
}

const UNIVERSE: TossStock[] = [
  { symbol: 'A', name: 'Alpha',  market: 'KOSPI'  },
  { symbol: 'B', name: 'Beta',   market: 'KOSDAQ' },
  { symbol: 'C', name: 'Gamma',  market: 'KOSPI'  },
  { symbol: 'D', name: 'Delta',  market: 'KOSDAQ' },
];

const CLOSES: Record<string, number[]> = {
  A: [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122],
  B: [100,  80, 120,  60,  50,  55,  60,  65,  70,  75,  80,  85],
  C: [100, 100, 100, 100, 100, 101, 101, 102, 102, 103, 103, 104],
  D: [100,  95,  90,  85,  80,  75,  70,  65,  60,  55,  50,  45],
};

function makeGetCandles(
  closes: Record<string, number[]>,
): (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]> {
  return async (symbol: string, _interval: '1d', _count: number) => {
    const data = closes[symbol];
    if (data === undefined) throw new Error(`unknown symbol: ${symbol}`);
    return makeCandles(data);
  };
}

describe('FactorBacktestService', () => {
  describe('basic run', () => {
    it('returns a report with equityCurve + rebalances + metrics', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles: makeGetCandles(CLOSES),
        model,
      });

      const report = await svc.run({ topN: 2, rebalanceEvery: 3, startCapital: 1_000_000 });

      expect(report.universeSize).toBe(4);
      expect(report.fetched).toBeGreaterThanOrEqual(1);
      expect(report.skipped).toBeGreaterThanOrEqual(0);
      expect(typeof report.asOf).toBe('number');

      // result is FactorBacktestResult — fields live at top level
      expect(Array.isArray(report.result.equityCurve)).toBe(true);
      expect(Array.isArray(report.result.rebalances)).toBe(true);
      expect(typeof report.result.metrics.totalReturn).toBe('number');
      expect(typeof report.result.metrics.maxDrawdown).toBe('number');
      expect(typeof report.result.metrics.rebalanceCount).toBe('number');
      expect(typeof report.result.metrics.finalNav).toBe('number');
      // At least one rebalance occurred (12 bars, step=3 → up to 4 candidates)
      expect(report.result.rebalances.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('matrix cache', () => {
    it('fetches candles once then reuses cache across two run() calls with different params', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let callCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        callCount++;
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs: 60_000,
      });

      // First run: fetches all 4 symbols
      await svc.run({ topN: 2, rebalanceEvery: 3 });
      expect(callCount).toBe(4);

      // Second run within TTL with different params: no new fetches
      callCount = 0;
      await svc.run({ topN: 1, rebalanceEvery: 5 });
      expect(callCount).toBe(0);  // cache reused
    });

    it('refetches after TTL expires', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let callCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        callCount++;
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const ttlMs = 60_000;
      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs,
      });

      // Prime cache
      await svc.run();
      expect(callCount).toBe(4);

      // Within TTL — no refetch
      callCount = 0;
      now = ttlMs - 1;
      await svc.run();
      expect(callCount).toBe(0);

      // Past TTL — must refetch
      callCount = 0;
      now = ttlMs + 1;
      await svc.run();
      expect(callCount).toBe(4);
    });
  });

  describe('per-symbol failure isolation', () => {
    it('skips a symbol whose getCandles throws and increments skipped', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const BAD = 'B';
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        if (symbol === BAD) throw new Error('upstream failure');
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
      });

      const report = await svc.run();
      expect(report.universeSize).toBe(4);
      expect(report.skipped).toBe(1);
      expect(report.fetched).toBe(3);
    });
  });

  describe('in-flight dedup (thundering herd)', () => {
    it('two concurrent cold-cache run() calls fetch each symbol exactly once', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let fetchCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        fetchCount++;
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => 0,
        ttlMs: 60_000,
      });

      // Fire two concurrent cold-cache calls.
      const [r1, r2] = await Promise.all([svc.run(), svc.run()]);

      // 4 symbols — without dedup both calls fetch 4 each = 8 total.
      // With dedup the second call awaits the first: total = 4.
      expect(fetchCount).toBe(UNIVERSE.length);
      expect(Array.isArray(r1.result.equityCurve)).toBe(true);
      expect(Array.isArray(r2.result.equityCurve)).toBe(true);
    });

    it('a call after the in-flight settles still serves from TTL cache', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let fetchCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        fetchCount++;
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs: 60_000,
      });

      // Prime with concurrent calls.
      await Promise.all([svc.run(), svc.run()]);
      expect(fetchCount).toBe(UNIVERSE.length);

      // A subsequent call within TTL must NOT trigger new fetches.
      fetchCount = 0;
      now = 1_000;
      await svc.run();
      expect(fetchCount).toBe(0);
    });
  });
});
