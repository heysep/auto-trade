import type { Currency } from './money.js';
import type { OrderStatus, OrderSide, OrderType } from '../toss/types.js';

export type { Currency };
export type TradingMode = 'PAPER' | 'LIVE';

export type StrategyStatus =
  | 'DRAFT' | 'BACKTESTING' | 'PAPER_TESTING'
  | 'APPROVED' | 'LIVE' | 'PAUSED' | 'REJECTED';

/** A request from a strategy to trade. Broker-agnostic. */
export interface OrderRequest {
  strategyId: number;
  symbol: string;
  currency: Currency;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;            // shares (KR integer, US fractional)
  limitPrice?: number;         // required for LIMIT
  idempotencyKey: string;      // -> Toss clientOrderId / orders.idempotency_key
}

/** Top-of-book quote used to price paper fills. */
export interface Quote {
  symbol: string;
  currency: Currency;
  bid: number;
  ask: number;
  last: number;
  ts: number;                  // epoch ms
}

export interface Fill {
  orderId: string;
  quantity: number;
  price: number;
  fee: number;
  tax: number;
  filledAt: number;
}

export interface Order {
  id: string;
  strategyId: number;
  symbol: string;
  currency: Currency;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  limitPrice?: number;
  status: OrderStatus;
  mode: TradingMode;
  idempotencyKey: string;
  createdAt: number;
}

export interface OrderResult {
  order: Order;
  fills: Fill[];
}

export interface Position {
  strategyId: number;
  symbol: string;
  mode: TradingMode;
  quantity: number;
  avgPrice: number;            // average-cost basis, includes buy fees
  realizedPnl: number;
}

export type { OrderStatus, OrderSide, OrderType };
