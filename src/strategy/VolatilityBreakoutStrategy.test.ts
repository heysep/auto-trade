import { describe, it, expect } from 'vitest';
import { VolatilityBreakoutStrategy } from './VolatilityBreakoutStrategy.js';
import type { Quote, Position } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Quote with an exact KST clock time. */
function makeQuote(last: number, dateStr: string, hhmm: string): Quote {
  return {
    symbol: 'A005930',
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

/** Fake range: target = 100 + 0.5 * (110 - 90) = 110 */
const fakeRange = async (_: string) => ({ prevHigh: 110, prevLow: 90, todayOpen: 100 });

/** Factory with sensible defaults — override individual fields via second arg. */
function makeStrategy(overrides: Partial<{
  k: number;
  budget: number;
  getDailyRange: (s: string) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
}> = {}) {
  return new VolatilityBreakoutStrategy({
    id: 1,
    symbol: 'A005930',
    currency: 'KRW',
    mode: 'PAPER',
    k: 0.5,
    budget: 100_000,
    getDailyRange: fakeRange,
    ...overrides,
  });
}

/** Minimal held position helper. */
const heldPos = (qty: number): Position => ({
  strategyId: 1,
  symbol: 'A005930',
  mode: 'PAPER',
  quantity: qty,
  avgPrice: 110,
  realizedPnl: 0,
});

// ---------------------------------------------------------------------------
// Tests
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
    it('ignores ticks with ts <= lastSeenTs', async () => {
      const s = makeStrategy();
      const q = makeQuote(90, DATE, '10:00');
      s.evaluate({ quote: q, position: undefined });
      await Promise.resolve();
      // Same ts again — must be ignored (no state advance, definitely no BUY even if above target)
      const sameTs: Quote = { ...q, last: 999 };
      expect(s.evaluate({ quote: sameTs, position: undefined })).toBeNull();
    });
  });
});
