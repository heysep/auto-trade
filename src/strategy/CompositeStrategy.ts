import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode, Quote } from '../domain/types.js';
import { type Signal, signalToIntent } from './signal.js';

export interface CompositeConfig { id: number; symbol: string; currency: Currency; mode: TradingMode; orderNotional: number; combine: 'AND' | 'OR'; }

export class CompositeStrategy implements Strategy {
  readonly id: number; readonly symbols: ReadonlySet<string>; readonly currency: Currency; readonly mode: TradingMode;
  constructor(private readonly cfg: CompositeConfig, private readonly a: Strategy, private readonly b: Strategy) {
    this.id = cfg.id; this.symbols = new Set([cfg.symbol]); this.currency = cfg.currency; this.mode = cfg.mode;
  }
  signal(quote: Quote): Signal {
    const sa = this.a.signal!(quote), sb = this.b.signal!(quote);
    if (this.cfg.combine === 'AND') {
      if (sa === 'BEARISH' || sb === 'BEARISH') return 'BEARISH';
      return sa === 'BULLISH' && sb === 'BULLISH' ? 'BULLISH' : 'NEUTRAL';
    }
    if (sa === 'BULLISH' || sb === 'BULLISH') return 'BULLISH';
    return sa === 'BEARISH' && sb === 'BEARISH' ? 'BEARISH' : 'NEUTRAL';
  }
  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    return signalToIntent(this.signal(quote), position?.quantity ?? 0,
      { currency: this.currency, price: quote.last, orderNotional: this.cfg.orderNotional });
  }
  serialize(): unknown { return { a: this.a.serialize?.(), b: this.b.serialize?.() }; }
  deserialize(state: unknown): void {
    const s = state as { a?: unknown; b?: unknown };
    if (s?.a !== undefined) this.a.deserialize?.(s.a);
    if (s?.b !== undefined) this.b.deserialize?.(s.b);
  }
}
