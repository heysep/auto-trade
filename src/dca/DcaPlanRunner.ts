import type { DcaPlan } from './DcaBacktest.js';

// ── Public types ───────────────────────────────────────────────────────────────

export interface DcaActivePlan {
  id: number;
  symbol: string;
  plan: DcaPlan;
  startedAt: number;
  lastContributionAt?: number;
  totalInvested: number;
  shares: number;
  /** Running price peak — updated after each dipBuying contribution. */
  dipPeak?: number;
}

export interface DcaRunnerDeps {
  /** Latest price from the QuoteBook. */
  priceOf: (symbol: string) => number | undefined;
  /** Held shares for the DCA strategy (strategy id 2000, PAPER). */
  currentShares: (symbol: string) => number;
  /** Routes a buy through OrderManager (fractional qty = usdAmount/price). */
  submitBuy: (symbol: string, usdAmount: number, price: number) => Promise<void>;
  isHalted: () => boolean;
  now?: () => number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

// ── DcaPlanRunner ─────────────────────────────────────────────────────────────

/**
 * Stateless per-plan contribution logic.
 *
 * Live-supported plan types: vanilla, dipBuying.
 * Unsupported: trendFiltered (needs SMA history), valueAveraging (needs
 * portfolio target), lumpSum (one-shot — rejected at activation, not here).
 */
export class DcaPlanRunner {
  private readonly _now: () => number;

  constructor(private readonly deps: DcaRunnerDeps) {
    this._now = deps.now ?? Date.now;
  }

  /**
   * Returns true when the cadence has elapsed since the last contribution
   * (or since startedAt when no contribution has been made yet).
   */
  isDue(plan: DcaActivePlan, at: number): boolean {
    const lastDate = plan.lastContributionAt ?? plan.startedAt;
    const diff = at - lastDate;

    switch (plan.plan.cadence) {
      case 'weekly':
        return diff >= 7 * MS_PER_DAY;
      case 'biweekly':
        return diff >= 14 * MS_PER_DAY;
      case 'monthly': {
        const a = new Date(lastDate);
        const b = new Date(at);
        return (
          b.getUTCFullYear() !== a.getUTCFullYear() ||
          b.getUTCMonth()    !== a.getUTCMonth()
        );
      }
    }
  }

  /**
   * Executes one contribution period for an active plan.
   *
   * Returns { invested, shares, price } on success; { skipped: reason } otherwise.
   *
   * Halt → { skipped: 'halted' }
   * No price → { skipped: 'no price' }
   *
   * For dipBuying: the caller (DcaScheduler / TradingSystem.runDcaNow) is
   * responsible for updating plan.dipPeak = max(plan.dipPeak ?? 0, result.price)
   * in the store after a successful contribution.
   */
  async contribute(
    plan: DcaActivePlan,
  ): Promise<{ invested: number; shares: number; price: number } | { skipped: string }> {
    if (this.deps.isHalted()) return { skipped: 'halted' };

    const price = this.deps.priceOf(plan.symbol);
    if (price === undefined || price <= 0) return { skipped: 'no price' };

    const cfg = plan.plan;
    let investAmount = 0;

    switch (cfg.type) {
      case 'vanilla': {
        investAmount = cfg.amount;
        break;
      }

      case 'dipBuying': {
        const dipExtra       = cfg.dipExtra       ?? 0;
        const dipDrawdownPct = cfg.dipDrawdownPct ?? 0.05;
        const dipPeak        = plan.dipPeak        ?? 0;
        // dipPeak === 0 means no prior bar recorded — treat as not a dip (guard
        // mirrors DcaBacktest: isDip requires peak > 0).
        const isDip = dipPeak > 0 && price <= dipPeak * (1 - dipDrawdownPct);
        investAmount = cfg.amount + (isDip ? dipExtra : 0);
        break;
      }

      case 'trendFiltered':
      case 'valueAveraging':
      case 'lumpSum': {
        // These types should be blocked at activateDcaPlan(); skip defensively.
        return { skipped: `plan type '${cfg.type}' is not live-supported` };
      }
    }

    if (investAmount <= 0) return { skipped: 'zero invest amount' };

    const shares = investAmount / price;
    await this.deps.submitBuy(plan.symbol, investAmount, price);
    return { invested: investAmount, shares, price };
  }
}
