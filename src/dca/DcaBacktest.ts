/**
 * DCA Backtest Engine
 *
 * Pure / deterministic — no I/O, no Date.now(), no Math.random().
 * All timestamps are epoch-ms supplied by the caller.
 *
 * lumpSum assumption: the engine counts how many cadence periods would fire
 * across the price window (same shouldFire logic as all other plan types),
 * then invests `amount × count` on day 0.  This makes the total deployed
 * capital identical to a vanilla DCA run over the same window so results are
 * directly comparable.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface PricePoint {
  date: number;   // epoch ms, strictly ascending
  close: number;
}

export type DcaCadence  = 'weekly' | 'biweekly' | 'monthly';
export type DcaPlanType = 'vanilla' | 'valueAveraging' | 'dipBuying' | 'trendFiltered' | 'lumpSum';

export interface DcaPlan {
  type: DcaPlanType;
  cadence: DcaCadence;          // cadence for contributions (for lumpSum: only used to count periods)
  amount: number;               // base contribution per period (USD)
  dipExtra?: number;            // dipBuying: extra USD on a drawdown bar
  dipDrawdownPct?: number;      // dipBuying: e.g. 0.05 means 5% below the running price peak
  trendWindow?: number;         // trendFiltered: trading-day SMA window (e.g. 200)
  costPct?: number;             // per-buy cost fraction, default 0.001 (0.1 %)
}

export interface DcaResult {
  contributions: { date: number; invested: number; price: number; shares: number }[];
  totalInvested: number;
  shares: number;
  finalValue: number;
  uninvestedCash: number;       // trendFiltered dry-powder; 0 for all other types
  avgCost: number;              // totalInvested / shares (0 when shares = 0)
  moneyWeightedReturn: number;  // annualised IRR; 0 when unresolvable
  timeWeightedReturn: number;   // buy&hold annualised = (lastClose/firstClose)^(365/days) – 1
  maxDrawdown: number;          // worst (value – peak) / peak ≤ 0
  periods: number;              // total cadence periods that fired (incl. trendFiltered skips)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when a new contribution should fire at `date` given the last-fired date. */
function shouldFire(cadence: DcaCadence, date: number, lastDate: number | null): boolean {
  if (lastDate === null) return true;           // first price always fires
  const diff = date - lastDate;
  switch (cadence) {
    case 'weekly':
      return diff >= 7 * MS_PER_DAY;
    case 'biweekly':
      return diff >= 14 * MS_PER_DAY;
    case 'monthly': {
      const a = new Date(lastDate);
      const b = new Date(date);
      return (
        b.getUTCFullYear() !== a.getUTCFullYear() ||
        b.getUTCMonth()    !== a.getUTCMonth()
      );
    }
  }
}

/** Count cadence firings across a full price series. */
function countPeriods(prices: PricePoint[], cadence: DcaCadence): number {
  let n    = 0;
  let last: number | null = null;
  for (const pt of prices) {
    if (shouldFire(cadence, pt.date, last)) {
      n++;
      last = pt.date;
    }
  }
  return n;
}

/**
 * Annualised IRR via bisection on NPV(r) = 0.
 *
 *   NPV(r) = finalValue / (1+r)^T  –  Σ Cᵢ / (1+r)^tᵢ
 *
 * Times are in years from firstDate.  Bracket [-0.99, 5.0].
 * Returns 0 on degenerate inputs or when no sign change exists in the bracket.
 */
