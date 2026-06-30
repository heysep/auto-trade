import type {
  Quote, Position, OrderSide, OrderType, TradingMode, Currency,
} from '../domain/types.js';

/** A strategy's decision for one tick: at most one intent (null = do nothing). */
export interface OrderIntent {
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  reason: string;
  confidence?: number;
}

export interface StrategyDecisionContext {
  quote: Quote;
  position: Position | undefined;
}

/** Strategies depend only on quote + current position — never on a broker directly. */
export interface Strategy {
  readonly id: number;
  readonly symbols: ReadonlySet<string>;
  readonly currency: Currency;
  readonly mode: TradingMode;
  evaluate(ctx: StrategyDecisionContext): OrderIntent | null;
}
