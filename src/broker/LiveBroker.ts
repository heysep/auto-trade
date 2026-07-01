import type { Broker, BrokerOrder } from './Broker.js';
import type { OrderRequest, OrderResult, Order, Fill } from '../domain/types.js';
import type { OrderCreateRequest, TossOrder } from '../toss/types.js';
import type { OrderRepository } from '../persistence/repository.js';
import { parseNum } from '../domain/money.js';
import { assertValidOrder } from '../domain/orderValidation.js';

/** Just the slice of TossApiClient that LiveBroker needs (keeps it mockable). */
export interface LiveOrderClient {
  placeOrder(account: string, order: OrderCreateRequest): Promise<{ orderId: string }>;
  cancelOrder(account: string, orderId: string): Promise<unknown>;
  getOrders(account: string, status: 'OPEN' | 'CLOSED'): Promise<{ orders: TossOrder[] }>;
  getOrder(account: string, orderId: string): Promise<TossOrder>;
}

export interface LiveBrokerOptions {
  /** Hard safety switch — placeOrder throws unless explicitly enabled (default false). */
  enabled?: boolean;
  now?: () => number;
  /** Emergency kill switch predicate — when true, no live order is placed. */
  isHalted?: () => boolean;
}

/**
 * Real broker over the Toss Open API. DISABLED by default: a strategy must be
 * approved-LIVE and the broker explicitly enabled before any order is placed.
 * Cancels/reads stay available even when disabled (de-risking & reconciliation).
 */
export class LiveBroker implements Broker {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly isHalted: (() => boolean) | undefined;

  constructor(
    private readonly client: LiveOrderClient,
    private readonly account: string,    // accountSeq
    private readonly repo: OrderRepository,
    opts: LiveBrokerOptions = {},
  ) {
    this.enabled = opts.enabled ?? false;
    this.now = opts.now ?? Date.now;
    this.isHalted = opts.isHalted;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (this.isHalted?.()) throw new Error('trading halted; refusing to place a live order');
    if (!this.enabled) throw new Error('LiveBroker is disabled; refusing to place a live order');
    assertValidOrder(req);   // same guard as PaperBroker — reject before hitting the live API

    const body: OrderCreateRequest = {
      clientOrderId: req.idempotencyKey,        // dedup at the broker too
      symbol: req.symbol,
      side: req.side,
      orderType: req.orderType,
      quantity: String(req.quantity),           // Toss expects string numerics
      ...(req.limitPrice !== undefined ? { price: String(req.limitPrice) } : {}),
    };
    const res = await this.client.placeOrder(this.account, body);

    // Create response carries only { orderId } — status is unknown until queried,
    // so report PENDING with no fills; reconciliation/polling resolves the rest.
    const order: Order = {
      id: res.orderId,
      strategyId: req.strategyId,
      symbol: req.symbol,
      currency: req.currency,
      side: req.side,
      orderType: req.orderType,
      quantity: req.quantity,
      ...(req.limitPrice !== undefined ? { limitPrice: req.limitPrice } : {}),
      status: 'PENDING',
      mode: 'LIVE',
      idempotencyKey: req.idempotencyKey,
      createdAt: this.now(),
    };
    // Persist so reconciliation can match (local id == Toss orderId) and book fills.
    this.repo.saveOrder(order);
    return { order, fills: [] };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(this.account, orderId);
  }

  async getOpenOrders(): Promise<BrokerOrder[]> {
    const { orders } = await this.client.getOrders(this.account, 'OPEN');
    return orders.map((o) => ({
      brokerOrderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      status: o.status,
      quantity: parseNum(o.quantity ?? '0'),
      filledQuantity: parseNum(o.execution?.filledQuantity ?? '0'),
    }));
  }

  async getFills(orderId: string): Promise<Fill[]> {
    const o = await this.client.getOrder(this.account, orderId);
    const ex = o.execution;
    if (!ex || !ex.filledQuantity || parseNum(ex.filledQuantity) === 0) return [];
    if (ex.averageFilledPrice === undefined) {
      throw new Error(`Fill for ${orderId} has quantity but no averageFilledPrice`);
    }
    const t = ex.filledAt ? Date.parse(ex.filledAt) : NaN;   // guard malformed dates
    return [{
      orderId,
      quantity: parseNum(ex.filledQuantity),
      price: parseNum(ex.averageFilledPrice),
      fee: parseNum(ex.commission ?? '0'),
      tax: parseNum(ex.tax ?? '0'),
      filledAt: Number.isFinite(t) ? t : this.now(),
    }];
  }
}
