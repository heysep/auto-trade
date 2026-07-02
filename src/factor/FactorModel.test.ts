import { describe, it, expect } from 'vitest';
import { FactorModel, DEFAULT_WEIGHTS, DEFAULT_PERIODS } from './FactorModel.js';
import type { UniverseEntry, Fundamentals, FactorPeriods, FactorWeights } from './FactorModel.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a price series of `length` bars where each day's price = start * (1 + dailyReturn)^i.
 * Oldest bar first (index 0).
 */
function buildPrices(start: number, dailyReturn: number, length: number): number[] {
  const prices: number[] = [];
  for (let i = 0; i < length; i++) {
    prices.push(start * Math.pow(1 + dailyReturn, i));
  }
  return prices;
}

/**
 * Small periods so tests don't need hundreds of bars.
 * momSkip=1, momLong=3, momMid=2, volWindow=3, mddWindow=3
 * → need n > 3 (momLong) → at least 4 prices.
 */
const SMALL: FactorPeriods = {
  momSkip: 1,
  momLong: 3,
  momMid: 2,
  volWindow: 3,
  mddWindow: 3,
};

const WEIGHTS: FactorWeights = DEFAULT_WEIGHTS;

// ── Test universe design ──────────────────────────────────────────────────────
//
// Symbol A: strongly rising (+5%/day), flat vol (same price series → very low vol)
// Symbol B: strongly falling (−5%/day), high vol
// Symbol C: mildly rising (+1%/day), low vol — middle ground
//
// All same sector to keep sector-neutralization simple.

const N = 5; // bars — satisfies n > momLong=3

const entryA: UniverseEntry = {
  symbol: 'A',
  sector: 'Tech',
  prices: buildPrices(100, 0.05, N),
};
const entryB: UniverseEntry = {
  symbol: 'B',
  sector: 'Tech',
  prices: buildPrices(100, -0.05, N),
};
const entryC: UniverseEntry = {
  symbol: 'C',
  sector: 'Tech',
  prices: buildPrices(100, 0.01, N),
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('FactorModel.score — no fundamentals (momentum + defensive only)', () => {
  const model = new FactorModel(WEIGHTS, SMALL);

  it('rising/low-vol symbol ranks above falling/high-vol symbol', () => {
    const results = model.score([entryA, entryB, entryC]);
    const ranked = Object.fromEntries(results.map((r) => [r.symbol, r.rank]));
    // A: best momentum (+), best defensive (low vol) → rank 1
    // B: worst momentum (−), worst defensive (high vol) → rank 3
    expect(ranked['A']).toBe(1);
    expect(ranked['B']).toBe(3);
  });

  it('value and quality factors are absent when no fundamentals given', () => {
    const results = model.score([entryA, entryB, entryC]);
    for (const r of results) {
      expect(r.factors.value).toBeUndefined();
      expect(r.factors.quality).toBeUndefined();
      expect(r.factors.momentum).toBeDefined();
      expect(r.factors.defensive).toBeDefined();
    }
  });

  it('ranks are 1..n contiguous', () => {
    const results = model.score([entryA, entryB, entryC]);
    const ranks = results.map((r) => r.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3]);
  });

  it('results are sorted by composite DESC', () => {
    const results = model.score([entryA, entryB, entryC]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.composite).toBeGreaterThanOrEqual(results[i]!.composite);
    }
  });

  it('uses only momentum + defensive weights (renormalized) when no fundamentals', () => {
    // With weights {momentum:0.30, defensive:0.15} and no value/quality,
    // normalized weights are 0.30/(0.30+0.15)=0.667 and 0.15/0.45=0.333.
    // The composite of the top-ranked symbol should differ from 0.
    const results = model.score([entryA, entryB, entryC]);
    const top = results[0];
    expect(top).toBeDefined();
    expect(top!.composite).not.toBeCloseTo(0);
  });
});

