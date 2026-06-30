import { describe, it, expect } from 'vitest';
import { evaluatePromotion, type PromotionInput } from './PromotionGate.js';
import type { PerformanceMetrics } from '../performance/PerformanceAnalyzer.js';

const metrics = (o: Partial<PerformanceMetrics> = {}): PerformanceMetrics => ({
  totalReturn: 0.08, maxDrawdown: -0.05, winRate: 0.6, profitFactor: 1.6,
  tradeCount: 60, avgWinLoss: 1.4, ...o,
});
const input = (o: Partial<PromotionInput> = {}): PromotionInput => ({
  paperDays: 35, navSnapshotCount: 35, metrics: metrics(), dailyLossViolations: 0, ...o,
});

describe('evaluatePromotion', () => {
  it('passes a strategy meeting every criterion', () => {
    const r = evaluatePromotion(input());
    expect(r.eligible).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('fails on insufficient trades', () => {
    const r = evaluatePromotion(input({ metrics: metrics({ tradeCount: 20 }) }));
    expect(r.eligible).toBe(false);
    expect(r.failures.some((f) => /trades/.test(f))).toBe(true);
  });

  it('fails on a drawdown worse than the limit', () => {
    const r = evaluatePromotion(input({ metrics: metrics({ maxDrawdown: -0.2 }) }));
    expect(r.eligible).toBe(false);
    expect(r.failures.some((f) => /maxDrawdown/.test(f))).toBe(true);
  });

  it('fails on insufficient data even if metrics look good', () => {
    const r = evaluatePromotion(input({ paperDays: 3, navSnapshotCount: 1, metrics: metrics({ tradeCount: 2 }) }));
    expect(r.eligible).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(3);   // paperDays, trades, navSnapshots
  });

  it('fails on any daily-loss-rule violation', () => {
    const r = evaluatePromotion(input({ dailyLossViolations: 1 }));
    expect(r.eligible).toBe(false);
    expect(r.failures.some((f) => /dailyLossViolations/.test(f))).toBe(true);
  });
});
