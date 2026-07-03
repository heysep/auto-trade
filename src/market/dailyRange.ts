import type { TossCandle } from '../toss/types.js';

export type DailyRange = { prevHigh: number; prevLow: number; todayOpen: number };

/**
 * Factory that builds a per-provider daily-range lookup backed by Toss 1d candles.
 *
 * Cache key: `${symbol}:${kstDate}` so the value persists for the full KST trading day.
 * In-flight dedup: concurrent callers for the same key share one pending fetch.
 *
 * Algorithm:
 *   1. Fetch the 3 most recent daily candles.
 *   2. Sort ascending by timestamp.
 *   3. Find the candle whose KST date matches today.
 *   4. The candle immediately before it supplies prevHigh / prevLow.
 *   5. NaN / no-today candle / missing prev → undefined (holiday / data gap).
 */
export function makeDailyRangeProvider(
  getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>,
  now?: () => number,
): (symbol: string) => Promise<DailyRange | undefined> {
  // Wrapper object distinguishes "cached undefined (holiday)" from "not yet cached"
  // because Map.get() returns undefined for both missing keys and undefined values.
  const resolved = new Map<string, { value: DailyRange | undefined }>();
  const pending = new Map<string, Promise<DailyRange | undefined>>();
  const getNow = now ?? Date.now;

  return (symbol: string): Promise<DailyRange | undefined> => {
    const nowMs = getNow();
    // KST = UTC + 9 h; slice the ISO date portion for a YYYY-MM-DD key
    const kstDate = new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
    const key = `${symbol}:${kstDate}`;

    // Cache hit (value may be undefined for holidays — still a valid cached result)
    const hit = resolved.get(key);
    if (hit !== undefined) return Promise.resolve(hit.value);

    // In-flight dedup — join the pending promise rather than starting a second fetch
    const inflight = pending.get(key);
    if (inflight !== undefined) return inflight;

    // Start a new fetch; errors map to undefined (holiday / data gap) so the caller
    // never needs to handle a rejected promise.
    const p = (async (): Promise<DailyRange | undefined> => {
      try {
        const candles = await getCandles(symbol, '1d', 3);

        // Sort ascending by timestamp so the "prev" candle is always at index [todayIdx-1]
        const sorted = [...candles].sort(
          (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        );

        // Locate today's KST-date candle
        let todayIdx = -1;
        for (let i = 0; i < sorted.length; i++) {
          const c = sorted[i]!;
          const cKstDate = new Date(Date.parse(c.timestamp) + 9 * 3_600_000)
            .toISOString()
            .slice(0, 10);
          if (cKstDate === kstDate) { todayIdx = i; break; }
        }

        // Need today's candle AND at least one candle before it
        if (todayIdx < 1) return undefined;

        const today = sorted[todayIdx]!;
        const prev  = sorted[todayIdx - 1]!;

        const todayOpen = Number(today.openPrice);
        const prevHigh  = Number(prev.highPrice);
        const prevLow   = Number(prev.lowPrice);

        // Guard malformed string fields (NaN, Infinity)
        if (!Number.isFinite(todayOpen) || !Number.isFinite(prevHigh) || !Number.isFinite(prevLow)) {
          return undefined;
        }

        return { prevHigh, prevLow, todayOpen };
      } catch {
        // Network/parse errors → treat as no-data day; the strategy stays flat
        return undefined;
      }
    })().then((result) => {
      // Cache the resolved value (including undefined for holidays) and clear inflight entry
      resolved.set(key, { value: result });
      pending.delete(key);
      return result;
    });

    pending.set(key, p);
    return p;
  };
}
