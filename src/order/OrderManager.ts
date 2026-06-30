import type { Broker } from '../broker/Broker.js';
import type { OrderRequest, OrderResult, Quote, TradingMode } from '../domain/types.js';
import type { Strategy, OrderIntent } from '../strategy/Strategy.js';
import { RiskManager, type RiskContext } from '../risk/RiskManager.js';
import type { EventLogger } from '../observability/EventLogger.js';

export type OrderOutcome =
  | { status: 'placed'; result: OrderResult }
  | { status: 'blocked'; reason: string }
  | { status: 'error'; error: unknown };

export interface OrderManagerDeps {
  brokerFor: (mode: TradingMode) => Broker;
  risk: RiskManager;
  riskContext: (strategy: Strategy, symbol: string) => RiskContext;
  logger: EventLogger;
  now?: () => number;
  /** Safety buffer over the ask for sizing MARKET buys, so the risk gate prices
   *  the worst-case fill (ask + slippage), not the optimistic last. Default 50 bps. */
  marketBufferBps?: number;
}

/**
 * Single choke point from signal -> order. Builds a deterministic idempotency key,
 * runs the risk gate, routes to the Paper/Live broker, and logs every outcome.
 */
export class OrderManager {
  private readonly now: () => number;
  private readonly marketBufferBps: number;
  constructor(private readonly deps: OrderManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.marketBufferBps = deps.marketBufferBps ?? 50;
  }

  async handleIntent(strategy: Strategy, intent: OrderIntent, quote: Quote): Promise<OrderOutcome> {
    // For MARKET, size against the worst-case fill (ask + buffer), not the optimistic
    // last; LIMIT's limitPrice is already a correct upper bound.
    const referencePrice = intent.orderType === 'LIMIT' && intent.limitPrice !== undefined
      ? intent.limitPrice
      : quote.ask * (1 + this.marketBufferBps / 10_000);
    const order: OrderRequest = {
      strategyId: strategy.id,
      symbol: quote.symbol,
      currency: strategy.currency,
      side: intent.side,
      orderType: intent.orderType,
      quantity: intent.quantity,
      ...(intent.limitPrice !== undefined ? { limitPrice: intent.limitPrice } : {}),
      // Deterministic but intent-specific: same reprocessed intent dedups, while two
      // distinct same-side intents at the same ts (feed replay / coarse ts) don't collide.
      idempotencyKey:
        `${strategy.id}-${quote.symbol}-${intent.side}-${intent.orderType}` +
        `-${intent.quantity}-${intent.limitPrice ?? 'M'}-${quote.ts}`,
    };

    const ctx = this.deps.riskContext(strategy, quote.symbol);
    const decision = this.deps.risk.check(order, referencePrice, ctx);
    if (!decision.allowed) {
      const reason = decision.reason ?? 'blocked';
      this.safeLog({
        type: 'RISK_BLOCKED', strategyId: strategy.id, symbol: quote.symbol,
        message: reason, payload: { intent }, at: this.now(),
      });
      return { status: 'blocked', reason };
    }

    // placeOrder and logging are separated: a logging fault must NOT be misread as a
    // failed (but actually executed) order.
    let result: OrderResult;
    try {
      result = await this.deps.brokerFor(strategy.mode).placeOrder(order);
    } catch (error) {
      this.safeLog({
        type: 'ORDER_ERROR', strategyId: strategy.id, symbol: quote.symbol,
        message: error instanceof Error ? error.message : String(error), at: this.now(),
      });
      return { status: 'error', error };
    }
    this.safeLog({
      type: 'ORDER_PLACED', strategyId: strategy.id, symbol: quote.symbol,
      message: intent.reason,
      payload: { orderId: result.order.id, status: result.order.status, fills: result.fills.length },
      at: this.now(),
    });
    return { status: 'placed', result };
  }

  /** Logging must never alter trading control flow. */
  private safeLog(e: Parameters<EventLogger['log']>[0]): void {
    try { this.deps.logger.log(e); } catch { /* swallow logger faults */ }
  }
}
