import type { EquityRecorder } from './EquityRecorder.js';
import type { Currency, TradingMode } from '../domain/types.js';
import { tradingDay } from '../risk/TradeTracker.js';

export interface SnapshotTarget { id: number; mode: TradingMode; currency: Currency; }

export interface SnapshotSchedulerDeps {
  recorder: EquityRecorder;
  targets: () => SnapshotTarget[];
  now?: () => number;
  /** Notified when a target is skipped (no quote) so a frozen curve isn't silent. */
  onSkip?: (target: SnapshotTarget) => void;
}

/**
 * Records one equity point per strategy per market day so the promotion gate's data
 * actually accrues over time (instead of the single boot snapshot that left it inert).
 * `maybeSnapshot` is idempotent per (strategy, day) and is meant to be called frequently
 * (e.g. from each price tick); the per-day guard makes that cheap. A snapshot that returns
 * null (no quote) does NOT advance the day marker, so it retries next tick.
 *
 * ⚠️ This captures whatever NAV is current at the first tick of a new day; a precise
 * market-close NAV needs a calendar-aware close trigger (PLAN §12) — wire that when the
 * market-calendar close time is confirmed.
 */
export class SnapshotScheduler {
  private readonly lastDay = new Map<string, string>();   // `${id}:${mode}` -> last snapshot day
  private readonly now: () => number;
  constructor(private readonly deps: SnapshotSchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * @param currency  when given, only snapshot targets of THIS currency — i.e. the market
   *   whose tick just fired. This keeps a strategy's NAV sampled during its OWN open session
   *   off fresh quotes, instead of off an unrelated co-tenant market's tick at a stale time.
   */
  maybeSnapshot(nowMs: number = this.now(), currency?: Currency): void {
    for (const t of this.deps.targets()) {
      if (currency !== undefined && t.currency !== currency) continue;
      const key = `${t.id}:${t.mode}`;
      const day = tradingDay(nowMs, t.currency);
      if (this.lastDay.get(key) === day) continue;          // already captured today
      const snap = this.deps.recorder.snapshot(t.id, t.mode, t.currency, nowMs);
      if (snap) this.lastDay.set(key, day);                 // advance only on a real record
      else this.deps.onSkip?.(t);                           // observable freeze (e.g. missing quote)
    }
  }
}
