import type { Currency, TradingMode } from '../domain/types.js';
import type { Strategy } from './Strategy.js';
import { TimeSeriesMomentumStrategy } from './TimeSeriesMomentumStrategy.js';
import { CompositeStrategy } from './CompositeStrategy.js';
import { VolatilityBreakoutStrategy } from './VolatilityBreakoutStrategy.js';

/**
 * Serializable strategy configuration, expressed as a discriminated union of
 * known strategy types. Composite specs recursively contain child specs.
 */
export type StrategySpec =
  | { type: 'tsmom'; params: { lookback: number; threshold?: number; orderNotional: number } }
  | { type: 'composite'; combine: 'AND' | 'OR'; a: StrategySpec; b: StrategySpec; orderNotional: number }
  | { type: 'volbreakout'; params: { k: number; budget: number; symbols: string[]; minRangePct?: number } };

/** Optional I/O dependencies injectable at factory time. */
export interface BuildStrategyDeps {
  /**
   * Provider of the previous day's high/low and today's open for volatility-breakout strategies.
   * Defaults to `async () => undefined` (no data → strategy stays flat).
   */
  getDailyRange?: (
    symbol: string,
  ) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
}

/**
 * Factory that builds a Strategy from a StrategySpec.
 * Composite children are built with id=0 (only the top-level id matters for the engine).
 *
 * The optional `deps` parameter carries I/O dependencies needed by certain strategy types
 * (e.g. volbreakout needs getDailyRange). Existing callers that omit `deps` are unaffected —
 * each strategy type that requires a dep falls back to a safe no-op default.
 */
export function buildStrategy(
  id: number,
  symbol: string,
  currency: Currency,
  mode: TradingMode,
  spec: StrategySpec,
  deps?: BuildStrategyDeps,
): Strategy {
  if (spec.type === 'tsmom') {
    return new TimeSeriesMomentumStrategy({
      id,
      symbol,
      currency,
      mode,
      lookback: spec.params.lookback,
      ...(spec.params.threshold !== undefined ? { threshold: spec.params.threshold } : {}),
      orderNotional: spec.params.orderNotional,
    });
  }

  if (spec.type === 'composite') {
    const a = buildStrategy(0, symbol, currency, mode, spec.a, deps);
    const b = buildStrategy(0, symbol, currency, mode, spec.b, deps);
    return new CompositeStrategy(
      {
        id,
        symbol,
        currency,
        mode,
        combine: spec.combine,
        orderNotional: spec.orderNotional,
      },
      a,
      b,
    );
  }

  if (spec.type === 'volbreakout') {
    const getDailyRange = deps?.getDailyRange ?? (async () => undefined);
    return new VolatilityBreakoutStrategy({
      id,
      symbols: spec.params.symbols,
      currency,
      mode,
      k: spec.params.k,
      budget: spec.params.budget,
      ...(spec.params.minRangePct !== undefined ? { minRangePct: spec.params.minRangePct } : {}),
      getDailyRange,
    });
  }

  throw new Error(`unknown strategy spec: ${(spec as unknown as { type?: unknown }).type}`);
}
