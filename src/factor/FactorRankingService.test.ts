// TDD: tests written BEFORE the implementation.
// FactorRankingService orchestrates universe assembly → candle fetch → FactorModel → ranked result.

import { describe, it, expect } from 'vitest';
import { FactorRankingService } from './FactorRankingService.js';
import { FactorModel } from './FactorModel.js';
import type { TossStock, TossCandle } from '../toss/types.js';

// Small periods so a 5-bar price series is enough for all four raw factors.
// momSkip=1, momLong=3 → needs n>3 (≥4 bars)  ✓
// volWindow=3          → needs n>3              ✓
// mddWindow=3          → needs ≥2 bars in slice ✓
const SMALL_PERIODS = {
  momSkip: 1,
  momLong: 3,
  momMid: 2,
  volWindow: 3,
  mddWindow: 3,
};

/** Build TossCandle[] from an array of close prices (oldest→newest). */
function makeCandles(closes: number[]): TossCandle[] {
  return closes.map((close, i) => ({
    // timestamps are 1 s, 2 s, … apart (distinct ISO strings)
    timestamp: new Date(1000 * (i + 1)).toISOString(),
    openPrice: String(close),
    highPrice: String(close),
    lowPrice: String(close),
    closePrice: String(close),
  }));
}

/** Steady rise → positive momentum, low vol, zero MDD. */
const RISING_CLOSES = [100, 102, 104, 106, 108];
/** Sharp decline with high vol → negative momentum, high vol, large MDD. */
const FALLING_CLOSES = [100, 80, 120, 60, 50];
/** Flat → zero momentum, zero vol, zero MDD (still scorable). */
const FLAT_CLOSES = [100, 100, 100, 100, 100];

const UNIVERSE: TossStock[] = [
  { symbol: 'RISING', name: 'Rising Stock', market: 'KR' },
  { symbol: 'FALLING', name: 'Falling Stock', market: 'KR' },
  { symbol: 'FLAT', name: 'Flat Stock', market: 'KR' },
];

