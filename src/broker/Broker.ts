import type { OrderRequest, OrderResult, Fill, OrderSide, OrderStatus } from '../domain/types.js';

/** Broker-side view of an open order (no strategyId — that's our internal concept). */
export interface BrokerOrder {
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  quantity: number;
  filledQuantity: number;
}

// The contract that strategies depend on. PaperBroker and LiveBroker both
// implement it, so a verified paper strategy promotes to LIVE unchanged.
export interface Broker {
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  getOpenOrders(): Promise<BrokerOrder[]>;     // broker-native; for reconciliation
  getFills(orderId: string): Promise<Fill[]>;
}
