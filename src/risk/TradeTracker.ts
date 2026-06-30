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

export interface TradeTracker {
  onFill(ctx: FillContext, effect: FillEffect, closedAt: number): void;
  dailyRealizedPnl(strategyId: number, mode: TradingMode, currency: Currency, nowMs: number): number;
  consecutiveLosses(strategyId: number, mode: TradingMode): number;
}

const TZ_BY_CURRENCY: Record<Currency, string> = {
  KRW: 'Asia/Seoul',
  USD: 'America/New_York',
};

/** Local calendar day (YYYY-MM-DD) in the market's timezone — DST-correct via Intl. */
export function tradingDay(nowMs: number, currency: Currency): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_BY_CURRENCY[currency], year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs));
}

interface Agg { day: string; dailyPnl: number; lossStreak: number; }

export class InMemoryTradeTracker implements TradeTracker {
  private readonly baseline = new Map<string, number>();   // realizedPnl at round-trip open
  private readonly agg = new Map<string, Agg>();           // per (strategy, mode)

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
  }

  dailyRealizedPnl(strategyId: number, mode: TradingMode, currency: Currency, nowMs: number): number {
    const a = this.agg.get(this.aggKey(strategyId, mode));
    if (!a) return 0;
    return a.day === tradingDay(nowMs, currency) ? a.dailyPnl : 0;  // stale day -> nothing realized yet today
  }

  consecutiveLosses(strategyId: number, mode: TradingMode): number {
    return this.agg.get(this.aggKey(strategyId, mode))?.lossStreak ?? 0;
  }
}