function computeIRR(
  contributions: ReadonlyArray<{ date: number; invested: number }>,
  finalValue: number,
  firstDate: number,
  totalDays: number,
): number {
  if (contributions.length === 0 || finalValue <= 0 || totalDays <= 0) return 0;

  const T = totalDays / 365;

  function npv(r: number): number {
    const denomT = Math.pow(1 + r, T);
    if (!isFinite(denomT) || denomT === 0) return 0;
    let pv = finalValue / denomT;
    for (const c of contributions) {
      const t = (c.date - firstDate) / MS_PER_DAY / 365;
      const d = Math.pow(1 + r, t);
      if (!isFinite(d) || d === 0) return 0;
      pv -= c.invested / d;
    }
    return pv;
  }

  const LO = -0.99;
  let fa   = npv(LO);
  if (!isFinite(fa)) return 0;

  // Start with a modest upper bound and expand until we find a sign change.
  // This handles high-return scenarios (e.g. price doubles in 7 weeks → IRR >> 500%).
  let b   = 5.0;
  let fb  = npv(b);
  for (let ex = 0; ex < 25 && isFinite(fb) && fa * fb > 0; ex++) {
    b  *= 4;
    fb  = npv(b);
  }

  if (!isFinite(fb) || fa * fb > 0) return 0; // no sign change found

  let a = LO;

  for (let iter = 0; iter < 120; iter++) {
    if (b - a < 1e-12) break;
    const mid = (a + b) / 2;
    const fm  = npv(mid);
    if (!isFinite(fm)) return 0;
    if (fa * fm <= 0) {
      b = mid;
    } else {
      a  = mid;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/** Zero-safe result for degenerate inputs. */
function zeroResult(): DcaResult {
  return {
    contributions:       [],
    totalInvested:       0,
    shares:              0,
    finalValue:          0,
    uninvestedCash:      0,
    avgCost:             0,
    moneyWeightedReturn: 0,
    timeWeightedReturn:  0,
    maxDrawdown:         0,
    periods:             0,
  };
}

// ---------------------------------------------------------------------------
// DcaBacktest
// ---------------------------------------------------------------------------
export class DcaBacktest {
  private readonly plan: DcaPlan;

  constructor(plan: DcaPlan) {
    this.plan = plan;
  }

  run(prices: PricePoint[]): DcaResult {
    if (prices.length === 0) return zeroResult();

    const plan    = this.plan;
    const costPct = plan.costPct ?? 0.001;

    // Pre-count periods for lumpSum so we can invest the equivalent total on day 0
    const lumpTotal = plan.type === 'lumpSum'
      ? plan.amount * countPeriods(prices, plan.cadence)
      : 0;

    // ── Working state ────────────────────────────────────────────────────────
    const contributions: DcaResult['contributions'] = [];
    let shares         = 0;
    let uninvestedCash = 0;
    let totalInvested  = 0;
    let vaPeriod       = 0;    // valueAveraging: period counter k (1-based)
    let dipPeak        = 0;    // dipBuying: running peak of close price
    let portfolioPeak  = 0;    // maxDrawdown: running peak of portfolio value
    let maxDrawdown    = 0;
    let lastDate: number | null = null;
    let lumpDone       = false;
    let totalPeriods   = 0;
    /** Accumulates all closes seen so far (for trendFiltered SMA). */
    const closeSoFar: number[] = [];

    for (let i = 0; i < prices.length; i++) {
      const pt = prices[i];
      if (pt === undefined) break;
      const { date, close } = pt;

      // ── 1. Cadence check ─────────────────────────────────────────────────
      if (shouldFire(plan.cadence, date, lastDate)) {
        totalPeriods++;
        lastDate = date;

        let investAmount = 0;

        switch (plan.type) {
          case 'vanilla': {
            investAmount = plan.amount;
            break;
          }

          case 'lumpSum': {
            if (!lumpDone) {
              investAmount = lumpTotal;
              lumpDone     = true;
            }
            break;
          }

          case 'valueAveraging': {
            vaPeriod++;
            const target       = plan.amount * vaPeriod;
            const currentValue = shares * close;
            investAmount       = Math.max(0, target - currentValue);
            break;
          }

          case 'dipBuying': {
            const dipExtra      = plan.dipExtra      ?? 0;
            const dipDrawdownPct = plan.dipDrawdownPct ?? 0.05;
            // dipPeak is updated AFTER contribution (below), so this uses
            // the peak of all prices BEFORE the current bar.
            const isDip  = dipPeak > 0 && close <= dipPeak * (1 - dipDrawdownPct);
            investAmount = plan.amount + (isDip ? dipExtra : 0);
            break;
          }

          case 'trendFiltered': {
            const trendWindow = plan.trendWindow ?? 200;
            if (closeSoFar.length < trendWindow) {
              // Warmup: fewer than trendWindow prior closes → skip (dry powder)
              uninvestedCash += plan.amount;
            } else {
              const slice = closeSoFar.slice(-trendWindow);
              const sma   = slice.reduce((acc: number, v: number) => acc + v, 0) / trendWindow;
              if (close > sma) {
                investAmount = plan.amount;
              } else {
                uninvestedCash += plan.amount;
              }
            }
            break;
          }
        }

        // ── Execute investment ────────────────────────────────────────────
        if (investAmount > 0) {
          const sharesBought = (investAmount * (1 - costPct)) / close;
          shares        += sharesBought;
          totalInvested += investAmount;
          contributions.push({
            date,
            invested: investAmount,
            price:    close,
            shares:   sharesBought,
          });
        }
      }

      // ── 2. Update dipPeak (after contribution decision for this bar) ──────
      if (plan.type === 'dipBuying') {
        dipPeak = Math.max(dipPeak, close);
      }

      // ── 3. Mark-to-market for maxDrawdown ────────────────────────────────
      const cash = plan.type === 'trendFiltered' ? uninvestedCash : 0;
      const pv   = shares * close + cash;
      if (portfolioPeak > 0) {
        const dd = (pv - portfolioPeak) / portfolioPeak;
        if (dd < maxDrawdown) maxDrawdown = dd;
      }
      portfolioPeak = Math.max(portfolioPeak, pv);

      // ── 4. Accumulate close for SMA (AFTER processing this bar) ──────────
      closeSoFar.push(close);
    }

    // ── Final metrics ────────────────────────────────────────────────────────
    const firstPt = prices[0];
    const lastPt  = prices[prices.length - 1];
    if (firstPt === undefined || lastPt === undefined) return zeroResult();

    const totalDays  = (lastPt.date - firstPt.date) / MS_PER_DAY;
    const firstClose = firstPt.close;
    const lastClose  = lastPt.close;

    const cash2      = plan.type === 'trendFiltered' ? uninvestedCash : 0;
    const finalValue = shares * lastClose + cash2;
    const avgCost    = shares > 0 ? totalInvested / shares : 0;

    const timeWeightedReturn =
      totalDays > 0 && firstClose > 0
        ? Math.pow(lastClose / firstClose, 365 / totalDays) - 1
        : 0;

    const moneyWeightedReturn =
      finalValue > 0
        ? computeIRR(contributions, finalValue, firstPt.date, totalDays)
        : 0;

    return {
      contributions,
      totalInvested,
      shares,
      finalValue,
      uninvestedCash,
      avgCost,
      moneyWeightedReturn,
      timeWeightedReturn,
      maxDrawdown,
      periods: totalPeriods,
    };
  }
}
