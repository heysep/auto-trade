import type { OrderRepository } from '../persistence/repository.js';
import type { PriceSource } from '../market/PriceSource.js';
import type { Currency, TradingMode, EquitySnapshot } from '../domain/types.js';
import { tradingDay } from '../risk/TradeTracker.js';

export interface EquityRecorderDeps {
  repo: OrderRepository;
  book: PriceSource;
  capitalFor: (strategyId: number) => number;
  now?: () => number;
}

/**
 * Records one NAV point per market day per strategy — the equity curve PerformanceAnalyzer
 * needs for MDD/total-return. Call at market close (or periodically); the repo upserts by day.
 * NAV = capital + realized P&L + open mark-to-market.
 */
export class EquityRecorder {
  private readonly now: () => number;
  constructor(private readonly deps: EquityRecorderDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Returns null (records nothing) if any open position lacks a quote — a partial NAV
   *  would value that position at cost and silently hide unrealized losses from the gate. */
  snapshot(
    strategyId: number, mode: TradingMode, currency: Currency, nowMs: number = this.now(),
  ): EquitySnapshot | null {
    const positions = this.deps.repo.getPositions(strategyId, mode);
    if (positions.some((p) => p.quantity !== 0 && !this.deps.book.getQuote(p.symbol))) return null;

    const capital = this.deps.capitalFor(strategyId);
    const realized = positions.reduce((s, p) => s + p.realizedPnl, 0);
    const investedCost = positions.reduce((s, p) => s + p.quantity * p.avgPrice, 0);
    const unrealized = positions.reduce((s, p) => {
      const q = this.deps.book.getQuote(p.symbol);
      return q ? s + p.quantity * (q.last - p.avgPrice) : s;
    }, 0);

    const snap: EquitySnapshot = {
      strategyId, mode,
      nav: capital + realized + unrealized,
      cash: capital + realized - investedCost,
      day: tradingDay(nowMs, currency),
    };
    this.deps.repo.saveEquitySnapshot(snap);
    return snap;
  }
}
