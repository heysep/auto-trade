import type { OrderRepository } from '../persistence/repository.js';
import type { TradeTracker } from '../risk/TradeTracker.js';
import type { TradingMode } from '../domain/types.js';
import { analyze, type PerformanceMetrics } from './PerformanceAnalyzer.js';
import type { PromotionInput } from '../strategy/PromotionGate.js';

const DAY_MS = 24 * 60 * 60_000;

/**
 * Turns the in-memory equity curve (snapshots) and trade history (tracker) into the
 * PerformanceMetrics + PromotionInput the §7 gate needs.
 *
 * - totalReturn/MDD anchor on ALLOCATED CAPITAL (prepended as the day-0 NAV) so a restart
 *   mid-life can't reset the baseline to a post-gains snapshot.
 * - paperDays is the calendar SPAN of testing, not a count of scattered snapshot days.
 * - dailyLossViolations comes from the tracker (real breaches), so the §7 daily-loss
 *   criterion fails closed instead of auto-passing on a hardcoded 0.
 */
export class PerformanceService {
  constructor(
    private readonly repo: OrderRepository,
    private readonly tracker: TradeTracker,
    private readonly capitalFor: (strategyId: number) => number,
  ) {}

  metrics(strategyId: number, mode: TradingMode): PerformanceMetrics {
    const capital = this.capitalFor(strategyId);
    const navs = [capital, ...this.repo.getEquitySnapshots(strategyId, mode).map((s) => s.nav)];
    const tradePnls = this.tracker.trades(strategyId, mode).map((t) => t.pnl);
    return analyze(navs, tradePnls);
  }

  promotionInput(strategyId: number, mode: TradingMode): PromotionInput {
    const snaps = this.repo.getEquitySnapshots(strategyId, mode);
    const days = snaps.map((s) => s.day);
    const paperDays = days.length >= 2
      ? Math.floor((Date.parse(days[days.length - 1]!) - Date.parse(days[0]!)) / DAY_MS)
      : 0;
    return {
      paperDays,
      navSnapshotCount: snaps.length,
      metrics: this.metrics(strategyId, mode),
      dailyLossViolations: this.tracker.dailyLossViolationCount(strategyId, mode),
    };
  }
}
