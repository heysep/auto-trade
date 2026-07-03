import { describe, it, expect, vi } from 'vitest';
import { makeDailyRangeProvider } from './dailyRange.js';
import type { TossCandle } from '../toss/types.js';

// 2026-07-03 KST = 2026-07-02T15:00:00Z
// "today" in KST is 2026-07-03; "prev" is 2026-07-02
const TODAY_KST = '2026-07-03T09:00:00+09:00'; // KST date = 2026-07-03
const PREV_KST  = '2026-07-02T09:00:00+09:00'; // KST date = 2026-07-02
const OLD_KST   = '2026-07-01T09:00:00+09:00'; // KST date = 2026-07-01

// UTC ms whose KST date is 2026-07-03 (10:00 KST = 01:00 UTC)
const NOW_UTC_MS = Date.parse('2026-07-03T01:00:00Z');

function candle(ts: string, open: string, high: string, low: string): TossCandle {
  return { timestamp: ts, openPrice: open, highPrice: high, lowPrice: low, closePrice: '0' };
}

const PAIR: TossCandle[] = [
  candle(PREV_KST, '900', '950', '880'),
  candle(TODAY_KST, '910', '960', '900'),
];

describe('makeDailyRangeProvider', () => {
  it('returns prevHigh/prevLow/todayOpen when today + prev candles are present', async () => {
    const gc = vi.fn().mockResolvedValue(PAIR);
    const p = makeDailyRangeProvider(gc, () => NOW_UTC_MS);
    expect(await p('011200')).toEqual({ prevHigh: 950, prevLow: 880, todayOpen: 910 });
  });

  it('returns undefined when no candle matches today KST (holiday)', async () => {
    const gc = vi.fn().mockResolvedValue([
      candle(OLD_KST,  '880', '920', '870'),
      candle(PREV_KST, '900', '950', '880'),
    ]);
    const p = makeDailyRangeProvider(gc, () => NOW_UTC_MS);
    expect(await p('011200')).toBeUndefined();
  });

  it('returns undefined when today candle exists but no prior candle (todayIdx === 0)', async () => {
    const gc = vi.fn().mockResolvedValue([candle(TODAY_KST, '910', '960', '900')]);
    const p = makeDailyRangeProvider(gc, () => NOW_UTC_MS);
    expect(await p('011200')).toBeUndefined();
  });

  it('returns undefined when a numeric field is non-finite (NaN string)', async () => {
    const gc = vi.fn().mockResolvedValue([
      candle(PREV_KST, '900', 'bad', '880'),  // highPrice is not a number
      candle(TODAY_KST, '910', '960', '900'),
    ]);
    const p = makeDailyRangeProvider(gc, () => NOW_UTC_MS);
    expect(await p('011200')).toBeUndefined();
  });

  it('caches: second call for same symbol+date does not re-fetch', async () => {
    const gc = vi.fn().mockResolvedValue(PAIR);
    const p = makeDailyRangeProvider(gc, () => NOW_UTC_MS);
    await p('011200');
    await p('011200');
    expect(gc).toHaveBeenCalledTimes(1);
  });

  it('in-flight dedup: concurrent calls share one fetch', async () => {
    let resolve!: (v: TossCandle[]) => void;
    const gc = vi.fn().mockImplementation(
      () => new Promise<TossCandle[]>((r) => { resolve = r; }),
    );
    const provider = makeDailyRangeProvider(gc, () => NOW_UTC_MS);

    // Start two concurrent calls before the first resolves
    const p1 = provider('011200');
    const p2 = provider('011200');

    // Only one fetch should have been initiated
    expect(gc).toHaveBeenCalledTimes(1);

    // Resolve the shared fetch
    resolve(PAIR);
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toEqual({ prevHigh: 950, prevLow: 880, todayOpen: 910 });
    expect(b).toEqual({ prevHigh: 950, prevLow: 880, todayOpen: 910 });
    expect(gc).toHaveBeenCalledTimes(1);
  });

  it('sorts candles ascending so newest-first API responses still work', async () => {
    const gc = vi.fn().mockResolvedValue([
      candle(TODAY_KST, '910', '960', '900'), // newest first
      candle(PREV_KST,  '900', '950', '880'),
    ]);
    const p = makeDailyRangeProvider(gc, () => NOW_UTC_MS);
    expect(await p('011200')).toEqual({ prevHigh: 950, prevLow: 880, todayOpen: 910 });
  });

  it('fetches again when the KST date advances (cache is keyed per day)', async () => {
    // Use a mutable clock so the same provider instance sees a new KST date on the next call.
    let nowMs = NOW_UTC_MS; // 2026-07-03 KST
    const gc = vi.fn().mockResolvedValue(PAIR);
    const p = makeDailyRangeProvider(gc, () => nowMs);

    // Day 1: 2026-07-03 KST
    await p('011200');
    expect(gc).toHaveBeenCalledTimes(1);

    // Advance clock to 2026-07-04 KST (same symbol, different date key → cache miss)
    nowMs = NOW_UTC_MS + 24 * 3_600_000;
    await p('011200');
    expect(gc).toHaveBeenCalledTimes(2); // new KST date → new cache key → refetch
  });
});
