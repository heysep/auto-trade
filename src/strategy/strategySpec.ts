import type { Currency, TradingMode } from '../domain/types.js';
import type { Strategy } from './Strategy.js';
import { ThresholdStrategy } from './ThresholdStrategy.js';
import { MovingAverageCrossStrategy } from './MovingAverageCrossStrategy.js';
import { CompositeStrategy } from './CompositeStrategy.js';

/**
 * Serializable strategy configuration, expressed as a discriminated union of
 * known strategy types. Composite specs recursively contain child specs.
 */
export type StrategySpec =
  | { type: 'threshold'; params: { buyBelow: number; sellAbove: number; orderNotional: number } }
  | { type: 'sma'; params: { fastPeriod: number; slowPeriod: number; orderNotional: number } }
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
  if (spec.type === 'threshold') {
    return new ThresholdStrategy({
      id,
      symbol,
      currency,
      mode,
      buyBelow: spec.params.buyBelow,
      sellAbove: spec.params.sellAbove,
      orderNotional: spec.params.orderNotional,
    });
  }

  if (spec.type === 'sma') {
    return new MovingAverageCrossStrategy({
      id,
      symbol,
      currency,
      mode,
      fastPeriod: spec.params.fastPeriod,
      slowPeriod: spec.params.slowPeriod,
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
