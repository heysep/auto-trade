// TDD: tests written BEFORE the implementation.
// FundamentalsService computes value + quality factor scores from OpenDART financials.

import { describe, it, expect } from 'vitest';
import { FundamentalsService } from './FundamentalsService.js';
import type { MarketCapEntry } from './FundamentalsService.js';
import type { DartApiClient } from '../dart/DartApiClient.js';
import type { DartFinancials } from '../dart/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DartApiClient fake for injection. */
function makeDartClient(opts: {
  corpMap: Map<string, string>;
  financialsFor: (corpCode: string, year: number) => Promise<DartFinancials | null>;
}): DartApiClient {
  return {
    corpCodeMap: async () => opts.corpMap,
    financials: (corpCode: string, year: number) => opts.financialsFor(corpCode, year),
  } as unknown as DartApiClient;
}

// ---------------------------------------------------------------------------
// describe: value score
// ---------------------------------------------------------------------------

describe('FundamentalsService – value score', () => {
  it('cheaper stock (lower marketCap, same netIncome) gets a higher value score', async () => {
    // CHEAP: EY = 100/1000 = 0.1, B/M = 800/1000 = 0.8
    // PRICEY: EY = 100/10000 = 0.01, B/M = 800/10000 = 0.08
    // CHEAP wins on both sub-metrics → higher valueScore after zscore + mean.

    const corpMap = new Map([['CHEAP', 'CC_CHEAP'], ['PRICEY', 'CC_PRICEY']]);
    const finData: Record<string, DartFinancials> = {
      CC_CHEAP: {
        corpCode: 'CC_CHEAP', year: 2024,
        netIncome: 100, totalEquity: 800,
        grossProfit: 60, totalAssets: 1200, totalLiabilities: 200,
      },
      CC_PRICEY: {
        corpCode: 'CC_PRICEY', year: 2024,
        netIncome: 100, totalEquity: 800,
        grossProfit: 60, totalAssets: 1200, totalLiabilities: 200,
      },
    };

    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => finData[corpCode] ?? null,
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    const entries: MarketCapEntry[] = [
      { symbol: 'CHEAP',  marketCap: 1_000 },
      { symbol: 'PRICEY', marketCap: 10_000 },
    ];

    const result = await svc.compute(entries);

    expect(result.value.has('CHEAP')).toBe(true);
    expect(result.value.has('PRICEY')).toBe(true);
    expect(result.value.get('CHEAP')!).toBeGreaterThan(result.value.get('PRICEY')!);
  });
});

// ---------------------------------------------------------------------------
// describe: quality score
// ---------------------------------------------------------------------------

describe('FundamentalsService – quality score', () => {
  it('high-ROE low-debt stock gets a higher quality score', async () => {
    // QUALITY: ROE = 100/100 = 1.0, gpToAssets = 80/200 = 0.4, D/E = 10/100 = 0.1
    // JUNK:    ROE = 5/100  = 0.05, gpToAssets = 10/300 = 0.033, D/E = 200/100 = 2.0
    // QUALITY wins on ROE, GP/Assets, and low leverage → higher qualityScore.

    const corpMap = new Map([['QUALITY', 'CC_QUAL'], ['JUNK', 'CC_JUNK']]);
    const finData: Record<string, DartFinancials> = {
      CC_QUAL: {
        corpCode: 'CC_QUAL', year: 2024,
        netIncome: 100, totalEquity: 100,
        grossProfit: 80, totalAssets: 200, totalLiabilities: 10,
      },
      CC_JUNK: {
        corpCode: 'CC_JUNK', year: 2024,
        netIncome: 5, totalEquity: 100,
        grossProfit: 10, totalAssets: 300, totalLiabilities: 200,
      },
    };

    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => finData[corpCode] ?? null,
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    const entries: MarketCapEntry[] = [
      { symbol: 'QUALITY', marketCap: 5_000 },
      { symbol: 'JUNK',    marketCap: 5_000 },
    ];

    const result = await svc.compute(entries);

    expect(result.quality.has('QUALITY')).toBe(true);
    expect(result.quality.has('JUNK')).toBe(true);
    expect(result.quality.get('QUALITY')!).toBeGreaterThan(result.quality.get('JUNK')!);
  });
});

// ---------------------------------------------------------------------------
// describe: no-data neutrality
// ---------------------------------------------------------------------------

