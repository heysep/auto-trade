// Per-symbol RAW factor values derived from a daily close-price series (oldest→newest).
// All functions return null when the series is too short for a reliable estimate.
// Pure math — no I/O, no external dependencies. Implemented independently of
// src/performance/PerformanceAnalyzer.ts (different inputs/units/windows).

/**
 * AQR 12-1 momentum: price(n-1-recentSkip) / price(n-1-longLookback) − 1.
 * Needs n > longLookback. Returns null on insufficient data or non-positive denominator.
 */
export function momentum12_1(
  prices: number[],
  recentSkip = 21,
  longLookback = 252,
): number | null {
  const n = prices.length;
  if (n <= longLookback) return null;

  // Both indices are within [0, n-1] when n > longLookback and recentSkip < longLookback.
  // Guard with undefined checks to satisfy noUncheckedIndexedAccess.
  const recent = prices[n - 1 - recentSkip];
  const old = prices[n - 1 - longLookback];

  if (recent === undefined || old === undefined) return null;
  if (!(old > 0)) return null; // guard zero / negative denominator

  return recent / old - 1;
}

/**
 * Population standard deviation of simple returns r_t = prices[t]/prices[t-1] − 1
 * over the last `window` returns.
 * Needs n > window (so at least `window` returns are computable). Returns null otherwise.
 */
export function realizedVol(prices: number[], window = 252): number | null {
  const n = prices.length;
  if (n <= window) return null;

  // Collect the last `window` simple returns: indices t = n-window … n-1.
  const returns: number[] = [];
  for (let t = n - window; t < n; t++) {
    const price = prices[t];
    const prev = prices[t - 1];
    // t >= n-window >= 1 (since n > window), so t-1 >= 0 — both are provably defined.
    if (price === undefined || prev === undefined) return null;
    if (!(prev > 0)) return null; // guard zero / negative price
    returns.push(price / prev - 1);
  }

  // Population std of returns.
  const len = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / len;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / len;
  return Math.sqrt(variance);
}

/**
 * Worst peak-to-trough decline (a non-positive fraction) over the last `window` prices.
 * Uses a running peak: min over t of (price[t] − peak) / peak.
 * Needs at least 2 prices in the window; returns null otherwise.
 */
export function maxDrawdown(prices: number[], window = 252): number | null {
  const n = prices.length;
  const start = Math.max(0, n - window);
  const slice = prices.slice(start);

  if (slice.length < 2) return null;

  let peak = -Infinity;
  let mdd = 0;

  for (const price of slice) {
    if (price > peak) peak = price;
    if (peak > 0) {
      const dd = (price - peak) / peak;
      if (dd < mdd) mdd = dd;
    }
  }

  return mdd;
}
