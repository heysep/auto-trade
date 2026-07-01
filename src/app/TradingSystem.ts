import type { OrderRepository } from '../persistence/repository.js';
import type { QuoteBook } from '../market/PriceSource.js';
import type { StrategyRegistry, StrategyView } from '../strategy/StrategyRegistry.js';
import type { InMemoryEventLogger, LogEvent } from '../observability/EventLogger.js';
import type { HaltSwitch } from './HaltSwitch.js';
import type { Position, Order, Quote, TradingMode, StrategyStatus } from '../domain/types.js';
import { evaluatePromotion, type PromotionInput } from '../strategy/PromotionGate.js';
import type { SymbolCatalog } from '../market/SymbolCatalog.js';
import type { TossStock, TossCandle } from '../toss/types.js';
import { buildStrategy, type StrategySpec } from '../strategy/strategySpec.js';
import { BacktestEngine } from '../backtest/BacktestEngine.js';
import { parseNum } from '../domain/money.js';
import type { PerformanceMetrics } from '../performance/PerformanceAnalyzer.js';

// Legal status transitions (PLAN §7 lifecycle). REJECTED is terminal.
const TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  DRAFT: ['BACKTESTING', 'REJECTED'],
  BACKTESTING: ['PAPER_TESTING', 'REJECTED'],
  PAPER_TESTING: ['APPROVED', 'PAUSED', 'REJECTED'],
  APPROVED: ['LIVE', 'PAUSED', 'REJECTED'],
  LIVE: ['PAUSED', 'REJECTED'],
  PAUSED: ['PAPER_TESTING', 'APPROVED', 'LIVE', 'REJECTED'],
  REJECTED: [],
};
const GATED: StrategyStatus[] = ['APPROVED', 'LIVE'];   // require approval + promotion criteria

export type StatusChangeResult =
  | { ok: true; view: StrategyView }
  | { ok: false; code: number; error: string; failures?: string[] };

export interface TradingSystemDeps {
  repo: OrderRepository;
  book: QuoteBook;
  registry: StrategyRegistry;
  logger: InMemoryEventLogger;
  haltSwitch: HaltSwitch;
  /** Supplies promotion metrics for a strategy. Omitted/zero-data => fails closed (no LIVE). */
  promotionInputFor?: (strategyId: number) => PromotionInput | undefined;
  now?: () => number;
  /** Searchable stock symbol catalog. Omitted => searchSymbols returns []. */
  symbolCatalog?: SymbolCatalog;
  /** Candle fetcher. Omitted => candles returns []. */
  getCandles?: (symbol: string, interval: string) => Promise<TossCandle[]>;
}

/** Read/command facade the HTTP API talks to — keeps Fastify routes thin. */
export class TradingSystem {
  private readonly now: () => number;
  constructor(private readonly deps: TradingSystemDeps) {
    this.now = deps.now ?? Date.now;
  }

  get registry(): StrategyRegistry { return this.deps.registry; }

  /** PLAN §11 #10 — trip the kill switch. Brokers + OrderManager then refuse all orders.
   *  The market worker keeps running (quotes only), so resume() is instant and safe. */
  emergencyStop(reason: string): void {
    this.deps.haltSwitch.trip(reason);
    this.deps.logger.log({ type: 'EMERGENCY_STOP', message: reason, at: this.now() });
  }

  resume(): void {
    this.deps.haltSwitch.reset();
    this.deps.logger.log({ type: 'TRADING_RESUMED', at: this.now() });
  }

  haltStatus(): { halted: boolean; reason: string | undefined } {
    return { halted: this.deps.haltSwitch.halted, reason: this.deps.haltSwitch.reason };
  }

  /**
   * Lifecycle transition gate. Illegal transitions are rejected; moving into APPROVED/LIVE
   * additionally requires explicit approval AND passing the PLAN §7 promotion criteria —
   * with no metrics this FAILS CLOSED, so the API can never flip an un-vetted strategy LIVE.
   */
  changeStatus(id: number, to: StrategyStatus, opts: { approved?: boolean } = {}): StatusChangeResult {
    const entry = this.deps.registry.entry(id);
    if (!entry) return { ok: false, code: 404, error: 'strategy not found' };
    const from = entry.status;
    if (!TRANSITIONS[from].includes(to)) {
      return { ok: false, code: 400, error: `illegal transition ${from} -> ${to}` };
    }
    if (GATED.includes(to)) {
      if (opts.approved !== true) {
        return { ok: false, code: 403, error: `transition to ${to} requires explicit approval` };
      }
      const input = this.deps.promotionInputFor?.(id);
      const result = input
        ? evaluatePromotion(input)
        : { eligible: false, failures: ['no promotion metrics available'] };
      if (!result.eligible) {
        return { ok: false, code: 403, error: 'promotion criteria not met', failures: result.failures };
      }
    }
    const view = this.deps.registry.setStatus(id, to)!;
    this.deps.logger.log({
      type: 'STATUS_CHANGE', strategyId: id, message: `${from} -> ${to}`, at: this.now(),
    });
    return { ok: true, view };
  }

  listPositions(mode: TradingMode = 'PAPER', strategyId?: number): Position[] {
    return strategyId === undefined
      ? this.deps.repo.allPositions(mode)
      : this.deps.repo.getPositions(strategyId, mode);
  }

  listOrders(mode: TradingMode = 'PAPER'): Order[] { return this.deps.repo.allOrders(mode); }

  quote(symbol: string): Quote | undefined { return this.deps.book.getQuote(symbol); }

  quotes(symbols: string[]): Quote[] {
    return symbols.map((s) => this.deps.book.getQuote(s)).filter((q): q is Quote => q !== undefined);
  }

  logs(limit = 100): LogEvent[] {
    const all = this.deps.logger.events;
    return all.slice(Math.max(0, all.length - limit));
  }

  async searchSymbols(query: string, limit?: number): Promise<TossStock[]> {
    if (!this.deps.symbolCatalog) return [];
    if (limit !== undefined) {
      return this.deps.symbolCatalog.search(query, limit);
    }
    return this.deps.symbolCatalog.search(query);
  }

  async candles(symbol: string, interval: string): Promise<TossCandle[]> {
    if (!this.deps.getCandles) return [];
    return this.deps.getCandles(symbol, interval);
  }

  async backtest(input: {
    symbol: string;
    spec: StrategySpec;
    interval?: string;
    capital?: number;
  }): Promise<{
    metrics: PerformanceMetrics;
    equityCurve: number[];
    rejected: number;
    markers: { time: number; side: string; price: number }[];
  }> {
    const { symbol, spec, interval = '1D', capital = 10_000_000 } = input;
    const tossCandles = await this.candles(symbol, interval);
    const bars = tossCandles.map((c) => ({ ts: c.time, price: parseNum(c.close) }));
    const strategy = buildStrategy(1, symbol, 'KRW', 'PAPER', spec);
    const engine = new BacktestEngine();
    const result = await engine.run(strategy, bars, { capital, currency: 'KRW' });
    return {
      metrics: result.metrics,
      equityCurve: result.equityCurve,
      rejected: result.rejected,
      markers: result.fills.map(({ time, side, price }) => ({ time, side, price })),
    };
  }
}
