import type { OrderRepository } from '../persistence/repository.js';
import type { QuoteBook } from '../market/PriceSource.js';
import type { StrategyRegistry, StrategyView } from '../strategy/StrategyRegistry.js';
import type { InMemoryEventLogger, LogEvent } from '../observability/EventLogger.js';
import type { HaltSwitch } from './HaltSwitch.js';
import type { Position, Order, Quote, TradingMode, StrategyStatus } from '../domain/types.js';
import { evaluatePromotion, type PromotionInput } from '../strategy/PromotionGate.js';
import type { SymbolCatalog } from '../market/SymbolCatalog.js';
import type { TossStock, TossCandle, ChartCandle, TossPriceItem } from '../toss/types.js';
import { buildStrategy, type StrategySpec } from '../strategy/strategySpec.js';
import { BacktestEngine } from '../backtest/BacktestEngine.js';
import type { PerformanceMetrics } from '../performance/PerformanceAnalyzer.js';
import type { PerformanceService } from '../performance/PerformanceService.js';
import type { StrategyDeployer } from './StrategyDeployer.js';
import type { FactorRankingService, RankingResult } from '../factor/FactorRankingService.js';
import type { FactorBacktestService, FactorBacktestParams, FactorBacktestReport } from '../factor/FactorBacktestService.js';
import type { FactorPortfolioManager, RebalancePlan } from '../factor/FactorPortfolioManager.js';
import type { RebalanceScheduler } from '../factor/RebalanceScheduler.js';
import type { AccountService, AccountHoldingsView } from './AccountService.js';
import type { DcaService, DcaCompareResult, DcaCompareInput } from '../dca/DcaService.js';
import { validatePlan } from '../dca/dcaPlanValidation.js';
import type { DcaPlan } from '../dca/DcaBacktest.js';
import type { DcaPlanStore } from '../dca/DcaPlanStore.js';
import type { DcaPlanRunner, DcaActivePlan } from '../dca/DcaPlanRunner.js';
import type { WatchList } from '../market/WatchList.js';

/**
 * Infer quote/order currency from symbol format.
 * Korean stock codes are exactly 6 decimal digits (e.g. "005930").
 * Everything else (US tickers like "SPY") is USD.
 */
export function inferCurrency(symbol: string): 'KRW' | 'USD' {
  return /^\d{6}$/.test(symbol) ? 'KRW' : 'USD';
}

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

/** Reserved strategy id for the AQR 4-Factor Portfolio. Never used by StrategyEngine. */
export const FACTOR_PORTFOLIO_STRATEGY_ID = 1000;

/** Reserved strategy id for paper-mode DCA auto-invest. Never used by StrategyEngine. */
export const DCA_STRATEGY_ID = 2000;

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
  getCandles?: (symbol: string, interval: '1m' | '1d') => Promise<TossCandle[]>;
  /** Dynamic strategy deployer. Omitted => deploy() returns 400. */
  deployer?: StrategyDeployer;
  /** Universe factor ranking service. Omitted => factorRanking() returns 503. */
  factorRanking?: FactorRankingService;
  /** Universe factor backtest service. Omitted => factorBacktest() returns 503. */
  factorBacktest?: FactorBacktestService;
  /** Factor portfolio manager. Omitted => rebalanceFactorPortfolio() returns 503. */
  factorPortfolio?: FactorPortfolioManager;
  /** Price fetcher for rebalance. Omitted => rebalanceFactorPortfolio() returns 503. */
  getPrices?: (symbols: string[]) => Promise<TossPriceItem[]>;
  /** Top-N override for rebalance. Default: 10. */
  factorPortfolioTopN?: number;
  /** Mode used to query currently-held factor portfolio positions. Default: 'PAPER'. */
  factorPortfolioMode?: TradingMode;
  /** Injectable sleep for price-fetch retry backoff. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Auto-rebalance scheduler. Omitted => autoRebalanceStatus()/setAutoRebalance() return 503. */
  rebalanceScheduler?: RebalanceScheduler;
  /** Performance metrics + equity curve service. Omitted => performance() returns 503. */
  performance?: PerformanceService;
  /** Real Toss account holdings service (read-only). Omitted => accountHoldings() returns 503. */
  account?: AccountService;
  /** DCA comparison service. Omitted => dcaCompare() returns 503. */
  dca?: DcaService;
  /** Active DCA plan store. Omitted => all DCA plan endpoints return 503. */
  dcaStore?: DcaPlanStore;
  /** DCA plan runner (contribute logic). Omitted => runDcaNow() returns 503. */
  dcaRunner?: DcaPlanRunner;
  /** Symbol watch list. When wired, activateDcaPlan() registers the plan symbol so the
   *  market worker starts quoting it for future scheduled contributions. */
  watchList?: WatchList;
}

