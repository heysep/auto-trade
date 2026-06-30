import type { Quote, Position, TradingMode } from '../domain/types.js';
import type { Strategy } from './Strategy.js';
import type { OrderManager } from '../order/OrderManager.js';

export interface StrategyEngineDeps {
  orderManager: OrderManager;
  /** Current position for a strategy's symbol (undefined = flat). */
  getPosition: (strategyId: number, symbol: string, mode: TradingMode) => Position | undefined;
  /** Optional: drive resting-LIMIT matching (e.g. PaperBroker.onQuote) before strategies run. */
  onQuote?: (quote: Quote) => void | Promise<void>;
  onError?: (err: unknown) => void;
}

/**
 * Routes each PRICE_TICK to interested strategies, turns their intents into orders
 * via OrderManager. Wire onTick to MarketDataWorker. One strategy's failure is
 * isolated so it can't blank the others on the same tick.
 */
export class StrategyEngine {
  private readonly strategies = new Map<number, Strategy>();
  private readonly inflight = new Set<string>();   // re-entrancy guard per strategy+symbol
  constructor(private readonly deps: StrategyEngineDeps) {}

  register(strategy: Strategy): void { this.strategies.set(strategy.id, strategy); }
  unregister(id: number): void { this.strategies.delete(id); }

  async onTick(quote: Quote): Promise<void> {
    // Match resting limits first so strategies see post-fill positions this tick.
    try { await this.deps.onQuote?.(quote); } catch (err) { this.deps.onError?.(err); }

    for (const strategy of this.strategies.values()) {
      if (!strategy.symbols.has(quote.symbol)) continue;
      // Skip if a prior tick is still processing this strategy+symbol — prevents
      // overlapping ticks from both passing the no-stacking gate and double-trading.
      const key = `${strategy.id}:${quote.symbol}`;
      if (this.inflight.has(key)) continue;
      this.inflight.add(key);
      try {
        const position = this.deps.getPosition(strategy.id, quote.symbol, strategy.mode);
        const intent = strategy.evaluate({ quote, position });
        if (intent) await this.deps.orderManager.handleIntent(strategy, intent, quote);
      } catch (err) {
        this.deps.onError?.(err);
      } finally {
        this.inflight.delete(key);
      }
    }
  }
}