const CLOSES_BY_SYMBOL: Record<string, number[]> = {
  RISING: RISING_CLOSES,
  FALLING: FALLING_CLOSES,
  FLAT: FLAT_CLOSES,
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

describe('FactorRankingService', () => {
  describe('ranking correctness', () => {
    it('returns a result with contiguous ranks 1..N sorted by composite', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles: makeGetCandles(CLOSES_BY_SYMBOL),
        model,
      });

      const result = await service.rank();

      // universeSize counts all symbols; fetched counts those with usable candles
      expect(result.universeSize).toBe(3);
      expect(result.fetched).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.scored).toHaveLength(3);

      // Ranks must be exactly 1, 2, 3 — contiguous, no gaps, no repeats
      const ranks = result.scored.map((s) => s.rank).sort((a, b) => a - b);
      expect(ranks).toEqual([1, 2, 3]);

      // scored is already rank-sorted: scored[0].rank === 1
      expect(result.scored[0]?.rank).toBe(1);
      expect(result.scored[1]?.rank).toBe(2);
      expect(result.scored[2]?.rank).toBe(3);
    });

    it('rising/low-vol stock outranks falling/high-vol stock', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles: makeGetCandles(CLOSES_BY_SYMBOL),
        model,
      });

      const result = await service.rank();

      const risingEntry = result.scored.find((s) => s.symbol === 'RISING');
      const fallingEntry = result.scored.find((s) => s.symbol === 'FALLING');

      expect(risingEntry).toBeDefined();
      expect(fallingEntry).toBeDefined();
      // Lower rank number = better; rising stock must beat the volatile faller
      expect(risingEntry!.rank).toBeLessThan(fallingEntry!.rank);
    });

    it('passes the default candleCount (280) to getCandles', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const capturedCounts: number[] = [];

      const getCandles = async (
        symbol: string,
        _interval: '1d',
        count: number,
      ): Promise<TossCandle[]> => {
        capturedCounts.push(count);
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown symbol: ${symbol}`);
        return makeCandles(data);
      };

      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
      });

      await service.rank();

      // Every symbol must receive count=280 (the default candleCount)
      expect(capturedCounts).toHaveLength(UNIVERSE.length);
      expect(capturedCounts.every((c) => c === 280)).toBe(true);
    });

    it('passes a custom candleCount when configured', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const capturedCounts: number[] = [];

      const getCandles = async (
        symbol: string,
        _interval: '1d',
        count: number,
      ): Promise<TossCandle[]> => {
        capturedCounts.push(count);
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown symbol: ${symbol}`);
        return makeCandles(data);
      };

      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        candleCount: 350,
      });

      await service.rank();

      expect(capturedCounts.every((c) => c === 350)).toBe(true);
    });
  });

  describe('caching + limit', () => {
    it('limit slices the top-N without triggering a refetch within TTL', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let callCount = 0;

      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        callCount++;
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown symbol: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs: 60_000,
      });

      // First call: fetches all 3 symbols
      const full = await service.rank();
      expect(callCount).toBe(3);
      expect(full.scored).toHaveLength(3);

      // Second call within TTL with limit=2: no new candle fetches
      callCount = 0;
      const limited = await service.rank(2);

      expect(callCount).toBe(0); // must be zero — cache was reused
      expect(limited.scored).toHaveLength(2);

      // The two returned items must be rank 1 and rank 2
      expect(limited.scored[0]?.rank).toBe(1);
      expect(limited.scored[1]?.rank).toBe(2);

      // Same leading symbols as the full result
      expect(limited.scored[0]?.symbol).toBe(full.scored[0]?.symbol);
      expect(limited.scored[1]?.symbol).toBe(full.scored[1]?.symbol);

      // The non-sliced fields come from the cached full computation
      expect(limited.universeSize).toBe(3);
      expect(limited.fetched).toBe(3);
    });

    it('unrestricted rank() after limit does not refetch', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let callCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        callCount++;
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs: 60_000,
      });

      await service.rank(1);       // first call — fetches 3
      callCount = 0;

      const full = await service.rank(); // no limit — should still come from cache
      expect(callCount).toBe(0);
      expect(full.scored).toHaveLength(3);
    });
  });

  describe('per-symbol failure isolation', () => {
    it('skips a symbol whose getCandles throws and continues ranking others', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const ERR_SYMBOL = 'FAILING';

      const universe: TossStock[] = [
        { symbol: 'RISING', name: 'Rising', market: 'KR' },
        { symbol: ERR_SYMBOL, name: 'Failing', market: 'KR' },
        { symbol: 'FLAT', name: 'Flat', market: 'KR' },
      ];

      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        if (symbol === ERR_SYMBOL) throw new Error('upstream error');
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      const service = new FactorRankingService({
        universe: () => universe,
        getCandles,
        model,
      });

      const result = await service.rank();

      // universe has 3 symbols; one failed; two ranked
      expect(result.universeSize).toBe(3);
      expect(result.skipped).toBe(1);
      expect(result.fetched).toBe(2);
      expect(result.scored).toHaveLength(2);

      // The failed symbol must not appear in scored
      expect(result.scored.find((s) => s.symbol === ERR_SYMBOL)).toBeUndefined();
    });

    it('skips a symbol that returns empty candles', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);

      const universe: TossStock[] = [
        { symbol: 'RISING', name: 'Rising', market: 'KR' },
        { symbol: 'EMPTY', name: 'Empty candles', market: 'KR' },
        { symbol: 'FLAT', name: 'Flat', market: 'KR' },
      ];

      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        if (symbol === 'EMPTY') return [];
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      const service = new FactorRankingService({
        universe: () => universe,
        getCandles,
        model,
      });

      const result = await service.rank();

      expect(result.skipped).toBe(1);
      expect(result.fetched).toBe(2);
      expect(result.scored.find((s) => s.symbol === 'EMPTY')).toBeUndefined();
    });
  });

  describe('TTL / cache invalidation', () => {
    it('does NOT refetch while within TTL', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let callCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        callCount++;
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const ttlMs = 60_000;
      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs,
      });

      await service.rank();
      expect(callCount).toBe(3);

      callCount = 0;
      now = ttlMs - 1; // still fresh (age = 59 999 ms < 60 000 ms)
      await service.rank();
      expect(callCount).toBe(0);
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
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const ttlMs = 60_000;
      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs,
      });

      // Prime the cache
      await service.rank();
      expect(callCount).toBe(3);

      // Still within TTL — no refetch
      callCount = 0;
      now = ttlMs - 1;
      await service.rank();
      expect(callCount).toBe(0);

      // Past TTL — must refetch
      callCount = 0;
      now = ttlMs + 1; // age = ttlMs+1 ms ≥ ttlMs
      await service.rank();
      expect(callCount).toBe(3);

      // asOf updated to the new now
      const result = await service.rank();
      expect(result.asOf).toBe(now);
    });
  });
});
