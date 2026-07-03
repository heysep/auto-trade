import type { Currency, TradingMode } from '../domain/types.js';
import type { Strategy } from './Strategy.js';
import { TimeSeriesMomentumStrategy } from './TimeSeriesMomentumStrategy.js';
import { CompositeStrategy } from './CompositeStrategy.js';

/**
 * Serializable strategy configuration, expressed as a discriminated union of
 * known strategy types. Composite specs recursively contain child specs.
 */
export type StrategySpec =
  | { type: 'tsmom'; params: { lookback: number; threshold?: number; orderNotional: number } }
  | { type: 'composite'; combine: 'AND' | 'OR'; a: StrategySpec; b: StrategySpec; orderNotional: number };

/**
 * Factory that builds a Strategy from a StrategySpec.
 * Composite children are built with id=0 (only the top-level id matters for the engine).
 */
export function buildStrategy(
  id: number,
  symbol: string,
  currency: Currency,
  mode: TradingMode,
  spec: StrategySpec,
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
    const a = buildStrategy(0, symbol, currency, mode, spec.a);
    const b = buildStrategy(0, symbol, currency, mode, spec.b);
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

  throw new Error(`unknown strategy spec: ${(spec as unknown as { type?: unknown }).type}`);
}