describe('FundamentalsService – no-data neutrality', () => {
  it('a symbol with no corp code appears in both maps with score 0', async () => {
    // NODATA has no corp code → financials never fetched → neutral (0) scores.

    const corpMap = new Map<string, string>(); // empty — NODATA not mapped
    const dart = makeDartClient({
      corpMap,
      financialsFor: async () => null,
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    const entries: MarketCapEntry[] = [{ symbol: 'NODATA', marketCap: 5_000 }];

    const result = await svc.compute(entries);

    expect(result.value.has('NODATA')).toBe(true);
    expect(result.value.get('NODATA')).toBe(0);
    expect(result.quality.has('NODATA')).toBe(true);
    expect(result.quality.get('NODATA')).toBe(0);
  });

  it('a symbol whose financials fetch throws still appears with score 0', async () => {
    const corpMap = new Map([['ERRSYM', 'CC_ERR']]);
    const dart = makeDartClient({
      corpMap,
      financialsFor: async () => { throw new Error('DART upstream error'); },
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    const result = await svc.compute([{ symbol: 'ERRSYM', marketCap: 1_000 }]);

    expect(result.value.has('ERRSYM')).toBe(true);
    expect(result.value.get('ERRSYM')).toBe(0);
    expect(result.quality.has('ERRSYM')).toBe(true);
    expect(result.quality.get('ERRSYM')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: year → year-1 fallback
// ---------------------------------------------------------------------------

describe('FundamentalsService – year-1 fallback', () => {
  it('retries with year-1 when financials(year) returns null', async () => {
    const calls: Array<{ corpCode: string; year: number }> = [];
    const corpMap = new Map([['SYM', 'CC_SYM']]);

    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode: string, year: number) => {
        calls.push({ corpCode, year });
        if (year === 2024) return null; // no annual report yet
        // year-1 (2023) has data
        return {
          corpCode, year,
          netIncome: 100, totalEquity: 500,
          grossProfit: 80, totalAssets: 1_000, totalLiabilities: 100,
        };
      },
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    await svc.compute([{ symbol: 'SYM', marketCap: 10_000 }]);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ corpCode: 'CC_SYM', year: 2024 });
    expect(calls[1]).toEqual({ corpCode: 'CC_SYM', year: 2023 });
  });

  it('does NOT retry year-1 when financials(year) returns valid data', async () => {
    const calls: Array<{ corpCode: string; year: number }> = [];
    const corpMap = new Map([['SYM', 'CC_SYM']]);

    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode: string, year: number) => {
        calls.push({ corpCode, year });
        return { corpCode, year, netIncome: 50, totalEquity: 200, grossProfit: 30, totalAssets: 400, totalLiabilities: 50 };
      },
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    await svc.compute([{ symbol: 'SYM', marketCap: 5_000 }]);

    // Only one call for the primary year
    expect(calls).toHaveLength(1);
    expect(calls[0]?.year).toBe(2024);
  });
});

// ---------------------------------------------------------------------------
// describe: full coverage
// ---------------------------------------------------------------------------

describe('FundamentalsService – map coverage', () => {
  it('both maps cover every input symbol including ones with no financial data', async () => {
    const corpMap = new Map([['HAS_DATA', 'CC_HD']]);
    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => {
        if (corpCode === 'CC_HD') {
          return { corpCode, year: 2024, netIncome: 50, totalEquity: 200, grossProfit: 30, totalAssets: 400, totalLiabilities: 50 };
        }
        return null;
      },
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    const entries: MarketCapEntry[] = [
      { symbol: 'HAS_DATA',  marketCap: 5_000 },
      { symbol: 'NO_CORP',   marketCap: 3_000 }, // not in corpMap
      { symbol: 'ZERO_MCAP', marketCap: 0 },     // marketCap=0 → value sub-metrics skipped
    ];

    const result = await svc.compute(entries);

    for (const e of entries) {
      expect(result.value.has(e.symbol)).toBe(true);
      expect(result.quality.has(e.symbol)).toBe(true);
    }
  });

  it('a symbol with marketCap=0 gets value=0 (division by zero guard)', async () => {
    const corpMap = new Map([['ZERO', 'CC_ZERO']]);
    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => ({
        corpCode, year: 2024,
        netIncome: 100, totalEquity: 500, grossProfit: 80, totalAssets: 800, totalLiabilities: 100,
      }),
    });

    const svc = new FundamentalsService({ dart, year: 2024 });
    const result = await svc.compute([{ symbol: 'ZERO', marketCap: 0 }]);

    // EY = netIncome/0 → skipped; B/M = totalEquity/0 → skipped
    // Neither value sub-metric present → valueScore = 0
    expect(result.value.get('ZERO')).toBe(0);
    // Quality sub-metrics don't depend on marketCap → may be non-zero IF only 1 symbol
    // (zscore of single value returns 0), so qualityScore = 0
    expect(result.quality.get('ZERO')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// describe: TTL cache + in-flight dedup
// ---------------------------------------------------------------------------

describe('FundamentalsService – caching', () => {
  it('does not refetch from DART within TTL', async () => {
    let fetchCount = 0;
    const corpMap = new Map([['SYM', 'CC_SYM']]);
    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => {
        fetchCount++;
        return { corpCode, year: 2024, netIncome: 10, totalEquity: 100, grossProfit: 8, totalAssets: 200, totalLiabilities: 20 };
      },
    });

    let now = 0;
    const svc = new FundamentalsService({ dart, year: 2024, now: () => now, ttlMs: 60_000 });
    const entries: MarketCapEntry[] = [{ symbol: 'SYM', marketCap: 1_000 }];

    await svc.compute(entries);
    const countAfterFirst = fetchCount;

    // Within TTL: no new fetch
    now = 59_999;
    await svc.compute(entries);
    expect(fetchCount).toBe(countAfterFirst);
  });

  it('refetches after TTL expires', async () => {
    let fetchCount = 0;
    const corpMap = new Map([['SYM', 'CC_SYM']]);
    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => {
        fetchCount++;
        return { corpCode, year: 2024, netIncome: 10, totalEquity: 100, grossProfit: 8, totalAssets: 200, totalLiabilities: 20 };
      },
    });

    let now = 0;
    const svc = new FundamentalsService({ dart, year: 2024, now: () => now, ttlMs: 60_000 });
    const entries: MarketCapEntry[] = [{ symbol: 'SYM', marketCap: 1_000 }];

    await svc.compute(entries);
    const countAfterFirst = fetchCount;

    // Past TTL: must refetch
    now = 60_001;
    await svc.compute(entries);
    expect(fetchCount).toBeGreaterThan(countAfterFirst);
  });

  it('concurrent compute() calls join the single in-flight request', async () => {
    let fetchCount = 0;
    const corpMap = new Map([['SYM', 'CC_SYM']]);
    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => {
        fetchCount++;
        // Simulate async work
        await Promise.resolve();
        return { corpCode, year: 2024, netIncome: 10, totalEquity: 100, grossProfit: 8, totalAssets: 200, totalLiabilities: 20 };
      },
    });

    const svc = new FundamentalsService({ dart, year: 2024, now: () => 0, ttlMs: 60_000 });
    const entries: MarketCapEntry[] = [{ symbol: 'SYM', marketCap: 1_000 }];

    // Fire 3 concurrent calls
    const [r1, r2, r3] = await Promise.all([
      svc.compute(entries),
      svc.compute(entries),
      svc.compute(entries),
    ]);

    // All 3 should return the same result (deep equality), but DART was only fetched once.
    // Note: projectEntries produces new Map objects on each call, so reference equality
    // (toBe) no longer holds — use toEqual to verify structural equivalence.
    expect(fetchCount).toBe(1); // corpCodeMap + financials each called once
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  it('I2: cache hit with superset entries fills missing symbols with neutral scores', async () => {
    // Prime cache with symbols A + B only.
    // Then call compute() with A + B + C (C absent from corpMap → not in cache).
    // projectEntries must return C with value=0, quality=0 rather than omitting it.
    const corpMap = new Map([
      ['A', 'CC_A'],
      ['B', 'CC_B'],
      // C intentionally absent from corpMap so financials fetch is skipped → C gets 0 scores
    ]);
    const dart = makeDartClient({
      corpMap,
      financialsFor: async (corpCode) => {
        if (corpCode === 'CC_A') return { corpCode, year: 2024, netIncome: 50, totalEquity: 200, grossProfit: 30, totalAssets: 400, totalLiabilities: 80 };
        if (corpCode === 'CC_B') return { corpCode, year: 2024, netIncome: 10, totalEquity:  50, grossProfit:  8, totalAssets: 100, totalLiabilities: 30 };
        return null;
      },
    });

    let now = 0;
    const svc = new FundamentalsService({ dart, year: 2024, now: () => now, ttlMs: 60_000 });

    // First call: prime cache with A + B
    await svc.compute([
      { symbol: 'A', marketCap: 1_000 },
      { symbol: 'B', marketCap:   500 },
    ]);

    // Still within TTL — second call with superset A + B + C hits the cache.
    now = 30_000;
    const result = await svc.compute([
      { symbol: 'A', marketCap: 1_000 },
      { symbol: 'B', marketCap:   500 },
      { symbol: 'C', marketCap: 2_000 },
    ]);

    // C was not in the original cache → projectEntries must fill it with 0.
    expect(result.value.has('C')).toBe(true);
    expect(result.value.get('C')).toBe(0);
    expect(result.quality.has('C')).toBe(true);
    expect(result.quality.get('C')).toBe(0);

    // A and B should still be present (non-zero, since they had financials data).
    expect(result.value.has('A')).toBe(true);
    expect(result.value.has('B')).toBe(true);
  });
});
