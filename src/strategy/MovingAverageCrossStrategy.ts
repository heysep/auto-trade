import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode } from '../domain/types.js';
import type { Signal } from './signal.js';
import { signalToIntent } from './signal.js';
import { isValidQuantity } from '../domain/money.js';

export interface MaCrossConfig {
  id: number;
  symbol: string;
  currency: Currency;
  mode: TradingMode;
  fastPeriod: number;       // short window
  slowPeriod: number;       // long window (> fastPeriod)
  orderNotional: number;    // cash to deploy per entry
}

/**
 * SMA crossover, modelled as STATE-TARGETING rather than edge-detection: the desired state
 * is "long while fast SMA > slow SMA, flat while fast < slow" (equality holds the current
 * state). It emits an order only when the actual position differs from that target, and
 * RE-EMITS every tick until it matches — so a BUY/SELL blocked by the risk gate or kill
 * switch is retried instead of lost, and the strategy is restart-safe (no edge state to
 * persist). Same-position re-emits are deduped by OrderManager's idempotency key.
 *
 * ⚠️ The window is over price *ticks/polls*, not fixed-time bars — its "N-period" meaning
 * depends on poll cadence and ignores market-closed gaps. Bar aggregation is future work.
 */
export class MovingAverageCrossStrategy implements Strategy {
  readonly id: number;
  readonly symbols: ReadonlySet<string>;
  readonly currency: Currency;
  readonly mode: TradingMode;

  private readonly prices: number[] = [];
  private lastSeenTs = -Infinity;     // replay/duplicate-tick guard

  constructor(private readonly cfg: MaCrossConfig) {
    const { fastPeriod, slowPeriod } = cfg;
    if (!Number.isInteger(fastPeriod) || fastPeriod < 1) throw new Error('fastPeriod must be a positive integer');
    if (!Number.isInteger(slowPeriod) || slowPeriod <= fastPeriod) throw new Error('slowPeriod must be an integer > fastPeriod');
    this.id = cfg.id;
    this.symbols = new Set([cfg.symbol]);
    this.currency = cfg.currency;
    this.mode = cfg.mode;
  }

  signal(quote: { ts: number; last: number }): Signal {
    if (quote.ts <= this.lastSeenTs) return 'NEUTRAL';   // ignore re-delivered / same-bar ticks
    this.lastSeenTs = quote.ts;

    this.prices.push(quote.last);
    if (this.prices.length > this.cfg.slowPeriod) this.prices.shift();   // bounded window
    if (this.prices.length < this.cfg.slowPeriod) return 'NEUTRAL';      // not enough history yet

    const fast = sma(this.prices, this.cfg.fastPeriod);
    const slow = sma(this.prices, this.cfg.slowPeriod);

    if (fast > slow) return 'BULLISH';
    if (fast < slow) return 'BEARISH';
    return 'NEUTRAL';
  }

  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    return signalToIntent(this.signal(quote), position?.quantity ?? 0,
      { currency: this.currency, price: quote.last, orderNotional: this.cfg.orderNotional });
  }

  // Persist the price window so a restart doesn't cold-start the indicator while holding
  // a restored position (which would blind exits during warm-up).
  serialize(): unknown {
    return { prices: [...this.prices], lastSeenTs: this.lastSeenTs };
  }

  deserialize(state: unknown): void {
    const s = state as { prices?: unknown; lastSeenTs?: unknown };
    if (Array.isArray(s.prices) && s.prices.every((p) => typeof p === 'number')) {
      this.prices.length = 0;
      this.prices.push(...(s.prices as number[]).slice(-this.cfg.slowPeriod));
    }
    if (typeof s.lastSeenTs === 'number') this.lastSeenTs = s.lastSeenTs;
  }
}

/** Simple moving average of the last `period` elements of `xs`. */
function sma(xs: number[], period: number): number {
  if (period <= 0 || period > xs.length) throw new Error(`sma: invalid period ${period} for length ${xs.length}`);
  const window = xs.slice(xs.length - period);            // number[] -> no unchecked index access
  return window.reduce((a, b) => a + b, 0) / period;
}
