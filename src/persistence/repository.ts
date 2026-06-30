import type { Order, Fill, Position, TradingMode } from '../domain/types.js';
import { OPEN_STATUSES } from '../toss/types.js';

const isOpen = (o: Order): boolean => OPEN_STATUSES.includes(o.status);

// Storage abstraction so PaperBroker has no DB dependency (testable in-memory;
// a Postgres impl lands when db/migrations/001_init.sql is wired).
export interface OrderRepository {
  findByIdempotencyKey(key: string): Order | undefined;
  saveOrder(order: Order): void;
  updateOrder(order: Order): void;
  addFill(fill: Fill): void;
  getFills(orderId: string): Fill[];
  getOpenOrders(mode: TradingMode): Order[];
  getOpenOrdersBySymbol(symbol: string, mode: TradingMode): Order[];
  getPosition(strategyId: number, symbol: string, mode: TradingMode): Position | undefined;
  getPositions(strategyId: number, mode: TradingMode): Position[];
  upsertPosition(pos: Position): void;
}

export class InMemoryRepository implements OrderRepository {
  private orders = new Map<string, Order>();
  private byIdem = new Map<string, string>();           // idempotencyKey -> orderId
  private fills = new Map<string, Fill[]>();             // orderId -> fills
  private positions = new Map<string, Position>();       // strategyId:symbol:mode

  private posKey(s: number, sym: string, m: TradingMode): string { return `${s}:${sym}:${m}`; }

  findByIdempotencyKey(key: string): Order | undefined {
    const id = this.byIdem.get(key);
    return id ? this.orders.get(id) : undefined;
  }
  saveOrder(order: Order): void {
    this.orders.set(order.id, order);
    this.byIdem.set(order.idempotencyKey, order.id);
  }
  updateOrder(order: Order): void { this.orders.set(order.id, order); }
  addFill(fill: Fill): void {
    const arr = this.fills.get(fill.orderId) ?? [];
    arr.push(fill);
    this.fills.set(fill.orderId, arr);
  }
  getFills(orderId: string): Fill[] { return this.fills.get(orderId) ?? []; }
  getOpenOrders(mode: TradingMode): Order[] {
    return [...this.orders.values()].filter((o) => o.mode === mode && isOpen(o));
  }
  getOpenOrdersBySymbol(symbol: string, mode: TradingMode): Order[] {
    return [...this.orders.values()].filter(
      (o) => o.mode === mode && o.symbol === symbol && isOpen(o),
    );
  }
  getPosition(strategyId: number, symbol: string, mode: TradingMode): Position | undefined {
    return this.positions.get(this.posKey(strategyId, symbol, mode));
  }
  getPositions(strategyId: number, mode: TradingMode): Position[] {
    return [...this.positions.values()].filter(
      (p) => p.strategyId === strategyId && p.mode === mode,
    );
  }
  upsertPosition(pos: Position): void {
    this.positions.set(this.posKey(pos.strategyId, pos.symbol, pos.mode), pos);
  }
}
