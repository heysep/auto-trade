import type { Broker, BrokerOrder } from './Broker.js';
import type {
  OrderRequest, OrderResult, Order, Fill, Position, OrderStatus, Currency, OrderSide, OrderType,
} from '../domain/types.js';
import type { Quote } from '../domain/types.js';
import type { PriceSource } from '../market/PriceSource.js';
import type { OrderRepository } from '../persistence/repository.js';
import { roundMoney } from '../domain/money.js';
import { assertValidOrder } from '../domain/orderValidation.js';
import { applyFillToPosition } from '../domain/positionAccounting.js';
import type { TradeTracker } from '../risk/TradeTracker.js';
import {
  type FeeConfig, DEFAULT_FEES, commission, tax, applySlippage,
} from './fees.js';

export interface PaperBrokerOptions {
  fees?: FeeConfig;
  now?: () => number;
  /** Reject fills against quotes older than this (ms). Default 5 min. */
  maxQuoteAgeMs?: number;
  /** Called when a resting order fails to fill on a quote (e.g. oversell). */
  onReject?: (order: Order, err: unknown) => void;
  /** Tracks round-trip outcomes for the risk halts. */
  tracker?: TradeTracker;
}

/** Just the fields needed to price/fill/account a trade — shared by Order & OrderRequest. */
type TradeParams = {
  strategyId: number; symbol: string; currency: Currency;
  side: OrderSide; orderType: OrderType; quantity: number; limitPrice?: number;
};

/**
 * Simulated broker: records virtual fills in the repository, no Toss calls.
 * Pricing: MARKET fills at the slippage-adjusted touch; marketable LIMIT fills at
 * the slippage-adjusted touch capped at the limit; non-marketable LIMIT rests
 * PENDING and is matched on later quotes via onQuote().
 * Accounting: average-cost basis (incl. buy fees), SELL realizes P&L, no shorting.
 * Validation happens BEFORE any persistence so a rejected order leaves no fill.
 */
export class PaperBroker implements Broker {
  private readonly fees: FeeConfig;
  private readonly now: () => number;
  private readonly maxQuoteAgeMs: number;
  private readonly onReject: ((order: Order, err: unknown) => void) | undefined;
  private readonly tracker: TradeTracker | undefined;

  constructor(
    private readonly repo: OrderRepository,
    private readonly prices: PriceSource,
    opts: PaperBrokerOptions = {},
  ) {
    this.fees = opts.fees ?? DEFAULT_FEES;
    this.now = opts.now ?? Date.now;
    this.maxQuoteAgeMs = opts.maxQuoteAgeMs ?? 5 * 60_000;
    this.onReject = opts.onReject;
    this.tracker = opts.tracker;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    // Idempotency: same key -> return the original outcome, never double-trade.
    const existing = this.repo.findByIdempotencyKey(req.idempotencyKey);
    if (existing) return { order: existing, fills: this.repo.getFills(existing.id) };

    this.validate(req);
    const quote = this.prices.getQuote(req.symbol);
    if (!quote) throw new Error(`No quote for ${req.symbol}; cannot paper-fill`);
    this.assertFresh(quote);

    const fillPrice = this.resolveFillPrice(req, quote.bid, quote.ask);
    if (fillPrice === null) {
      const order = this.newOrder(req, 'PENDING');   // non-marketable limit rests
      this.repo.saveOrder(order);
      return { order, fills: [] };
    }

    // Validate the position effect BEFORE persisting anything (no phantom fills).
    this.assertCanFill(req);
    const order = this.newOrder(req, 'FILLED');
    const fill = this.buildFill(order.id, req, fillPrice);
    this.repo.saveOrder(order);
    this.repo.addFill(fill);
    this.applyToPosition(req, fill);
    return { order, fills: [fill] };
  }

