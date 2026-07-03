import { describe, it, expect, vi } from 'vitest';
import { isRegularOpen, parseSession, MarketCalendarService } from './MarketCalendar.js';
import type { TossMarketCalendar } from '../toss/types.js';

const cal = (start?: string, end?: string): TossMarketCalendar => ({
  today: {
    date: '2026-06-30',
    integrated: { regularMarket: start && end ? { startTime: start, endTime: end } : null },
  },
});
const at = (iso: string) => Date.parse(iso);
const OPEN = cal('2026-06-30T00:00:00Z', '2026-06-30T06:30:00Z');

describe('MarketCalendar', () => {
  it('parseSession returns bounds or null', () => {
    expect(parseSession({ startTime: '2026-06-30T00:00:00Z', endTime: '2026-06-30T06:30:00Z' }))
      .toEqual({ start: at('2026-06-30T00:00:00Z'), end: at('2026-06-30T06:30:00Z') });
    expect(parseSession(null)).toBeNull();
    expect(parseSession({ startTime: 'nope', endTime: 'nope' })).toBeNull();
  });

  it('isRegularOpen respects the session window', () => {
    expect(isRegularOpen(OPEN, at('2026-06-30T03:00:00Z'))).toBe(true);
    expect(isRegularOpen(OPEN, at('2026-06-29T23:59:00Z'))).toBe(false);  // before open
    expect(isRegularOpen(OPEN, at('2026-06-30T07:00:00Z'))).toBe(false);  // after close
    expect(isRegularOpen(cal(), at('2026-06-30T03:00:00Z'))).toBe(false); // closed/holiday
  });

  it('caches the calendar within cacheMs', async () => {
    const fetchCalendar = vi.fn(async () => OPEN);
    let nowMs = at('2026-06-30T03:00:00Z');
    const svc = new MarketCalendarService({ fetchCalendar, now: () => nowMs, cacheMs: 60_000 });

    expect(await svc.isMarketOpen('KR')).toBe(true);
    nowMs += 30_000;
    expect(await svc.isMarketOpen('KR')).toBe(true);
    expect(fetchCalendar).toHaveBeenCalledTimes(1);     // cache hit
    nowMs += 60_000;
    await svc.isMarketOpen('KR');
    expect(fetchCalendar).toHaveBeenCalledTimes(2);     // cache expired -> refetch
  });

  describe('isTradingDaySync', () => {
    it('returns true when cached calendar has a regularMarket session', async () => {
      const fetchCalendar = vi.fn(async () => OPEN);
      const svc = new MarketCalendarService({ fetchCalendar, now: () => at('2026-06-30T03:00:00Z') });
      await svc.isMarketOpen('KR');  // warm the cache
      expect(svc.isTradingDaySync('KR')).toBe(true);
    });

    it('returns false when cached calendar has no regularMarket session (holiday)', async () => {
      const holiday = cal();  // no session
      const fetchCalendar = vi.fn(async () => holiday);
      const svc = new MarketCalendarService({ fetchCalendar, now: () => at('2026-06-30T03:00:00Z') });
      await svc.isMarketOpen('KR');  // warm the cache
      expect(svc.isTradingDaySync('KR')).toBe(false);
    });

    it('returns false on Sunday when cache is empty', () => {
      // 2026-06-28 is a Sunday
      const svc = new MarketCalendarService({
        fetchCalendar: vi.fn(async () => OPEN),
        now: () => at('2026-06-28T12:00:00Z'),
      });
      expect(svc.isTradingDaySync('KR')).toBe(false);
    });

    it('returns true on a weekday when cache is empty', () => {
      // 2026-06-30 is a Tuesday
      const svc = new MarketCalendarService({
        fetchCalendar: vi.fn(async () => OPEN),
        now: () => at('2026-06-30T12:00:00Z'),
      });
      expect(svc.isTradingDaySync('KR')).toBe(true);
    });
  });
});
