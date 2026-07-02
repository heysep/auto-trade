import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode, Quote } from '../domain/types.js';
import { type Signal, signalToIntent } from './signal.js';

export interface TsMomConfig {
  id: number;
  symbol: string;
  currency: Currency;
  mode: TradingMode;
  lookback: number;        // bars over which to measure the trailing return
  threshold?: number;      // dead-band as a fraction (e.g. 0.0 = pure sign, 0.02 = ±2%)
  orderNotional: number;
}

/**
 * AQR-style TIME-SERIES MOMENTUM (Moskowitz–Ooi–Pedersen "Time Series Momentum"): go long
 * when the trailing `lookback`-bar return is positive, flat/short-bias when it is negative.
 * This is the price-only skeleton of AQR's momentum sleeve — a per-symbol time-series signal,
 * as opposed to cross-sectional value/quality factors which need fundamental data (out of scope).
 *
 * signal: BULLISH when trailing return > +threshold, BEARISH when < -threshold, else NEUTRAL.
 * Modelled as a position-independent Signal so it composes (AND/OR) with other strategies.
 */
export class TimeSeriesMomentumStrategy implements Strategy {
  readonly id: number;
  readonly symbols: ReadonlySet<string>;
  readonly currency: Currency;
  readonly mode: TradingMode;

  private readonly prices: number[] = [];
  private lastSeenTs = -Infinity;

  constructor(private readonly cfg: TsMomConfig) {
    if (!Number.isInteger(cfg.lookback) || cfg.lookback < 1) {
      throw new Error('lookback must be a positive integer');
    }
    if (cfg.threshold !== undefined && !(cfg.threshold >= 0)) {
      throw new Error('threshold must be >= 0');
    }
    this.id = cfg.id;
    this.symbols = new Set([cfg.symbol]);
    this.currency = cfg.currency;
    this.mode = cfg.mode;
  }

  signal(quote: Quote): Signal {
    if (quote.ts <= this.lastSeenTs) return 'NEUTRAL';   // ignore re-delivered / same-bar ticks
    this.lastSeenTs = quote.ts;

    this.prices.push(quote.last);
    if (this.prices.length > this.cfg.lookback + 1) this.prices.shift();   // need lookback+1 points
    if (this.prices.length < this.cfg.lookback + 1) return 'NEUTRAL';      // warming up

    const past = this.prices[0]!;                                          // price `lookback` bars ago
    if (!(past > 0)) return 'NEUTRAL';
    const trailingReturn = (quote.last - past) / past;
    const band = this.cfg.threshold ?? 0;

    if (trailingReturn > band) return 'BULLISH';
    if (trailingReturn < -band) return 'BEARISH';
    return 'NEUTRAL';
  }

  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    return signalToIntent(this.signal(quote), position?.quantity ?? 0,
      { currency: this.currency, price: quote.last, orderNotional: this.cfg.orderNotional });
  }

  serialize(): unknown {
    return { prices: [...this.prices], lastSeenTs: this.lastSeenTs };
  }

  deserialize(state: unknown): void {
    const s = state as { prices?: unknown; lastSeenTs?: unknown };
    if (Array.isArray(s.prices) && s.prices.every((p) => typeof p === 'number')) {
      this.prices.length = 0;
      this.prices.push(...(s.prices as number[]).slice(-(this.cfg.lookback + 1)));
    }
    if (typeof s.lastSeenTs === 'number') this.lastSeenTs = s.lastSeenTs;
  }
}
