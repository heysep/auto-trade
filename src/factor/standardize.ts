// Cross-sectional factor standardization: winsorize, z-score, sector-neutral.
// Pure math — no I/O, no external dependencies.

/**
 * Clamp each value to the array's [lowerPct, upperPct] percentile bounds.
 *
 * Index formulas (M1 fix — correct small-n behaviour):
 *   lower index = Math.max(0, Math.floor((n-1) * lowerPct))   [floor, clamped ≥ 0]
 *   upper index = Math.min(n-1, Math.ceil((n-1) * upperPct))  [ceil,  clamped ≤ n-1]
 *
 * Using ceil for the upper index means that for small cross-sections (n ≤ ~100 at
 * pct=0.99) the upper bound stays at the observed maximum, so lo ≠ hi and z-scores
 * remain non-degenerate.  Actual clamping kicks in for n ≥ 101 with pct=0.99.
 *
 * Returns a copy. Empty / single-element arrays are returned as copies unchanged.
 */
export function winsorize(
  xs: number[],
  lowerPct = 0.01,
  upperPct = 0.99,
): number[] {
  const n = xs.length;
  if (n <= 1) return [...xs];

  const sorted = [...xs].sort((a, b) => a - b);
  // Both indices are within [0, n-1] by construction — ! is provably safe.
  const lo = sorted[Math.max(0, Math.floor((n - 1) * lowerPct))]!;
  const hi = sorted[Math.min(n - 1, Math.ceil((n - 1) * upperPct))]!;

  return xs.map((x) => Math.min(Math.max(x, lo), hi));
}

/**
 * Z-score using population standard deviation: (x − mean) / σ.
 * Returns all zeros when n < 2 or σ === 0.
 */
export function zscore(xs: number[]): number[] {
  const n = xs.length;
  if (n < 2) return new Array<number>(n).fill(0);

  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  if (std === 0) return new Array<number>(n).fill(0);
  return xs.map((x) => (x - mean) / std);
}

/**
 * Subtract each entry's sector mean from its z-score (cross-sectional demeaning).
 * `zs` and `sectors` must be parallel arrays of the same length; throws otherwise.
 */
export function sectorNeutralize(zs: number[], sectors: string[]): number[] {
  if (zs.length !== sectors.length) {
    throw new Error(
      `sectorNeutralize: zs length (${zs.length}) !== sectors length (${sectors.length})`,
    );
  }

  // Accumulate per-sector sums and counts.
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();

  for (let i = 0; i < zs.length; i++) {
    const sector = sectors[i];
    const z = zs[i];
    // i < zs.length and lengths are equal, so both are defined — guards satisfy noUncheckedIndexedAccess.
    if (sector === undefined || z === undefined) continue;
    sums.set(sector, (sums.get(sector) ?? 0) + z);
    counts.set(sector, (counts.get(sector) ?? 0) + 1);
  }

  // Compute per-sector means.
  const means = new Map<string, number>();
  for (const [sector, sum] of sums) {
    means.set(sector, sum / (counts.get(sector) ?? 1));
  }

  return zs.map((z, i) => {
    const sector = sectors[i];
    // i < zs.length (map callback), length equality checked above → provably defined.
    if (sector === undefined) return z;
    return z - (means.get(sector) ?? 0);
  });
}
