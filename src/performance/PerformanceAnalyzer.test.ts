import { describe, it, expect } from 'vitest';
import {
  totalReturn, maxDrawdown, winRate, profitFactor, analyze, PF_SENTINEL,
} from './PerformanceAnalyzer.js';

describe('PerformanceAnalyzer', () => {
  it('totalReturn from first to last NAV', () => {
    expect(totalReturn([100, 110])).toBeCloseTo(0.1);
    expect(totalReturn([])).toBe(0);
    expect(totalReturn([100])).toBe(0);
    expect(totalReturn([0, 50])).toBe(0);           // guard against div-by-zero
  });

  it('maxDrawdown is the worst peak-to-trough decline', () => {
    expect(maxDrawdown([100, 120, 90, 110, 80])).toBeCloseTo(-1 / 3, 5); // 120 -> 80
    expect(maxDrawdown([100, 110, 120])).toBe(0);   // monotonic up
    expect(maxDrawdown([])).toBe(0);
  });

  it('winRate and profitFactor', () => {
    expect(winRate([10, -5, 20, -5])).toBeCloseTo(0.5);
    expect(winRate([])).toBe(0);
    expect(profitFactor([10, -5, 20, -5])).toBeCloseTo(3);      // 30 / 10
    expect(profitFactor([10, 20])).toBe(Infinity);             // no losses
    expect(profitFactor([-1, -2])).toBe(0);                    // no profits
  });

  it('analyze rolls everything up', () => {
    const m = analyze([100, 120, 90, 110], [10, -5, 20, -5]);
    expect(m.tradeCount).toBe(4);
    expect(m.winRate).toBeCloseTo(0.5);
    expect(m.profitFactor).toBeCloseTo(3);
    expect(m.maxDrawdown).toBeLessThan(0);
    expect(m.totalReturn).toBeCloseTo(0.1);
  });

  it('clamps non-finite profitFactor to a finite sentinel for safe JSON/DB round-trips', () => {
    const m = analyze([100, 110], [10, 20]);       // all wins -> PF would be Infinity
    expect(m.profitFactor).toBe(PF_SENTINEL);
    expect(Number.isFinite(m.profitFactor)).toBe(true);
    expect(JSON.parse(JSON.stringify(m)).profitFactor).toBe(PF_SENTINEL); // survives serialization
  });
});
