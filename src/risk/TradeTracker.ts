import type { TradingMode, Currency } from '../domain/types.js';
import type { FillEffect } from '../domain/positionAccounting.js';

// Drives the daily-loss and consecutive-loss risk halts. State is INCREMENTAL and BOUNDED:
// one running aggregate per (strategy, mode) plus a baseline per OPEN position. Reads are
// O(1); nothing accumulates per-fill forever. Outcomes are scored per ROUND TRIP (a SELL
// returning the position to flat), not per SELL fill, so slicing an exit doesn't distort
// the loss streak.

export interface FillContext {
  strategyId: number;
  symbol: string;
  mode: TradingMode;
  currency: Currency;
}

export interface RoundTrip { pnl: number; closedAt: number; }

export interface TradeTracker {
  onFill(ctx: FillContext, effect: FillEffect, closedAt: number): void;
  dailyRealizedPnl(strategyId: number, mode: TradingMode, currency: Currency, nowMs: number): number;
  consecutiveLosses(strategyId: number, mode: TradingMode): number;
  trades(strategyId: number, mode: TradingMode): RoundTrip[];   // capped history for performance/promotion
  /** Mark the current market day as a daily-max-loss breach (feeds §7 promotion). */
  markDailyLoss(strategyId: number, mode: TradingMode, currency: Currency, nowMs: number): void;
  dailyLossViolationCount(strategyId: number, mode: TradingMode): number;
}

const TZ_BY_CURRENCY: Record<Currency, string> = {
  KRW: 'Asia/Seoul',
  USD: 'America/New_York',
};

// Intl.DateTimeFormat construction is ~80x the format() call; cache one per timezone since
// tradingDay() runs on the per-tick snapshot path.
const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = FMT_CACHE.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    FMT_CACHE.set(tz, fmt);
  }
  return fmt;
}

/** Local calendar day (YYYY-MM-DD) in the market's timezone — DST-correct via Intl. */
export function tradingDay(nowMs: number, currency: Currency): string {
  return formatterFor(TZ_BY_CURRENCY[currency]).format(new Date(nowMs));
}

interface Agg { day: string; dailyPnl: number; lossStreak: number; }

/** Serializable snapshot for file-based durability across restarts. */
export interface TrackerSnapshot {
  baseline: [string, number][];
  agg: [string, Agg][];
  history: [string, RoundTrip[]][];
  violationDays: [string, string[]][];
}

const TRADES_CAP = 2000;   // bounded history; promotion needs ~50, so this is plenty

export class InMemoryTradeTracker implements TradeTracker {
  private readonly baseline = new Map<string, number>();   // realizedPnl at round-trip open
  private readonly agg = new Map<string, Agg>();           // per (strategy, mode) — O(1) risk reads
  private readonly history = new Map<string, RoundTrip[]>(); // per (strategy, mode) — capped trade log
  private readonly violationDays = new Map<string, Set<string>>(); // per (strategy, mode) — daily-loss breach days

  private symKey(s: number, sym: string, m: TradingMode): string { return `${s}:${sym}:${m}`; }
  private aggKey(s: number, m: TradingMode): string { return `${s}:${m}`; }

  onFill(ctx: FillContext, effect: FillEffect, closedAt: number): void {
    const sk = this.symKey(ctx.strategyId, ctx.symbol, ctx.mode);
    if (effect.openedFromFlat) {
      this.baseline.set(sk, effect.positionRealizedPnl);   // realized P&L as the trip opened
    }
    if (effect.closedToFlat) {
      const base = this.baseline.get(sk) ?? 0;
      const roundTripPnl = effect.positionRealizedPnl - base;
      this.baseline.delete(sk);
      this.record(ctx, roundTripPnl, closedAt);
    }
  }

  private record(ctx: FillContext, pnl: number, closedAt: number): void {
    const key = this.aggKey(ctx.strategyId, ctx.mode);
    const day = tradingDay(closedAt, ctx.currency);
    let a = this.agg.get(key);
    if (!a || a.day !== day) {
      a = { day, dailyPnl: 0, lossStreak: a?.lossStreak ?? 0 };   // streak persists across days
      this.agg.set(key, a);
    }
    a.dailyPnl += pnl;
    if (pnl < 0) a.lossStreak++;
    else if (pnl > 0) a.lossStreak = 0;                            // a win resets; breakeven is neutral

    const log = this.history.get(key) ?? [];
    log.push({ pnl, closedAt });
    // Bounded; trim in batches so we don't pay an O(n) shift on every trade past the cap.
    this.history.set(key, log.length > TRADES_CAP * 1.25 ? log.slice(-TRADES_CAP) : log);
  }

  dailyRealizedPnl(strategyId: number, mode: TradingMode, currency: Currency, nowMs: number): number {
    const a = this.agg.get(this.aggKey(strategyId, mode));
    if (!a) return 0;
    return a.day === tradingDay(nowMs, currency) ? a.dailyPnl : 0;  // stale day -> nothing realized yet today
  }

  consecutiveLosses(strategyId: number, mode: TradingMode): number {
    return this.agg.get(this.aggKey(strategyId, mode))?.lossStreak ?? 0;
  }

  trades(strategyId: number, mode: TradingMode): RoundTrip[] {
    return (this.history.get(this.aggKey(strategyId, mode)) ?? []).slice();
  }

  markDailyLoss(strategyId: number, mode: TradingMode, currency: Currency, nowMs: number): void {
    const key = this.aggKey(strategyId, mode);
    const set = this.violationDays.get(key) ?? new Set<string>();
    set.add(tradingDay(nowMs, currency));      // idempotent per day
    this.violationDays.set(key, set);
  }

  dailyLossViolationCount(strategyId: number, mode: TradingMode): number {
    return this.violationDays.get(this.aggKey(strategyId, mode))?.size ?? 0;
  }

  // --- durability ---
  dump(): TrackerSnapshot {
    return {
      baseline: [...this.baseline.entries()],
      agg: [...this.agg.entries()],
      history: [...this.history.entries()],
      violationDays: [...this.violationDays.entries()].map(([k, set]) => [k, [...set]]),
    };
  }

  restore(s: TrackerSnapshot): void {
    // maps are readonly fields — mutate in place rather than reassign.
    this.baseline.clear(); for (const [k, v] of s.baseline) this.baseline.set(k, v);
    this.agg.clear(); for (const [k, v] of s.agg) this.agg.set(k, v);
    this.history.clear(); for (const [k, v] of s.history) this.history.set(k, v);
    this.violationDays.clear(); for (const [k, arr] of s.violationDays) this.violationDays.set(k, new Set(arr));
  }
}
