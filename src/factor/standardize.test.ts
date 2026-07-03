import { describe, it, expect } from 'vitest';
import { winsorize, zscore, sectorNeutralize } from './standardize.js';

describe('winsorize', () => {
  // ── small-n correctness (M1 fix) ─────────────────────────────────────────────
  //
  // The UPPER index uses Math.min(n-1, Math.ceil((n-1)*upperPct)) so that for
  // small cross-sections the range is never collapsed to a single point.
  //
  // n=2: ceil((2-1)*0.99) = ceil(0.99) = 1 → hi=sorted[1]=max  (no collapse)
  // n=3: ceil((3-1)*0.99) = ceil(1.98) = 2 → hi=sorted[2]=max  (no collapse)
  //
  // Actual clipping kicks in when ceil((n-1)*0.99) < n-1, which first occurs
  // at n=101: ceil(100*0.99) = ceil(99) = 99 < 100 → hi=sorted[99].

  it('n=2: [1,100] with default percentiles → [1,100] (no collapse, both endpoints preserved)', () => {
    // lo: max(0, floor(1*0.01)) = 0 → sorted[0] = 1
    // hi: min(1, ceil(1*0.99))  = min(1, ceil(0.99)) = min(1,1) = 1 → sorted[1] = 100
    // Neither endpoint is clamped.
    expect(winsorize([1, 100])).toEqual([1, 100]);
  });

  it('n=3: [1,2,3] with default percentiles → [1,2,3] (no median collapse)', () => {
    // hi: min(2, ceil(2*0.99)) = min(2, ceil(1.98)) = min(2,2) = 2 → sorted[2] = 3
    // No value is clamped; the full range is preserved.
    expect(winsorize([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('n=101: clear outlier at the top is clamped to the 99th-percentile neighbour', () => {
    // Array: [1, 2, ..., 100, 1000]  (101 elements, placed at index 100 in xs)
    // n=101, n-1=100
    // hi: min(100, ceil(100*0.99)) = min(100, ceil(99.0)) = min(100, 99) = 99 → sorted[99]=100
    // lo: max(0,  floor(100*0.01)) = max(0,  floor(1.0)) = max(0,  1)  = 1   → sorted[1]=2
    //
    // 1000 at index 100 is clamped DOWN to hi=100.
    // 1   at index   0 is clamped UP   to lo=2.
    // All values in [2..100] (indices 1..99) pass through unchanged.
    const normal = Array.from({ length: 100 }, (_, i) => i + 1); // [1..100]
    const xs = [...normal, 1000];
    const result = winsorize(xs);
    // Outlier clamped to hi.
    expect(result[100]).toBeCloseTo(100);
    // Low outlier (xs[0]=1 < lo=2) clamped up.
    expect(result[0]).toBeCloseTo(2);
    // Middle values unchanged (xs[50]=51, safely within [2, 100]).
    expect(result[50]).toBeCloseTo(51);
  });

  // ── updated n=5 test: re-derived after formula change ────────────────────────
  //
  // OLD formula (floor): floor(4*0.99)=3 → hi=sorted[3]=4 → 100 clamped to 4
  // NEW formula  (ceil): ceil(4*0.99)=4  → hi=sorted[4]=100 → no clamping
  //
  // For n=5 the upper tail consists of only 1 element (sorted[4]=max), and
  // Math.ceil rounds UP to n-1, so the formula preserves the full range.

  it('n=5 with one high outlier: outlier is NOT clamped (ceil rounds up to n-1 for small n)', () => {
    // ceil((5-1)*0.99) = ceil(3.96) = 4 = n-1 → hi = sorted[4] = 100 → no clamping
    expect(winsorize([1, 2, 3, 4, 100])).toEqual([1, 2, 3, 4, 100]);
  });

  it('clamps the lower outlier up when explicit percentiles are given', () => {
    // n=10, sorted=[-100,1,2,3,4,5,6,7,8,9]
    // lowerPct=0.2: max(0, floor(9*0.2)) = max(0, floor(1.8)) = 1 → lo = sorted[1] = 1
    // -100 is clamped up to 1
    const result = winsorize([-100, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0.2, 0.9);
    expect(result[0]).toBeCloseTo(1);
  });

  it('returns a copy unchanged for empty array', () => {
    const xs: number[] = [];
    const result = winsorize(xs);
    expect(result).toEqual([]);
    expect(result).not.toBe(xs);
  });

  it('returns a copy unchanged for length-1 array', () => {
    const xs = [42];
    const result = winsorize(xs);
    expect(result).toEqual([42]);
    expect(result).not.toBe(xs);
  });
});

describe('zscore', () => {
  it('produces mean≈0 and population std≈1 for a varied array', () => {
    const xs = [1, 2, 3, 4, 5];
    const zs = zscore(xs);
    const mean = zs.reduce((s, z) => s + z, 0) / zs.length;
    const variance = zs.reduce((s, z) => s + (z - mean) ** 2, 0) / zs.length;
    expect(mean).toBeCloseTo(0);
    expect(Math.sqrt(variance)).toBeCloseTo(1);
  });

  it('returns all zeros for an all-equal array (std === 0)', () => {
    expect(zscore([5, 5, 5])).toEqual([0, 0, 0]);
  });

  it('returns an empty array for empty input (n < 2)', () => {
    expect(zscore([])).toEqual([]);
  });

  it('returns [0] for a single-element array (n < 2)', () => {
    expect(zscore([42])).toEqual([0]);
  });
});

describe('sectorNeutralize', () => {
  it('demeaned within each sector so each sector output sums to ~0', () => {
    // Sector A: values [1,3], mean=2 → out=[−1,+1]
    // Sector B: values [2,4], mean=3 → out=[−1,+1]
    const out = sectorNeutralize([1, 3, 2, 4], ['A', 'A', 'B', 'B']);
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(-1);
    expect(out[3]).toBeCloseTo(1);
    const sumA = (out[0] ?? 0) + (out[1] ?? 0);
    const sumB = (out[2] ?? 0) + (out[3] ?? 0);
    expect(sumA).toBeCloseTo(0);
    expect(sumB).toBeCloseTo(0);
  });

  it('handles a single-sector case (all same sector)', () => {
    // All in sector X: mean(1,2,3)=2 → out=[-1,0,1]
    const out = sectorNeutralize([1, 2, 3], ['X', 'X', 'X']);
    expect(out[0]).toBeCloseTo(-1);
    expect(out[1]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(1);
  });

  it('throws when zs and sectors have different lengths', () => {
    expect(() => sectorNeutralize([1, 2], ['A'])).toThrow();
    expect(() => sectorNeutralize([1], ['A', 'B'])).toThrow();
  });
});
