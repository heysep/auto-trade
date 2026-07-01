import type { Order, Fill, Position, TradingMode, EquitySnapshot } from '../domain/types.js';
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
  allOrders(mode?: TradingMode): Order[];
  getPosition(strategyId: number, symbol: string, mode: TradingMode): Position | undefined;
  getPositions(strategyId: number, mode: TradingMode): Position[];
  allPositions(mode?: TradingMode): Position[];
  upsertPosition(pos: Position): void;
  saveEquitySnapshot(snap: EquitySnapshot): void;            // upsert by (strategy, mode, day)
  getEquitySnapshots(strategyId: number, mode: TradingMode): EquitySnapshot[];   // chronological
}

/** Serializable snapshot of the whole repo — for file-based durability across restarts. */
export interface RepoSnapshot {
  orders: Order[];
  byIdem: [string, string][];
  fills: [string, Fill[]][];
  positions: Position[];
  equity: EquitySnapshot[];
}

export class InMemoryRepository implements OrderRepository {
  private orders = new Map<string, Order>();
  private byIdem = new Map<string, string>();           // idempotencyKey -> orderId
  private fills = new Map<string, Fill[]>();             // orderId -> fills
  private positions = new Map<string, Position>();       // strategyId:symbol:mode
  private equity = new Map<string, EquitySnapshot>();    // strategyId:mode:day

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
  allOrders(mode?: TradingMode): Order[] {
    const all = [...this.orders.values()];
    return mode ? all.filter((o) => o.mode === mode) : all;
  }
  getPosition(strategyId: number, symbol: string, mode: TradingMode): Position | undefined {
    return this.positions.get(this.posKey(strategyId, symbol, mode));
  }
  getPositions(strategyId: number, mode: TradingMode): Position[] {
    return [...this.positions.values()].filter(
      (p) => p.strategyId === strategyId && p.mode === mode,
    );
  }
  allPositions(mode?: TradingMode): Position[] {
    const all = [...this.positions.values()];
    return mode ? all.filter((p) => p.mode === mode) : all;
  }
  upsertPosition(pos: Position): void {
    this.positions.set(this.posKey(pos.strategyId, pos.symbol, pos.mode), pos);
  }
  saveEquitySnapshot(snap: EquitySnapshot): void {
    this.equity.set(`${snap.strategyId}:${snap.mode}:${snap.day}`, snap);   // one row per day
  }
  getEquitySnapshots(strategyId: number, mode: TradingMode): EquitySnapshot[] {
    return [...this.equity.values()]
      .filter((s) => s.strategyId === strategyId && s.mode === mode)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  // --- durability ---
  dump(): RepoSnapshot {
    return {
      orders: [...this.orders.values()],
      byIdem: [...this.byIdem.entries()],
      fills: [...this.fills.entries()],
      positions: [...this.positions.values()],
      equity: [...this.equity.values()],
    };
  }

  restore(s: RepoSnapshot): void {
    this.orders = new Map(s.orders.map((o) => [o.id, o]));
    this.byIdem = new Map(s.byIdem);
    this.fills = new Map(s.fills);
    this.positions = new Map(s.positions.map((p) => [this.posKey(p.strategyId, p.symbol, p.mode), p]));
    this.equity = new Map(s.equity.map((e) => [`${e.strategyId}:${e.mode}:${e.day}`, e]));
  }
}