  /** Match resting PENDING limit orders against a fresh quote; fill those now crossed. */
  onQuote(quote: Quote): void {
    const resting = this.repo
      .getOpenOrdersBySymbol(quote.symbol, 'PAPER')
      .filter((o) => o.orderType === 'LIMIT' && o.status === 'PENDING');
    for (const order of resting) {
      const fp = this.resolveFillPrice(order, quote.bid, quote.ask);
      if (fp === null) continue;
      try {
        this.assertCanFill(order);
        const fill = this.buildFill(order.id, order, fp);
        this.repo.addFill(fill);
        this.repo.updateOrder({ ...order, status: 'FILLED' });
        this.applyToPosition(order, fill);
      } catch (err) {
        this.repo.updateOrder({ ...order, status: 'REJECTED' });
        this.onReject?.(order, err);
      }
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.repo.getOpenOrders('PAPER').find((o) => o.id === orderId);
    if (!order) return;
    this.repo.updateOrder({ ...order, status: 'CANCELED' });
  }

  getOpenOrders(): Promise<BrokerOrder[]> {
    return Promise.resolve(this.repo.getOpenOrders('PAPER').map((o) => ({
      brokerOrderId: o.id,
      symbol: o.symbol,
      side: o.side,
      status: o.status,
      quantity: o.quantity,
      filledQuantity: this.repo.getFills(o.id).reduce((s, f) => s + f.quantity, 0),
    })));
  }
  getFills(orderId: string): Promise<Fill[]> { return Promise.resolve(this.repo.getFills(orderId)); }

  // --- internals ---

  private validate(req: OrderRequest): void {
    assertValidOrder(req);
  }

  private assertFresh(quote: Quote): void {
    if (this.now() - quote.ts > this.maxQuoteAgeMs) {
      throw new Error(`Stale quote for ${quote.symbol} (age ${this.now() - quote.ts}ms)`);
    }
  }

  /** No shorting: a SELL must be covered by the held quantity. Throws if not. */
  private assertCanFill(p: TradeParams): void {
    if (p.side !== 'SELL') return;
    const pos = this.repo.getPosition(p.strategyId, p.symbol, 'PAPER');
    if (!pos || p.quantity > pos.quantity) {
      throw new Error(`Oversell: ${p.quantity} > position ${pos?.quantity ?? 0} for ${p.symbol}`);
    }
  }

  /** Fill price, or null if a LIMIT order is not marketable (rests open). */
  private resolveFillPrice(p: TradeParams, bid: number, ask: number): number | null {
    if (p.orderType === 'MARKET') {
      const touch = p.side === 'BUY' ? ask : bid;
      return applySlippage(touch, p.side, this.fees);
    }
    const limit = p.limitPrice!;
    if (p.side === 'BUY') {
      if (ask > limit) return null;                          // not marketable
      return Math.min(applySlippage(ask, 'BUY', this.fees), limit);   // pay spread, capped at limit
    }
    if (bid < limit) return null;
    return Math.max(applySlippage(bid, 'SELL', this.fees), limit);
  }

  private buildFill(orderId: string, p: TradeParams, rawPrice: number): Fill {
    const price = roundMoney(rawPrice, p.currency);
    const gross = price * p.quantity;                        // fee/tax from the SAME rounded gross
    return {
      orderId,
      quantity: p.quantity,
      price,
      fee: commission(gross, p.currency, this.fees),
      tax: tax(gross, p.currency, p.side, this.fees),
      filledAt: this.now(),
    };
  }

  private newOrder(req: OrderRequest, status: OrderStatus): Order {
    return {
      id: req.idempotencyKey,
      strategyId: req.strategyId,
      symbol: req.symbol,
      currency: req.currency,
      side: req.side,
      orderType: req.orderType,
      quantity: req.quantity,
      ...(req.limitPrice !== undefined ? { limitPrice: req.limitPrice } : {}),
      status,
      mode: 'PAPER',
      idempotencyKey: req.idempotencyKey,
      createdAt: this.now(),
    };
  }

  private applyToPosition(p: TradeParams, fill: Fill): void {
    // Shared average-cost accounting (also used by ReconciliationService for live fills).
    const effect = applyFillToPosition(this.repo, {
      strategyId: p.strategyId, symbol: p.symbol, currency: p.currency, side: p.side, mode: 'PAPER',
    }, fill);
    this.tracker?.onFill(
      { strategyId: p.strategyId, symbol: p.symbol, mode: 'PAPER', currency: p.currency },
      effect, fill.filledAt,
    );
  }
}
