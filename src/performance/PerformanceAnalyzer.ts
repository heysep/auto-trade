// Pure performance math over a daily NAV series (equity_snapshots) and realized
// trade P&Ls (from fills). No I/O — feed it arrays, get metrics.

export interface PerformanceMetrics {
  totalReturn: number;     // fraction, e.g. 0.05 = +5%
  maxDrawdown: number;     // fraction, <= 0, e.g. -0.10 = -10%
  winRate: number;         // fraction of winning trades, 0..1
  profitFactor: number;    // gross profit / gross loss; PF_SENTINEL if no losses
  tradeCount: number;
  avgWinLoss: number;      // avg win / avg |loss|; PF_SENTINEL if no losses
}

// JSON.stringify(Infinity) === "null", which silently fails a `pf >= 1.3` promotion
// gate after a round-trip to the DB/API. Clamp serialized metrics to a large finite.
export const PF_SENTINEL = 1e9;
const finite = (x: number): number => (Number.isFinite(x) ? x : PF_SENTINEL);

/** Total return from first to last NAV. 0 if fewer than 2 points or first <= 0. */
export function totalReturn(navs: number[]): number {
  if (navs.length < 2) return 0;
  const first = navs[0]!;
  const last = navs[navs.length - 1]!;
  if (!(first > 0)) return 0;
  return (last - first) / first;
}

/** Max peak-to-trough drawdown as a non-positive fraction. */
export function maxDrawdown(navs: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const nav of navs) {
    if (nav > peak) peak = nav;
    if (peak > 0) {
      const dd = (nav - peak) / peak;          // <= 0
      if (dd < mdd) mdd = dd;
    }
  }
  return mdd;
}

export function winRate(tradePnls: number[]): number {
  if (tradePnls.length === 0) return 0;
  const wins = tradePnls.filter((p) => p > 0).length;
  return wins / tradePnls.length;
}

/** Gross profit / gross loss. Infinity when there are profits but no losses; 0 when no profits. */
export function profitFactor(tradePnls: number[]): number {
  let grossProfit = 0;
  let grossLoss = 0;
  for (const p of tradePnls) {
    if (p > 0) grossProfit += p;
    else if (p < 0) grossLoss += -p;
  }
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
  return grossProfit / grossLoss;
}

function avgWinLoss(tradePnls: number[]): number {
  const wins = tradePnls.filter((p) => p > 0);
  const losses = tradePnls.filter((p) => p < 0);
  if (losses.length === 0) return wins.length > 0 ? Infinity : 0;
  const avgWin = wins.reduce((s, p) => s + p, 0) / (wins.length || 1);
  const avgLoss = Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length);
  return avgLoss === 0 ? Infinity : avgWin / avgLoss;
}

export function analyze(navs: number[], tradePnls: number[]): PerformanceMetrics {
  // NOTE: a promotion gate (PLAN §7) MUST treat insufficient data as a FAIL —
  // maxDrawdown([]) and maxDrawdown([x]) are 0, which would trivially pass a
  // "MDD within -10%" check. Enforce minimum snapshot/trade counts in the gate,
  // not here. Metrics are clamped to finite for safe JSON/DB round-trips.
  return {
    totalReturn: totalReturn(navs),
    maxDrawdown: maxDrawdown(navs),
    winRate: winRate(tradePnls),
    profitFactor: finite(profitFactor(tradePnls)),
    tradeCount: tradePnls.length,
    avgWinLoss: finite(avgWinLoss(tradePnls)),
  };
}