/** Read/command facade the HTTP API talks to — keeps Fastify routes thin. */
export class TradingSystem {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: TradingSystemDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  async candles(symbol: string, interval: '1m' | '1d'): Promise<ChartCandle[]> {
    if (!this.deps.getCandles) return [];
    const raw = await this.deps.getCandles(symbol, interval);
    return raw
      .map((c) => ({
        time: Math.floor(Date.parse(c.timestamp) / 1000),
        open: Number(c.openPrice),
        high: Number(c.highPrice),
        low: Number(c.lowPrice),
        close: Number(c.closePrice),
      }))
      .filter((c) => !Number.isNaN(c.time));
  }

  /** Deploy a dynamic strategy. Returns 400 if fields missing or no deployer configured. */
  deploy(input: { symbol: string; spec: StrategySpec; name: string }): { ok: true; view: StrategyView } | { ok: false; code: number; error: string } {
    if (!this.deps.deployer) {
      return { ok: false, code: 400, error: 'deployer not configured' };
    }
    const record = this.deps.deployer.deploy(input);
    const view = this.deps.registry.get(record.id);
    if (!view) return { ok: false, code: 500, error: 'internal: strategy not found after deploy' };
    return { ok: true, view };
  }

  /** Remove a deployed strategy by id. Returns false if unknown. */
  undeploy(id: number): boolean {
    return this.deps.deployer?.undeploy(id) ?? false;
  }

  /**
   * Run a factor backtest over the universe price matrix.
   * Returns a 503 error shape when no FactorBacktestService is wired.
   */
  async factorBacktest(params?: FactorBacktestParams): Promise<FactorBacktestReport | { error: string; code: number }> {
    const svc = this.deps.factorBacktest;
    if (svc === undefined) {
      return { error: 'factor backtest unavailable', code: 503 };
    }
    if (params !== undefined) {
      return svc.run(params);
    }
    return svc.run();
  }

  /**
   * Return the factor ranking for the configured universe.
   * Returns a 503 error shape when no FactorRankingService is wired.
   * `limit` slices the top-N entries without triggering a refetch within TTL.
   */
  async factorRanking(limit?: number): Promise<RankingResult | { error: string; code: number }> {
    const svc = this.deps.factorRanking;
    if (svc === undefined) {
      return { error: 'factor ranking unavailable', code: 503 };
    }
    if (limit !== undefined) {
      return svc.rank(limit);
    }
    return svc.rank();
  }

