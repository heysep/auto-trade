import type { DcaPlanStore } from './DcaPlanStore.js';
import type { DcaPlanRunner } from './DcaPlanRunner.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DcaSchedulerDeps {
  store: DcaPlanStore;
  runner: DcaPlanRunner;
  /** Optional per-plan contribution hook. When set, called instead of runner.contribute().
   *  Use this to inject a prefetch-aware path (e.g. fetching the live price before
   *  contributing when the symbol is not yet in the QuoteBook). */
  contribute?: (plan: import('./DcaPlanRunner.js').DcaActivePlan) => Promise<{ invested: number; shares: number; price: number } | { skipped: string }>;
  isHalted: () => boolean;
  intervalMs: number;
  logger?: { log: (e: unknown) => void };
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
}

// ── DcaScheduler ──────────────────────────────────────────────────────────────

/**
 * Timer that calls DcaPlanRunner.contribute() for each due plan on every tick.
 *
 * Design mirrors RebalanceScheduler:
 * - `_inFlight` overlap guard (one tick at a time)
 * - `start()` / `stop()` idempotent
 * - halt-aware (checked at tick entry; runner.contribute() also checks per-plan)
 * - per-plan failure isolation (try/catch around each plan so one failure
 *   does not prevent others from running)
 * - NO isTradingDay check — DCA fires on calendar cadence regardless of trading day
 */
export class DcaScheduler {
  private readonly _now: () => number;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (h: ReturnType<typeof setInterval>) => void;
  private _handle: ReturnType<typeof setInterval> | undefined = undefined;
  private _inFlight = false;

  constructor(private readonly deps: DcaSchedulerDeps) {
    this._now = deps.now ?? Date.now;
    this._setInterval = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = deps.clearIntervalFn ?? clearInterval;
  }

  get enabled(): boolean {
    return this._handle !== undefined;
  }

  get intervalMs(): number {
    return this.deps.intervalMs;
  }

  /** Start the interval timer. Idempotent. */
  start(): void {
    if (this._handle !== undefined) return;
    this._handle = this._setInterval(() => { void this.tick(); }, this.deps.intervalMs);
  }

  /** Stop the interval timer. Idempotent. */
  stop(): void {
    if (this._handle === undefined) return;
    this._clearInterval(this._handle);
    this._handle = undefined;
  }

  /**
   * Process all plans that are currently due.
   *
   * - Overlap guard: concurrent tick() calls are no-ops.
   * - Halt guard: if halted at entry, skip all plans this tick.
   * - Per-plan isolation: a throw from one plan's contribute() is caught and
   *   logged; remaining plans still run.
   */
  async tick(): Promise<void> {
    if (this._inFlight) return;
    if (this.deps.isHalted()) return;

    this._inFlight = true;
    try {
      const now = this._now();
      const plans = this.deps.store.list();

      for (const plan of plans) {
        if (!this.deps.runner.isDue(plan, now)) continue;

        try {
          const result = this.deps.contribute !== undefined
            ? await this.deps.contribute(plan)
            : await this.deps.runner.contribute(plan);

          if ('skipped' in result) {
            // Log skips only in debug context; not an error.
            this.deps.logger?.log(`[dca] plan ${plan.id} skipped: ${result.skipped}`);
            continue;
          }

          // Successful contribution — update store.
          const newPeak =
            plan.plan.type === 'dipBuying'
              ? Math.max(plan.dipPeak ?? 0, result.price)
              : undefined;

          const patch = {
            lastContributionAt: now,
            totalInvested: plan.totalInvested + result.invested,
            shares: plan.shares + result.shares,
            ...(newPeak !== undefined ? { dipPeak: newPeak } : {}),
          };
          this.deps.store.update(plan.id, patch);

        } catch (err) {
          // Per-plan isolation: log and continue to next plan.
          this.deps.logger?.log(
            `[dca] plan ${plan.id} (${plan.symbol}) threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this._inFlight = false;
    }
  }
}
