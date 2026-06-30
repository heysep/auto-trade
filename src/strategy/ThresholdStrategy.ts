import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode } from '../domain/types.js';
import { isValidQuantity } from '../domain/money.js';

export interface ThresholdConfig {
  id: number;
  symbol: string;
  currency: Currency;
  mode: TradingMode;
  buyBelow: number;        // enter when last <= buyBelow and flat
  sellAbove: number;       // exit when last >= sellAbove and long
  orderNotional: number;   // cash to deploy per entry
}

/** Minimal example strategy: buy dips below a level, sell the whole position above another. */
export class ThresholdStrategy implements Strategy {
  readonly id: number;
  readonly symbols: ReadonlySet<string>;
  readonly currency: Currency;
  readonly mode: TradingMode;

  constructor(private readonly cfg: ThresholdConfig) {
    this.id = cfg.id;
    this.symbols = new Set([cfg.symbol]);
    this.currency = cfg.currency;
    this.mode = cfg.mode;
  }

  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    const price = quote.last;
    const held = position?.quantity ?? 0;

    if (held === 0 && price <= this.cfg.buyBelow) {
      const raw = this.cfg.orderNotional / price;
      const qty = this.currency === 'KRW' ? Math.floor(raw) : raw;
      if (!isValidQuantity(qty, this.currency)) return null;     // notional too small for 1 share
      return { side: 'BUY', quantity: qty, orderType: 'MARKET', reason: `price ${price} <= ${this.cfg.buyBelow}` };
    }
    if (held > 0 && price >= this.cfg.sellAbove) {
      return { side: 'SELL', quantity: held, orderType: 'MARKET', reason: `price ${price} >= ${this.cfg.sellAbove}` };
    }
    return null;
  }
}
