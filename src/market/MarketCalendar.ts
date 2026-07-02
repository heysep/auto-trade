import type { TossMarketCalendar, TossSession } from '../toss/types.js';
import type { Market } from './MarketDataWorker.js';

// ⚠️ Date.parse is correct ONLY if startTime/endTime carry an explicit offset (…Z or +09:00).
// An offset-less ISO string is parsed as host-local time, which on a UTC server shifts a KST
// session by 9h. Verify the live format (probe) before trusting session gating in production.
/** Parse an ISO session into epoch-ms bounds, or null if absent/unparseable. */
export function parseSession(s: TossSession | null | undefined): { start: number; end: number } | null {
  if (!s) return null;
  const start = Date.parse(s.startTime);
  const end = Date.parse(s.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

/** Is `nowMs` within today's REGULAR session? (pre/after-market excluded by design.) */
export function isRegularOpen(cal: TossMarketCalendar, nowMs: number): boolean {
  const sess = parseSession(cal.today?.integrated?.regularMarket);
  return sess !== null && nowMs >= sess.start && nowMs <= sess.end;
}

export interface MarketCalendarDeps {
  fetchCalendar: (market: Market) => Promise<TossMarketCalendar>;
  now?: () => number;
  /** Re-fetch a market's calendar at most this often (default 1h). */
  cacheMs?: number;
}

/**
 * Caches the per-market calendar (rate limit is 3/s) and answers isMarketOpen().
 * MarketDataWorker uses this as its session gate instead of a naive always-open stub.
 */
export class MarketCalendarService {
  private readonly now: () => number;
  private readonly cacheMs: number;
  private cache = new Map<Market, { cal: TossMarketCalendar; fetchedAt: number }>();

  constructor(private readonly deps: MarketCalendarDeps) {
    this.now = deps.now ?? Date.now;
    this.cacheMs = deps.cacheMs ?? 60 * 60_000;
  }

  async isMarketOpen(market: Market): Promise<boolean> {
    const cal = await this.calendar(market);
    return isRegularOpen(cal, this.now());
  }

  /** Synchronous trading-day check using the last-fetched calendar cache.
   *  Returns false for weekends; returns best-effort true on uncached weekdays.
   *  Call isMarketOpen() first (e.g. in the data worker) to warm the cache. */
  isTradingDaySync(market: Market): boolean {
    const hit = this.cache.get(market);
    if (hit !== undefined) {
      return parseSession(hit.cal.today?.integrated?.regularMarket) !== null;
    }
    // Cache miss: weekend check only (holidays not detectable without a network call)
    const day = new Date(this.now()).getDay();
    return day !== 0 && day !== 6;
  }

  private async calendar(market: Market): Promise<TossMarketCalendar> {
    const hit = this.cache.get(market);
    if (hit && this.now() - hit.fetchedAt < this.cacheMs) return hit.cal;
    const cal = await this.deps.fetchCalendar(market);
    this.cache.set(market, { cal, fetchedAt: this.now() });
    return cal;
  }
}
