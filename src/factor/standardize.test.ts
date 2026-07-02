import { describe, it, expect } from 'vitest';
import { winsorize, zscore, sectorNeutralize } from './standardize.js';

describe('winsorize', () => {
  it('clamps the upper outlier down to the 99th-percentile bound', () => {
    // n=5, sorted=[1,2,3,4,100]
    // upperIdx = Math.floor(4*0.99) = Math.floor(3.96) = 3 → hi = sorted[3] = 4
    // lowerIdx = Math.floor(4*0.01) = 0 → lo = sorted[0] = 1
    // 100 is clamped down to 4
    expect(winsorize([1, 2, 3, 4, 100])).toEqual([1, 2, 3, 4, 4]);
  });

  it('clamps the lower outlier up when explicit percentiles are given', () => {
    // n=10, sorted=[-100,1,2,3,4,5,6,7,8,9]
    // lowerPct=0.2: lowerIdx = Math.floor(9*0.2) = Math.floor(1.8) = 1 → lo = sorted[1] = 1
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
