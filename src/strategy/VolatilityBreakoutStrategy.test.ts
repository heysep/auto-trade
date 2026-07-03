import { describe, it, expect } from 'vitest';
import { VolatilityBreakoutStrategy } from './VolatilityBreakoutStrategy.js';
import type { Quote, Position } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Quote with an exact KST clock time. */
function makeQuote(last: number, dateStr: string, hhmm: string, symbol = 'A005930'): Quote {
  return {
    symbol,
    currency: 'KRW',
    bid: last,
    ask: last,
    last,
    ts: Date.parse(`${dateStr}T${hhmm}:00+09:00`),
  };
}

/** A non-weekend KRX trading day. */
const DATE = '2026-07-03';
const NEXT_DATE = '2026-07-04'; // next trading day (for day-reset tests)

/** Fake range for the default symbol: target = 100 + 0.5 * (110 - 90) = 110 */
const fakeRange = async (_: string) => ({ prevHigh: 110, prevLow: 90, todayOpen: 100 });

/** Factory with sensible defaults — single-symbol mode (backward-compat tests). */
function makeStrategy(overrides: Partial<{
  k: number;
  budget: number;
  getDailyRange: (s: string) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
}> = {}) {
  return new VolatilityBreakoutStrategy({
    id: 1,
    symbols: ['A005930'],
    currency: 'KRW',
    mode: 'PAPER',
    k: 0.5,
    budget: 100_000,
    getDailyRange: fakeRange,
    ...overrides,
  });
}

/** Multi-symbol factory: each symbol in `syms` gets the same range provider. */
function makeMultiStrategy(
  syms: string[],
  opts: {
    k?: number;
    budget?: number;
    minRangePct?: number;
    getDailyRange?: (s: string) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
  } = {},
) {
  return new VolatilityBreakoutStrategy({
    id: 1,
    symbols: syms,
    currency: 'KRW',
    mode: 'PAPER',
    k: opts.k ?? 0.5,
    budget: opts.budget ?? 1_000_000,
    ...(opts.minRangePct !== undefined ? { minRangePct: opts.minRangePct } : {}),
    getDailyRange: opts.getDailyRange ?? (async () => ({ prevHigh: 110, prevLow: 90, todayOpen: 100 })),
  });
}

/** Make a raw quote for a given symbol at an explicit ts. */
function rawQuote(sym: string, last: number, ts: number): Quote {
  return { symbol: sym, currency: 'KRW', bid: last, ask: last, last, ts };
}

/** Minimal held position helper. */
const heldPos = (qty: number, symbol = 'A005930'): Position => ({
  strategyId: 1,
  symbol,
  mode: 'PAPER',
  quantity: qty,
  avgPrice: 110,
  realizedPnl: 0,
});

// ---------------------------------------------------------------------------
// Tests — existing single-symbol behaviors (now using symbols: [...])
// ---------------------------------------------------------------------------