describe('FactorModel.score — with fundamentals (value + quality)', () => {
  const model = new FactorModel(WEIGHTS, SMALL);

  it('value and quality factors appear in factors when fundamentals cover all symbols', () => {
    const fundamentals: Fundamentals = {
      value: new Map([['A', 10], ['B', 5], ['C', 7]]),
      quality: new Map([['A', 8], ['B', 3], ['C', 6]]),
    };
    const results = model.score([entryA, entryB, entryC], fundamentals);
    for (const r of results) {
      expect(r.factors.value).toBeDefined();
      expect(r.factors.quality).toBeDefined();
    }
  });

  it('fundamentals that favor the same symbol reinforce its rank', () => {
    // Give A the highest value and quality too — it should still rank 1
    const fundamentals: Fundamentals = {
      value: new Map([['A', 100], ['B', 1], ['C', 50]]),
      quality: new Map([['A', 100], ['B', 1], ['C', 50]]),
    };
    const results = model.score([entryA, entryB, entryC], fundamentals);
    const ranked = Object.fromEntries(results.map((r) => [r.symbol, r.rank]));
    expect(ranked['A']).toBe(1);
    expect(ranked['B']).toBe(3);
  });

  it('value factor absent when fundamentals.value does not cover all symbols', () => {
    // Only covers A and C — B is missing
    const fundamentals: Fundamentals = {
      value: new Map([['A', 10], ['C', 7]]),
    };
    const results = model.score([entryA, entryB, entryC], fundamentals);
    for (const r of results) {
      expect(r.factors.value).toBeUndefined();
    }
  });

  it('quality factor absent when fundamentals.quality does not cover all symbols', () => {
    const fundamentals: Fundamentals = {
      quality: new Map([['A', 8], ['C', 6]]),
    };
    const results = model.score([entryA, entryB, entryC], fundamentals);
    for (const r of results) {
      expect(r.factors.quality).toBeUndefined();
    }
  });
});

describe('FactorModel.score — too-short history', () => {
  const model = new FactorModel(WEIGHTS, SMALL);

  it('entries with too-short price history are dropped from results', () => {
    const shortEntry: UniverseEntry = {
      symbol: 'SHORT',
      sector: 'Tech',
      prices: [100, 110], // only 2 bars; needs n > 3
    };
    const results = model.score([entryA, entryB, entryC, shortEntry]);
    const symbols = results.map((r) => r.symbol);
    expect(symbols).not.toContain('SHORT');
    expect(symbols).toHaveLength(3);
  });

  it('returns composite=0 and rank by symbol when <2 scorable entries', () => {
    const shortA: UniverseEntry = { symbol: 'X', sector: 'Tech', prices: [100, 110] };
    const shortB: UniverseEntry = { symbol: 'Y', sector: 'Tech', prices: [100, 110] };
    const results = model.score([shortA, shortB]);
    // Both drop out → <2 scorable → should return 0 entries (both dropped)
    expect(results).toHaveLength(0);
  });

  it('returns single entry with composite=0 rank=1 when exactly 1 scorable', () => {
    const shortEntry: UniverseEntry = {
      symbol: 'SHORT',
      sector: 'Tech',
      prices: [100, 110],
    };
    const results = model.score([entryA, shortEntry]);
    // Only entryA is scorable (SHORT too short)
    // 1 scorable < 2 → composite=0, rank=1
    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe('A');
    expect(results[0]!.composite).toBe(0);
    expect(results[0]!.rank).toBe(1);
  });

  it('returns empty array when universe is empty', () => {
    const results = model.score([]);
    expect(results).toHaveLength(0);
  });
});

describe('FactorModel.score — multi-sector universe', () => {
  const model = new FactorModel(WEIGHTS, SMALL);

  it('sector neutralization applies per sector', () => {
    const entryFinA: UniverseEntry = { symbol: 'FA', sector: 'Finance', prices: buildPrices(100, 0.05, N) };
    const entryFinB: UniverseEntry = { symbol: 'FB', sector: 'Finance', prices: buildPrices(100, -0.05, N) };
    const entryTechA: UniverseEntry = { symbol: 'TA', sector: 'Tech', prices: buildPrices(100, 0.03, N) };
    const entryTechB: UniverseEntry = { symbol: 'TB', sector: 'Tech', prices: buildPrices(100, -0.02, N) };

    const results = model.score([entryFinA, entryFinB, entryTechA, entryTechB]);
    expect(results).toHaveLength(4);
    const ranks = results.map((r) => r.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4]);
  });
});

