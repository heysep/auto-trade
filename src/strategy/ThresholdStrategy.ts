import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode, Quote } from '../domain/types.js';
import type { Signal } from './signal.js';
import { signalToIntent } from './signal.js';

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

  signal(quote: Quote): Signal {
    const couldBuy = quote.last <= this.cfg.buyBelow;
    const couldSell = quote.last >= this.cfg.sellAbove;

    if (couldSell && !couldBuy) return 'BEARISH';
    if (couldBuy && !couldSell) return 'BULLISH';
    if (couldBuy && couldSell) {
      // Both thresholds crossed: use distance to nearest threshold
      const distToBuy = this.cfg.buyBelow - quote.last;
      const distToSell = quote.last - this.cfg.sellAbove;
      return distToSell < distToBuy ? 'BEARISH' : 'BULLISH';
    }
    return 'NEUTRAL';
  }

  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    return signalToIntent(this.signal(quote), position?.quantity ?? 0,
      { currency: this.currency, price: quote.last, orderNotional: this.cfg.orderNotional });
  }
}
