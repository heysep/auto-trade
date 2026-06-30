import type { PerformanceMetrics } from '../performance/PerformanceAnalyzer.js';

// PLAN §7 live-promotion criteria. A gate must FAIL on insufficient data, not pass
// on the zero-valued metrics that empty series produce.
export interface PromotionCriteria {
  minPaperDays: number;
  minTrades: number;
  minTotalReturn: number;     // fraction, e.g. 0.05
  maxDrawdown: number;        // fraction, negative, e.g. -0.10 (worse-than fails)
  minWinRate: number;         // fraction
  minProfitFactor: number;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  minPaperDays: 30,
  minTrades: 50,
  minTotalReturn: 0.05,
  maxDrawdown: -0.10,
  minWinRate: 0.50,
  minProfitFactor: 1.3,
};

export interface PromotionInput {
  paperDays: number;
  navSnapshotCount: number;       // equity_snapshots rows; MDD is meaningless below 2
  metrics: PerformanceMetrics;
  dailyLossViolations: number;    // count of daily-max-loss rule breaches
}

export interface PromotionResult {
  eligible: boolean;
  failures: string[];             // empty when eligible
}

/** Evaluate whether a paper strategy may be promoted to LIVE. */
export function evaluatePromotion(
  input: PromotionInput,
  criteria: PromotionCriteria = DEFAULT_PROMOTION_CRITERIA,
): PromotionResult {
  const f: string[] = [];
  const m = input.metrics;

  // Data sufficiency first — without it the metrics below are not trustworthy.
  if (input.paperDays < criteria.minPaperDays) {
    f.push(`paperDays ${input.paperDays} < ${criteria.minPaperDays}`);
  }
  if (m.tradeCount < criteria.minTrades) {
    f.push(`trades ${m.tradeCount} < ${criteria.minTrades}`);
  }
  if (input.navSnapshotCount < 2) {
    f.push(`navSnapshots ${input.navSnapshotCount} < 2 (MDD undefined)`);
  }

  if (m.totalReturn < criteria.minTotalReturn) {
    f.push(`totalReturn ${m.totalReturn} < ${criteria.minTotalReturn}`);
  }
  if (m.maxDrawdown < criteria.maxDrawdown) {       // more negative = worse
    f.push(`maxDrawdown ${m.maxDrawdown} < ${criteria.maxDrawdown}`);
  }
  if (m.winRate < criteria.minWinRate) {
    f.push(`winRate ${m.winRate} < ${criteria.minWinRate}`);
  }
  if (m.profitFactor < criteria.minProfitFactor) {
    f.push(`profitFactor ${m.profitFactor} < ${criteria.minProfitFactor}`);
  }
  if (input.dailyLossViolations > 0) {
    f.push(`dailyLossViolations ${input.dailyLossViolations} > 0`);
  }

  return { eligible: f.length === 0, failures: f };
}