  /**
   * Fetch live prices for top-N ranked symbols UNION held symbols, populate QuoteBook,
   * then call FactorPortfolioManager.rebalance().
   * Returns 503 when factorPortfolio or getPrices dep is absent.
   * Returns 409 when halted.
   * Returns 502 when price fetch fails.
   */
  async rebalanceFactorPortfolio(): Promise<RebalancePlan | { error: string; code: number }> {
    const mgr = this.deps.factorPortfolio;
    const getPrices = this.deps.getPrices;
    if (mgr === undefined || getPrices === undefined) {
      return { error: 'factor portfolio unavailable', code: 503 };
    }
    if (this.deps.haltSwitch.halted) {
      return { error: 'trading halted', code: 409 };
    }

    const topN = this.deps.factorPortfolioTopN ?? 10;

    // Get ranking to know which symbols to fetch prices for
    const rankingSvc = this.deps.factorRanking;
    let topSymbols: string[] = [];
    if (rankingSvc !== undefined) {
      const result = await rankingSvc.rank(topN);
      topSymbols = result.scored.map((s) => s.symbol);
    }

    // Include held symbols so we can price exits.
    // Use the portfolio's actual mode (LIVE or PAPER) so LIVE positions are not missed.
    const portfolioMode = this.deps.factorPortfolioMode ?? 'PAPER';
    const held = this.deps.repo
      .getPositions(FACTOR_PORTFOLIO_STRATEGY_ID, portfolioMode)
      .filter((p) => p.quantity !== 0)
      .map((p) => p.symbol);

    const symbols = [...new Set([...topSymbols, ...held])];

    // Fetch prices with up to 3 attempts; short backoffs absorb transient post-ranking 429s.
    // A partial result (some symbols missing) is treated as success — the manager skips
    // any symbol whose price is absent from the QuoteBook.
    const MAX_ATTEMPTS = 3;
    const BACKOFFS_MS = [500, 1000] as const;
    let items: TossPriceItem[] | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        items = await getPrices(symbols);
        break;
      } catch {
        if (attempt < MAX_ATTEMPTS - 1) {
          await this.sleep(BACKOFFS_MS[attempt] ?? 1000);
        }
      }
    }
    if (items === undefined) {
      return { error: 'price fetch failed', code: 502 };
    }

    // Populate QuoteBook so FactorPortfolioManager.priceOf can find them.
    // Skip symbols that already have a fresh worker quote — the synthetic zero-spread
    // quote must not clobber real bid/ask that tick-driven strategies read (review M7).
    const FRESH_MS = 10_000;
    for (const item of items) {
      const last = Number(item.lastPrice);
      if (!Number.isFinite(last) || last <= 0) continue;
      const existing = this.deps.book.getQuote(item.symbol);
      if (existing && this.now() - existing.ts < FRESH_MS) continue;
      this.deps.book.set({
        symbol: item.symbol,
        currency: 'KRW',
        bid: last,
        ask: last,
        last,
        ts: this.now(),
      });
    }

    return mgr.rebalance();
  }

  autoRebalanceStatus(): { enabled: boolean; intervalMs: number; lastRun: ReturnType<RebalanceScheduler['lastRun']> } | { error: string; code: number } {
    const sched = this.deps.rebalanceScheduler;
    if (sched === undefined) return { error: 'auto-rebalance scheduler not wired', code: 503 };
    return { enabled: sched.enabled, intervalMs: sched.intervalMs, lastRun: sched.lastRun() };
  }

  setAutoRebalance(enabled: boolean): { enabled: boolean; intervalMs: number; lastRun: ReturnType<RebalanceScheduler['lastRun']> } | { error: string; code: number } {
    const sched = this.deps.rebalanceScheduler;
    if (sched === undefined) return { error: 'auto-rebalance scheduler not wired', code: 503 };
    if (enabled) { sched.start(); } else { sched.stop(); }
    return { enabled: sched.enabled, intervalMs: sched.intervalMs, lastRun: sched.lastRun() };
  }

  performance(strategyId: number, mode: TradingMode): { metrics: PerformanceMetrics; equityCurve: { day: string; nav: number }[] } | { error: string; code: number } {
    const svc = this.deps.performance;
    if (svc === undefined) return { error: 'performance service unavailable', code: 503 };
    return {
      metrics: svc.metrics(strategyId, mode),
      equityCurve: this.deps.repo.getEquitySnapshots(strategyId, mode).map((s) => ({ day: s.day, nav: s.nav })),
    };
  }

  /**
   * Return real brokerage account holdings (read-only).
   * Returns 503 when AccountService is not wired.
   * Returns 502 on upstream Toss API error (logs message only — no secrets).
   */
  async accountHoldings(): Promise<AccountHoldingsView | { error: string; code: number }> {
    const svc = this.deps.account;
    if (svc === undefined) {
      return { error: 'account service not wired', code: 503 };
    }
    try {
      return await svc.holdings();
    } catch (err) {
      console.error('[account] holdings fetch failed:', err instanceof Error ? err.message : String(err));
      return { error: 'account fetch failed', code: 502 };
    }
  }

  /**
   * Run a multi-plan DCA comparison with a lump-sum benchmark.
   * Returns 503 when DcaService is not wired.
   * Returns 400 on missing symbol, empty plans, or invalid plan fields.
   * Returns 502 on upstream candle fetch failure.
   */
  async dcaCompare(input: {
    symbol: unknown;
    plans: unknown;
    historyCount?: unknown;
    from?: unknown;
    to?: unknown;
  }): Promise<DcaCompareResult | { error: string; code: number }> {
    const svc = this.deps.dca;
    if (svc === undefined) {
      return { error: 'DCA service unavailable', code: 503 };
    }

    // Validate symbol
    if (typeof input.symbol !== 'string' || input.symbol.trim() === '') {
      return { error: 'symbol is required', code: 400 };
    }

    // Validate plans array
    if (!Array.isArray(input.plans) || input.plans.length === 0) {
      return { error: 'plans must be a non-empty array', code: 400 };
    }

    for (let i = 0; i < input.plans.length; i++) {
      const v = validatePlan(input.plans[i]);
      if (!v.ok) {
        return { error: `plans[${i}]: ${v.error}`, code: 400 };
      }
    }

    // Validate optional historyCount
    if (input.historyCount !== undefined) {
      const n = Number(input.historyCount);
      if (!Number.isInteger(n) || n <= 0) {
        return { error: 'historyCount must be a positive integer', code: 400 };
      }
    }

    // Build typed compare input — explicit conditional assignment (exactOptionalPropertyTypes)
    const compareInput: DcaCompareInput = {
      symbol: input.symbol.trim(),
      plans:  input.plans as DcaPlan[],
    };
    if (input.historyCount !== undefined) compareInput.historyCount = Number(input.historyCount);
    if (typeof input.from === 'number' && Number.isFinite(input.from)) compareInput.from = input.from;
    if (typeof input.to   === 'number' && Number.isFinite(input.to))   compareInput.to   = input.to;

    try {
      return await svc.compare(compareInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // M3: empty window is a client error (bad from/to range) — return 400 so the
      // caller knows to widen the date range, not retry.
      if (msg.includes('no price data') && msg.includes('in the requested window')) {
        return { error: msg, code: 400 };
      }
      console.error('[dca] compare failed:', msg);
      return { error: 'upstream fetch failed', code: 502 };
    }
  }

  // ── DCA auto-invest plan management ──────────────────────────────────────────

  /** Live-supported plan types. Others are rejected at activation. */
  private static readonly LIVE_SUPPORTED_TYPES = new Set(['vanilla', 'dipBuying']);

  /**
   * Validate and activate a new DCA plan.
   *
   * - Returns 503 when dcaStore not wired.
   * - Returns 400 for missing/invalid fields or unsupported plan types.
   * - Supported types: vanilla, dipBuying.
   * - Rejected: trendFiltered (needs SMA history), valueAveraging (needs
   *   portfolio target), lumpSum (one-shot, not applicable live).
   */
  activateDcaPlan(
    input: { symbol: unknown; plan: unknown },
  ): DcaActivePlan | { error: string; code: number } {
    const store = this.deps.dcaStore;
    if (store === undefined) return { error: 'DCA store not wired', code: 503 };

    if (typeof input.symbol !== 'string' || input.symbol.trim() === '') {
      return { error: 'symbol is required', code: 400 };
    }

    const planRaw = input.plan;
    if (typeof planRaw !== 'object' || planRaw === null) {
      return { error: 'plan is required', code: 400 };
    }
    const p = planRaw as Record<string, unknown>;

    if (typeof p['type'] !== 'string') {
      return { error: 'plan.type is required', code: 400 };
    }
    if (typeof p['cadence'] !== 'string') {
      return { error: 'plan.cadence is required', code: 400 };
    }
    if (typeof p['amount'] !== 'number' || p['amount'] <= 0) {
      return { error: 'plan.amount must be a positive number', code: 400 };
    }

    const planType = p['type'];
    if (!TradingSystem.LIVE_SUPPORTED_TYPES.has(planType)) {
      return {
        error: `plan type '${planType}' is not live-supported; use vanilla or dipBuying`,
        code: 400,
      };
    }

    const cadence = p['cadence'];
    if (cadence !== 'weekly' && cadence !== 'biweekly' && cadence !== 'monthly') {
      return { error: `plan.cadence must be weekly, biweekly, or monthly`, code: 400 };
    }

    // Validate dipBuying-specific fields if present.
    const dipExtra       = p['dipExtra']       !== undefined ? Number(p['dipExtra'])       : undefined;
    const dipDrawdownPct = p['dipDrawdownPct'] !== undefined ? Number(p['dipDrawdownPct']) : undefined;

    if (dipExtra !== undefined && (Number.isNaN(dipExtra) || dipExtra < 0)) {
      return { error: 'plan.dipExtra must be a non-negative number', code: 400 };
    }
    if (dipDrawdownPct !== undefined && (Number.isNaN(dipDrawdownPct) || dipDrawdownPct <= 0 || dipDrawdownPct >= 1)) {
      return { error: 'plan.dipDrawdownPct must be between 0 and 1 exclusive', code: 400 };
    }

    const planObj: DcaPlan = {
      type:    planType as 'vanilla' | 'dipBuying',
      cadence,
      amount:  p['amount'] as number,
    };
    if (dipExtra !== undefined)       planObj.dipExtra       = dipExtra;
    if (dipDrawdownPct !== undefined) planObj.dipDrawdownPct = dipDrawdownPct;

    const symbol = input.symbol.trim();
    const active = store.add({
      symbol,
      plan:          planObj,
      startedAt:     this.now(),
      totalInvested: 0,
      shares:        0,
    });

    // Register symbol in watchList so the market worker starts quoting it for
    // future scheduled contributions (mirrors how factor deploy adds symbols).
    const market = inferCurrency(symbol) === 'KRW' ? 'KR' as const : 'US' as const;
    this.deps.watchList?.add({ symbol, market });

    return active;
  }

  /** List all active DCA plans. Returns 503 when dcaStore not wired. */
  listDcaPlans(): DcaActivePlan[] | { error: string; code: number } {
    const store = this.deps.dcaStore;
    if (store === undefined) return { error: 'DCA store not wired', code: 503 };
    return store.list();
  }

  /**
   * Remove an active DCA plan.
   * Returns 503 when not wired; false when id unknown (caller should 404).
   */
  deactivateDcaPlan(id: number): boolean | { error: string; code: number } {
    const store = this.deps.dcaStore;
    if (store === undefined) return { error: 'DCA store not wired', code: 503 };
    return store.remove(id);
  }

  /**
   * Execute one contribution for plan `id` immediately (on-demand trigger).
   *
   * - 503 when dcaStore/dcaRunner absent.
   * - 404 when plan id unknown.
   * - Forwards contribute() result: { invested, shares, price } or { skipped }.
   * - On success (dipBuying) updates dipPeak in store.
   */
  async runDcaNow(
    id: number,
  ): Promise<{ invested: number; shares: number; price: number } | { skipped: string } | { error: string; code: number }> {
    const store  = this.deps.dcaStore;
    const runner = this.deps.dcaRunner;
    if (store === undefined || runner === undefined) {
      return { error: 'DCA store/runner not wired', code: 503 };
    }

    const plan = store.list().find((p) => p.id === id);
    if (plan === undefined) return { error: `DCA plan ${id} not found`, code: 404 };

    const result = await this.dcaContribute(runner, plan);

    if ('invested' in result) {
      const now = this.now();
      const newPeak =
        plan.plan.type === 'dipBuying'
          ? Math.max(plan.dipPeak ?? 0, result.price)
          : undefined;

      const patch = {
        lastContributionAt: now,
        totalInvested: plan.totalInvested + result.invested,
        shares: plan.shares + result.shares,
        ...(newPeak !== undefined ? { dipPeak: newPeak } : {}),
      };
      store.update(id, patch);
    }

    return result;
  }

  /**
   * Prefetch price for `plan.symbol` via `getPrices` (if wired), populate the QuoteBook
   * with the correct currency (USD for tickers, KRW for 6-digit codes), then delegate
   * to `runner.contribute`.
   *
   * Mirrors the fresh-quote-preserving pattern from `rebalanceFactorPortfolio` (review M7):
   * if a quote younger than FRESH_MS already exists, skip the fetch so the synthetic quote
   * does not overwrite a real bid/ask from the market worker.
   */
  private async dcaContribute(
    runner: DcaPlanRunner,
    plan: DcaActivePlan,
  ): Promise<{ invested: number; shares: number; price: number } | { skipped: string }> {
    const getPrices = this.deps.getPrices;
    if (getPrices !== undefined) {
      const FRESH_MS = 10_000;
      const existing = this.deps.book.getQuote(plan.symbol);
      if (!existing || this.now() - existing.ts >= FRESH_MS) {
        try {
          const items = await getPrices([plan.symbol]);
          for (const item of items) {
            if (item.symbol !== plan.symbol) continue;
            const last = Number(item.lastPrice);
            if (!Number.isFinite(last) || last <= 0) continue;
            const currency = inferCurrency(plan.symbol);
            this.deps.book.set({ symbol: plan.symbol, currency, bid: last, ask: last, last, ts: this.now() });
          }
        } catch {
          // Swallow — if a stale quote is in the book, runner uses it;
          // if the book has no quote at all, runner returns { skipped: 'no price' }.
        }
      }
    }

    return runner.contribute(plan);
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
    const { symbol, spec, capital = 10_000_000 } = input;
    const interval: '1m' | '1d' = (input.interval === '1m' || input.interval === '1d') ? input.interval : '1d';
    const chartCandles = await this.candles(symbol, interval);
    // Sort ascending by time (Toss may return newest-first); dedup to satisfy strict-increasing check.
    const seen = new Set<number>();
    const bars = [...chartCandles]
      .sort((a, b) => a.time - b.time)
      .filter((c) => {
        if (seen.has(c.time) || !Number.isFinite(c.close) || c.close <= 0) return false;
        seen.add(c.time);
        return true;
      })
      .map((c) => ({ ts: c.time, price: c.close }));
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