describe('VolatilityBreakoutStrategy', () => {
  describe('entry', () => {
    it('returns null for ticks below target inside the entry window', async () => {
      const s = makeStrategy();
      // First tick: kicks fetch
      s.evaluate({ quote: makeQuote(109, DATE, '10:00'), position: undefined });
      await Promise.resolve(); // flush microtask
      // 109 < 110 (target) → no entry
      expect(s.evaluate({ quote: makeQuote(109, DATE, '10:01'), position: undefined })).toBeNull();
    });

    it('BUYs floor(budget/price) shares on first tick at or above target inside entry window', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // price=110 → qty = floor(100_000 / 110) = 909
      const intent = s.evaluate({ quote: makeQuote(110, DATE, '10:01'), position: undefined });
      expect(intent).not.toBeNull();
      expect(intent!.side).toBe('BUY');
      expect(intent!.quantity).toBe(909);
      expect(intent!.orderType).toBe('MARKET');
      expect(intent!.reason).toBe('volatility breakout');
    });

    it('returns null on a second crossing tick (one entry per day)', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // First crossing → BUY
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Second crossing → null
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '10:02'), position: undefined });
      expect(intent).toBeNull();
    });

    it('does NOT enter before the entry window (08:50 KST < 09:05)', async () => {
      const s = makeStrategy();
      // 08:50 tick kicks fetch
      s.evaluate({ quote: makeQuote(90, DATE, '08:50'), position: undefined });
      await Promise.resolve();
      // Still 08:50 range — price above target but before window
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '08:50'), position: undefined });
      expect(intent).toBeNull();
    });

    it('does NOT enter after the entry window (14:40 KST > 14:30 default entryEndMin)', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // 14:40 is after default entryEndMin=14:30
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '14:40'), position: undefined });
      expect(intent).toBeNull();
    });

    it('does NOT enter when budget is smaller than price (qty would be 0)', async () => {
      const s = makeStrategy({ budget: 100 }); // floor(100/110) = 0
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      const intent = s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      expect(intent).toBeNull();
    });

    it('stays flat all day when getDailyRange returns undefined', async () => {
      const s = makeStrategy({ getDailyRange: async () => undefined });
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // Even far above any realistic target
      const intent = s.evaluate({ quote: makeQuote(999, DATE, '10:01'), position: undefined });
      expect(intent).toBeNull();
    });
  });

  describe('exit', () => {
    it('SELLs the full position at or after exitMin (15:10 default)', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // Enter at 10:01
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Exit at 15:11 (>= 15:10)
      const intent = s.evaluate({ quote: makeQuote(112, DATE, '15:11'), position: heldPos(909) });
      expect(intent).not.toBeNull();
      expect(intent!.side).toBe('SELL');
      expect(intent!.quantity).toBe(909);
      expect(intent!.orderType).toBe('MARKET');
      expect(intent!.reason).toBe('end-of-day liquidation');
    });

    it('does NOT re-enter after the end-of-day exit on the same day', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Trigger exit
      s.evaluate({ quote: makeQuote(112, DATE, '15:11'), position: heldPos(909) });
      // Attempt re-entry later same day (position now flat, price above target)
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '15:15'), position: undefined });
      expect(intent).toBeNull();
    });
  });

  describe('day reset', () => {
    it('resets day state on a new KST date and allows a fresh entry', async () => {
      const s = makeStrategy();
      // Day 1: enter
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Day 2: new date key — should reset
      s.evaluate({ quote: makeQuote(90, NEXT_DATE, '10:00'), position: undefined });
      await Promise.resolve();
      const intent = s.evaluate({ quote: makeQuote(115, NEXT_DATE, '10:01'), position: undefined });
      expect(intent?.side).toBe('BUY');
    });
  });

  describe('async range fetch', () => {
    it('returns null on the very first tick (fetch not yet resolved), then enters once resolved', async () => {
      let resolve!: (val: { prevHigh: number; prevLow: number; todayOpen: number }) => void;
      const p = new Promise<{ prevHigh: number; prevLow: number; todayOpen: number }>((res) => {
        resolve = res;
      });
      const s = makeStrategy({ getDailyRange: () => p });

      // First tick of the day — kicks the fetch but result not yet available
      const first = s.evaluate({ quote: makeQuote(120, DATE, '10:00'), position: undefined });
      expect(first).toBeNull();

      // Resolve the range (target = 100 + 0.5 * 20 = 110)
      resolve({ prevHigh: 110, prevLow: 90, todayOpen: 100 });
      await Promise.resolve(); // flush the .then() microtask

      // Now a tick above target should BUY
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '10:01'), position: undefined });
      expect(intent?.side).toBe('BUY');
    });
  });

  describe('serialize/deserialize', () => {
    it('round-trips day key, enteredToday, and target so mid-day restarts work', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // Enter to lock enteredToday = true
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });

      const state = s.serialize!();

      // Restore into a fresh instance
      const s2 = makeStrategy();
      s2.deserialize!(state);

      // Same day — must NOT allow another entry (enteredToday=true was restored)
      const intent = s2.evaluate({ quote: makeQuote(120, DATE, '10:30'), position: undefined });
      expect(intent).toBeNull();
    });
  });

  describe('duplicate / rewound timestamp guard', () => {
    it('ignores ticks with ts <= lastSeenTs for that symbol', async () => {
      const s = makeStrategy();
      const q = makeQuote(90, DATE, '10:00');
      s.evaluate({ quote: q, position: undefined });
      await Promise.resolve();
      // Same ts again — must be ignored (no state advance, definitely no BUY even if above target)
      const sameTs: Quote = { ...q, last: 999 };
      expect(s.evaluate({ quote: sameTs, position: undefined })).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // NEW: Multi-symbol tests
  // ---------------------------------------------------------------------------

  describe('multi-symbol: first-breakout-wins lock', () => {
    it('A breaks out first → BUY A; B and C breaking out later → null (locked)', async () => {
      // Three candidates: A, B, C — same range/target = 110
      const s = makeMultiStrategy(['A', 'B', 'C']);

      // Kick fetches for all three on their first ticks
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'A'), position: undefined });
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'B'), position: undefined });
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'C'), position: undefined });
      await Promise.resolve();

      // A breaks out first
      const intentA = s.evaluate({ quote: makeQuote(115, DATE, '10:01', 'A'), position: undefined });
      expect(intentA?.side).toBe('BUY');
      expect(intentA?.reason).toBe('volatility breakout');

      // B breaks out 1 tick later → locked out
      const intentB = s.evaluate({ quote: makeQuote(115, DATE, '10:02', 'B'), position: undefined });
      expect(intentB).toBeNull();

      // C breaks out → still locked
      const intentC = s.evaluate({ quote: makeQuote(115, DATE, '10:03', 'C'), position: undefined });
      expect(intentC).toBeNull();
    });

    it('after A is bought, its position exits at 15:10; B breaking out same day → still null', async () => {
      const s = makeMultiStrategy(['A', 'B']);

      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'A'), position: undefined });
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'B'), position: undefined });
      await Promise.resolve();

      // A enters
      s.evaluate({ quote: makeQuote(115, DATE, '10:01', 'A'), position: undefined });

      // A exits at 15:11
      const exitIntent = s.evaluate({
        quote: makeQuote(112, DATE, '15:11', 'A'),
        position: heldPos(900, 'A'),
      });
      expect(exitIntent?.side).toBe('SELL');

      // B tries to enter after A exits → still null (day lock: chosenSymbol='A', enteredToday=true)
      const intentB = s.evaluate({ quote: makeQuote(115, DATE, '15:12', 'B'), position: undefined });
      expect(intentB).toBeNull();
    });

    it('next day: day resets, previously-blocked symbol B can be chosen', async () => {
      const s = makeMultiStrategy(['A', 'B']);

      // Day 1: A enters, B is locked
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'A'), position: undefined });
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'B'), position: undefined });
      await Promise.resolve();
      s.evaluate({ quote: makeQuote(115, DATE, '10:01', 'A'), position: undefined });
      const lockedB = s.evaluate({ quote: makeQuote(115, DATE, '10:02', 'B'), position: undefined });
      expect(lockedB).toBeNull();

      // Day 2: reset → B can now be first
      s.evaluate({ quote: makeQuote(90, NEXT_DATE, '10:00', 'B'), position: undefined });
      await Promise.resolve();
      const intentB = s.evaluate({ quote: makeQuote(115, NEXT_DATE, '10:01', 'B'), position: undefined });
      expect(intentB?.side).toBe('BUY');
    });
  });

  describe('multi-symbol: affordability filter', () => {
    it('symbol with todayOpen > budget is ineligible and never enters even when it breaks out', async () => {
      // budget=100_000; A is cheap (todayOpen=100), B is expensive (todayOpen=200_000)
      const ranges: Record<string, { prevHigh: number; prevLow: number; todayOpen: number }> = {
        A: { prevHigh: 110, prevLow: 90, todayOpen: 100 },      // floor(100_000/100)=1000 ≥ 1 → eligible
        B: { prevHigh: 220_000, prevLow: 180_000, todayOpen: 200_000 }, // floor(100_000/200_000)=0 → ineligible
      };
      const s = new VolatilityBreakoutStrategy({
        id: 1,
        symbols: ['A', 'B'],
        currency: 'KRW',
        mode: 'PAPER',
        k: 0.5,
        budget: 100_000,
        getDailyRange: async (sym) => ranges[sym],
      });

      // Kick fetches
      s.evaluate({ quote: rawQuote('A', 90, Date.parse(`${DATE}T10:00:00+09:00`)), position: undefined });
      s.evaluate({ quote: rawQuote('B', 180_000, Date.parse(`${DATE}T10:00:01+09:00`)), position: undefined });
      await Promise.resolve();

      // B breaks out (price > B's target), but it's unaffordable → null
      const intentB = s.evaluate({
        quote: rawQuote('B', 210_000, Date.parse(`${DATE}T10:01:00+09:00`)),
        position: undefined,
      });
      expect(intentB).toBeNull();

      // A can still be chosen
      const intentA = s.evaluate({
        quote: rawQuote('A', 115, Date.parse(`${DATE}T10:01:01+09:00`)),
        position: undefined,
      });
      expect(intentA?.side).toBe('BUY');
    });
  });

  describe('multi-symbol: volatility filter', () => {
    it('symbol with narrow range (< minRangePct) is ineligible; qualifying symbol enters normally', async () => {
      // minRangePct = 0.05 (5%)
      // A: range = (110-90)/100 = 20% ≥ 5% → eligible; target = 100 + 0.5*20 = 110
      // B: range = (101-99)/100 = 2% < 5% → ineligible
      const ranges: Record<string, { prevHigh: number; prevLow: number; todayOpen: number }> = {
        A: { prevHigh: 110, prevLow: 90,  todayOpen: 100 },
        B: { prevHigh: 101, prevLow: 99,  todayOpen: 100 },
      };
      const s = new VolatilityBreakoutStrategy({
        id: 1,
        symbols: ['A', 'B'],
        currency: 'KRW',
        mode: 'PAPER',
        k: 0.5,
        budget: 1_000_000,
        minRangePct: 0.05,
        getDailyRange: async (sym) => ranges[sym],
      });

      s.evaluate({ quote: rawQuote('A', 90, Date.parse(`${DATE}T10:00:00+09:00`)), position: undefined });
      s.evaluate({ quote: rawQuote('B', 99, Date.parse(`${DATE}T10:00:01+09:00`)), position: undefined });
      await Promise.resolve();

      // B breaks out above its narrow range target — but it's ineligible (low volatility)
      const intentB = s.evaluate({
        quote: rawQuote('B', 102, Date.parse(`${DATE}T10:01:00+09:00`)),
        position: undefined,
      });
      expect(intentB).toBeNull();

      // A has enough volatility → chosen
      const intentA = s.evaluate({
        quote: rawQuote('A', 115, Date.parse(`${DATE}T10:01:01+09:00`)),
        position: undefined,
      });
      expect(intentA?.side).toBe('BUY');
    });
  });

  describe('multi-symbol: per-symbol ts guard', () => {
    it('B at an earlier timestamp than A is NOT dropped (uses per-symbol last-seen-ts)', async () => {
      // If the strategy used a GLOBAL lastSeenTs, after processing A at ts=lateTsA,
      // B at ts=earlyTsB (< lateTsA) would be dropped — getDailyRange for B would never be called.
      // With per-symbol tracking, B's own lastSeenTs starts at -Infinity, so it's processed.
      const called = new Set<string>();
      const s = new VolatilityBreakoutStrategy({
        id: 1,
        symbols: ['A', 'B'],
        currency: 'KRW',
        mode: 'PAPER',
        k: 0.5,
        budget: 1_000_000,
        getDailyRange: async (sym) => {
          called.add(sym);
          return { prevHigh: 110, prevLow: 90, todayOpen: 100 };
        },
      });

      const lateTsA = Date.parse(`${DATE}T12:00:00+09:00`);  // 12:00 KST
      const earlyTsB = Date.parse(`${DATE}T09:30:00+09:00`); // 09:30 KST — earlier than A's ts

      // A arrives first, at a late time
      s.evaluate({ quote: rawQuote('A', 90, lateTsA), position: undefined });
      // B arrives with an EARLIER timestamp — would be blocked by global ts guard
      s.evaluate({ quote: rawQuote('B', 90, earlyTsB), position: undefined });
      await Promise.resolve();

      // With per-symbol guard: B's fetch was initiated → called has 'B'
      // With global guard: B was dropped → called missing 'B'
      expect(called.has('A')).toBe(true);
      expect(called.has('B')).toBe(true);
    });

    it('same-symbol duplicate or rewound ticks are still ignored', async () => {
      const s = makeMultiStrategy(['A', 'B']);
      const ts = Date.parse(`${DATE}T10:00:00+09:00`);
      s.evaluate({ quote: rawQuote('A', 90, ts), position: undefined });
      await Promise.resolve();
      // Same ts for A → dropped
      const dup = s.evaluate({ quote: rawQuote('A', 999, ts), position: undefined });
      expect(dup).toBeNull();
      // Earlier ts for A → also dropped
      const rewind = s.evaluate({ quote: rawQuote('A', 999, ts - 1), position: undefined });
      expect(rewind).toBeNull();
    });
  });

  describe('multi-symbol: serialize/deserialize', () => {
    it('round-trip preserves chosenSymbol and the day lock (B still blocked after restore)', async () => {
      const s = makeMultiStrategy(['A', 'B']);

      // Day: A enters
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'A'), position: undefined });
      s.evaluate({ quote: makeQuote(90, DATE, '10:00', 'B'), position: undefined });
      await Promise.resolve();
      s.evaluate({ quote: makeQuote(115, DATE, '10:01', 'A'), position: undefined });

      const state = s.serialize!();

      // Restore into fresh instance
      const s2 = makeMultiStrategy(['A', 'B']);
      s2.deserialize!(state);

      // B must still be blocked (chosenSymbol='A' was restored)
      const intentB = s2.evaluate({ quote: makeQuote(115, DATE, '10:30', 'B'), position: undefined });
      expect(intentB).toBeNull();

      // A must not re-enter either (enteredToday=true restored)
      const intentA = s2.evaluate({ quote: makeQuote(115, DATE, '10:31', 'A'), position: undefined });
      expect(intentA).toBeNull();
    });

    it('round-trip preserves eligibility maps so day-locked ineligible symbols stay ineligible', async () => {
      const ranges: Record<string, { prevHigh: number; prevLow: number; todayOpen: number }> = {
        A: { prevHigh: 110, prevLow: 90,  todayOpen: 100 }, // eligible
        B: { prevHigh: 101, prevLow: 99,  todayOpen: 100 }, // ineligible (low range pct)
      };
      const s = new VolatilityBreakoutStrategy({
        id: 1,
        symbols: ['A', 'B'],
        currency: 'KRW',
        mode: 'PAPER',
        k: 0.5,
        budget: 1_000_000,
        minRangePct: 0.05,
        getDailyRange: async (sym) => ranges[sym],
      });

      s.evaluate({ quote: rawQuote('A', 90, Date.parse(`${DATE}T10:00:00+09:00`)), position: undefined });
      s.evaluate({ quote: rawQuote('B', 99, Date.parse(`${DATE}T10:00:01+09:00`)), position: undefined });
      await Promise.resolve();

      const state = s.serialize!();

      const s2 = new VolatilityBreakoutStrategy({
        id: 1,
        symbols: ['A', 'B'],
        currency: 'KRW',
        mode: 'PAPER',
        k: 0.5,
        budget: 1_000_000,
        minRangePct: 0.05,
        getDailyRange: async (sym) => ranges[sym],
      });
      s2.deserialize!(state);

      // B still ineligible after restore
      const intentB = s2.evaluate({
        quote: rawQuote('B', 102, Date.parse(`${DATE}T10:01:00+09:00`)),
        position: undefined,
      });
      expect(intentB).toBeNull();
    });
  });
});