// ── NEW: defensive drawdown sign regression test ──────────────────────────────
describe('FactorModel.score — defensive factor: shallower MDD scores higher', () => {
  // Custom periods: volWindow=2 (only last 2 returns) keeps vol window
  // out of the mid-series trough; mddWindow=5 captures the trough.
  // momLong=5, momMid=3 → needs n > 5, so we use n=8.
  const DEF_PERIODS: FactorPeriods = {
    momSkip: 1,
    momLong: 5,
    momMid: 3,
    volWindow: 2,
    mddWindow: 5,
  };

  // All three share prices[5..7] = [121, 122, 123] → identical last-2 returns → same vol.
  // Different troughs at prices[4] give clearly different MDD values:
  //   SHALLOW: prices[4]=120 → mdd window [115,120,121,122,123] → mdd ≈ 0
  //   NEUTRAL: prices[4]= 90 → mdd window [115, 90,121,122,123] → mdd ≈ −21.7%
  //   DEEP:    prices[4]= 60 → mdd window [115, 60,121,122,123] → mdd ≈ −47.8%
  //
  // With n=2 symbols, winsorize clips both values to the minimum, collapsing z-scores
  // to 0. Three symbols ensures distinct z-scores so the sign bug is observable.
  const SHALLOW_PRICES = [100, 105, 110, 115, 120, 121, 122, 123];
  const NEUTRAL_PRICES = [100, 105, 110, 115,  90, 121, 122, 123];
  const DEEP_PRICES    = [100, 105, 110, 115,  60, 121, 122, 123];

  const shallowEntry: UniverseEntry = { symbol: 'SHALLOW', sector: 'TEST', prices: SHALLOW_PRICES };
  const neutralEntry: UniverseEntry = { symbol: 'NEUTRAL', sector: 'TEST', prices: NEUTRAL_PRICES };
  const deepEntry: UniverseEntry    = { symbol: 'DEEP',    sector: 'TEST', prices: DEEP_PRICES    };

  it('shallower-drawdown symbol has a higher defensive score than deeper-drawdown symbol', () => {
    const model = new FactorModel(DEFAULT_WEIGHTS, DEF_PERIODS);
    const results = model.score([shallowEntry, neutralEntry, deepEntry]);

    const shallow = results.find((r) => r.symbol === 'SHALLOW');
    const deep    = results.find((r) => r.symbol === 'DEEP');

    expect(shallow).toBeDefined();
    expect(deep).toBeDefined();
    expect(shallow!.factors.defensive).toBeDefined();
    expect(deep!.factors.defensive).toBeDefined();

    // Shallower MDD (≈ 0) must score strictly higher than deeper MDD (≈ −48%).
    // FAILS before fix (bug rewards deep drawdowns, scoring SHALLOW < DEEP).
    // PASSES after fix (drop −zm → +zm correctly rewards shallow drawdowns).
    expect(shallow!.factors.defensive).toBeGreaterThan(deep!.factors.defensive!);
  });
});

describe('FactorModel constructor defaults', () => {
  it('accepts no arguments and uses defaults', () => {
    const model = new FactorModel();
    // Just verify it doesn't throw and returns something with a long enough series
    const entry: UniverseEntry = {
      symbol: 'X',
      sector: 'S',
      prices: buildPrices(100, 0.001, 260), // > 252
    };
    const entry2: UniverseEntry = {
      symbol: 'Y',
      sector: 'S',
      prices: buildPrices(100, -0.001, 260),
    };
    const results = model.score([entry, entry2]);
    expect(results).toHaveLength(2);
    expect(results[0]!.rank).toBe(1);
    expect(results[1]!.rank).toBe(2);
  });

  it('DEFAULT_WEIGHTS sum to 1', () => {
    const sum = DEFAULT_WEIGHTS.value + DEFAULT_WEIGHTS.momentum + DEFAULT_WEIGHTS.quality + DEFAULT_WEIGHTS.defensive;
    expect(sum).toBeCloseTo(1.0);
  });

  it('DEFAULT_PERIODS has expected values', () => {
    expect(DEFAULT_PERIODS.momSkip).toBe(21);
    expect(DEFAULT_PERIODS.momLong).toBe(252);
    expect(DEFAULT_PERIODS.momMid).toBe(126);
    expect(DEFAULT_PERIODS.volWindow).toBe(252);
    expect(DEFAULT_PERIODS.mddWindow).toBe(252);
  });
});
