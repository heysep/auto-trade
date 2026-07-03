// Composition root: wires the trading pipeline end to end.
// LIVE path is env-gated: LIVE_ENABLED=1 AND DAYTRADE_MODE=LIVE both required (default: PAPER).

import { resolve } from 'node:path';
import { config } from './config/env.js';
import { TossApiClient } from './toss/TossApiClient.js';
import { MarketDataWorker, type Market } from './market/MarketDataWorker.js';
import { MarketCalendarService } from './market/MarketCalendar.js';
import { QuoteBook } from './market/PriceSource.js';
import { InMemoryRepository } from './persistence/repository.js';
import { FileStatePersistence } from './persistence/StatePersistence.js';
import { PaperBroker } from './broker/PaperBroker.js';
import { RiskManager, type RiskContext } from './risk/RiskManager.js';
import { InMemoryTradeTracker } from './risk/TradeTracker.js';
import { OrderManager } from './order/OrderManager.js';
import { ReconciliationService } from './order/ReconciliationService.js';
import { StrategyEngine } from './strategy/StrategyEngine.js';
import { TimeSeriesMomentumStrategy } from './strategy/TimeSeriesMomentumStrategy.js';
import { VolatilityBreakoutStrategy } from './strategy/VolatilityBreakoutStrategy.js';
import { StrategyRegistry } from './strategy/StrategyRegistry.js';
import type { Strategy } from './strategy/Strategy.js';
import { InMemoryEventLogger } from './observability/EventLogger.js';
import { LiveBroker } from './broker/LiveBroker.js';
import { makeDailyRangeProvider } from './market/dailyRange.js';
import type { Broker } from './broker/Broker.js';
import { HaltSwitch } from './app/HaltSwitch.js';
import { FileHaltStore } from './app/HaltStore.js';
import { TradingSystem, FACTOR_PORTFOLIO_STRATEGY_ID } from './app/TradingSystem.js';
import { StrategyDeployer } from './app/StrategyDeployer.js';
import { WatchList } from './market/WatchList.js';
import { SymbolCatalog } from './market/SymbolCatalog.js';
import { KRX_SYMBOLS } from './market/krxSymbols.js';
import { buildServer } from './api/server.js';
import { FactorRankingService } from './factor/FactorRankingService.js';
import { FactorBacktestService } from './factor/FactorBacktestService.js';
import { FactorModel } from './factor/FactorModel.js';
import { DartApiClient } from './dart/DartApiClient.js';
import { FundamentalsService } from './factor/FundamentalsService.js';
import { FactorPortfolioManager } from './factor/FactorPortfolioManager.js';
import { EquityRecorder } from './performance/EquityRecorder.js';
import { SnapshotScheduler } from './performance/SnapshotScheduler.js';
import { RebalanceScheduler } from './factor/RebalanceScheduler.js';
import { PerformanceService } from './performance/PerformanceService.js';
import { AccountService } from './app/AccountService.js';
import type { Currency, TradingMode } from './domain/types.js';

const HTTP_PORT = Number(process.env.PORT ?? 3000);
// Absolute so a launch from a different cwd can't read/write a different kill-switch file.
const HALT_FILE = resolve(process.env.HALT_FILE ?? './halt-state.json');
const STATE_FILE = resolve(process.env.STATE_FILE ?? './trading-state.json');
const STATE_SAVE_MS = 60_000;

const STRATEGY_CAPITAL = 10_000_000;
const RISK_LIMITS = { maxPositionPct: 30, dailyMaxLoss: 500_000, maxConsecutiveLosses: 5 };

// C1: Factor portfolio uses a much larger capital base and looser concentration limits.
// TSMOM strategies remain on the 10M/30% config above.
const FACTOR_PORTFOLIO_CAPITAL = 100_000_000;
const FACTOR_PORTFOLIO_LIMITS = { maxPositionPct: 15, dailyMaxLoss: 10_000_000, maxConsecutiveLosses: 10 };

// id=3: Volatility-breakout day-trade. Budget is the per-day capital ceiling;
// 10% daily-loss cap (realized+unrealized) → halt; 3 losing round-trips → halt.
const DAYTRADE_STRATEGY_ID = 3;
const DAYTRADE_RISK_LIMITS = {
  maxPositionPct: 100,
  dailyMaxLoss: Math.round(config.daytrade.budget * 0.1),
  maxConsecutiveLosses: 3,
};

const marketOf = (c: Currency): Market => (c === 'KRW' ? 'KR' : 'US');

export function bootstrap() {
  const client = new TossApiClient();
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  const logger = new InMemoryEventLogger();

  const tracker = new InMemoryTradeTracker();
  const statePersistence = new FileStatePersistence(STATE_FILE);
  const haltSwitch = new HaltSwitch({ store: new FileHaltStore(HALT_FILE) });   // durable kill switch
  const registry = new StrategyRegistry();
  const paperBroker = new PaperBroker(repo, book, { tracker, isHalted: () => haltSwitch.halted });

  // Live broker holder: armed in main() when LIVE_ENABLED=1.
  // Kept undefined until explicitly set so any order that somehow arrives before
  // arming falls back to paperBroker (double safety net).
  let activeLiveBroker: Broker | undefined;

  const risk = new RiskManager();

  // DailyRange provider for the volatility-breakout strategy.
  // Caches per (symbol, KST-date); in-flight deduplication built in.
  const dailyRange = makeDailyRangeProvider((s, i, n) => client.getCandles(s, i, n));

  const riskContext = (strategy: Strategy, symbol: string): RiskContext => {
    // C1: factor portfolio (id=1000) runs on ₩100M with 15% max-position and lenient
    // loss limits. TSMOM strategies stay on the 10M/30% config.
    // C3: daytrade (id=3) runs on DAYTRADE_BUDGET with its own tighter loss limits.
    const isFactorPortfolio = strategy.id === FACTOR_PORTFOLIO_STRATEGY_ID;
    const isDaytrade = strategy.id === DAYTRADE_STRATEGY_ID;
    const capital = isFactorPortfolio ? FACTOR_PORTFOLIO_CAPITAL
                  : isDaytrade ? config.daytrade.budget
                  : STRATEGY_CAPITAL;
    const limits  = isFactorPortfolio ? FACTOR_PORTFOLIO_LIMITS
                  : isDaytrade ? DAYTRADE_RISK_LIMITS
                  : RISK_LIMITS;

    const positions = repo.getPositions(strategy.id, strategy.mode);
    // Open mark-to-market loss so the daily-loss halt isn't blind to unrealized drawdown.
    const unrealizedPnl = positions.reduce((s, pos) => {
      const q = book.getQuote(pos.symbol);
      return q ? s + pos.quantity * (q.last - pos.avgPrice) : s;
    }, 0);
    const dailyRealizedPnl = tracker.dailyRealizedPnl(strategy.id, strategy.mode, strategy.currency, Date.now());
    // Record a daily-max-loss breach (realized + open) so it counts against §7 promotion.
    if (dailyRealizedPnl + unrealizedPnl <= -limits.dailyMaxLoss) {
      tracker.markDailyLoss(strategy.id, strategy.mode, strategy.currency, Date.now());
    }
    return {
      mode: strategy.mode,
      // Single source of truth: the API-mutable registry status feeds the live-enable gate.
      status: registry.get(strategy.id)?.status ?? 'PAPER_TESTING',
      capital,
      limits,
      positions,
      openOrdersForSymbol: repo.getOpenOrdersBySymbol(symbol, strategy.mode).length,
      // Live, round-trip + market-tz derived halts (no longer hardcoded 0).
      // ⚠️ In-memory: resets on restart — rederive from persisted fills when DB lands.
      dailyRealizedPnl,
      unrealizedPnl,
      consecutiveLosses: tracker.consecutiveLosses(strategy.id, strategy.mode),
    };
  };

  const orderManager = new OrderManager({
    // When LIVE_ENABLED=1, LIVE-mode orders route to activeLiveBroker (set in main()).
    // When LIVE_ENABLED is absent, keep the simpler () => paperBroker lambda unchanged.
    brokerFor: config.daytrade.liveEnabled
      ? (mode: TradingMode) => (mode === 'LIVE' && activeLiveBroker !== undefined)
          ? activeLiveBroker
          : paperBroker
      : () => paperBroker,
    risk, riskContext, logger, haltSwitch,
  });

  const engine = new StrategyEngine({
    orderManager,
    getPosition: (id, sym, mode) => repo.getPosition(id, sym, mode),
    onQuote: (q) => paperBroker.onQuote(q),   // fill resting limits before strategies run
    onError: (err) => logger.log({ type: 'ENGINE_ERROR', message: String(err), at: Date.now() }),
  });

  // Seeded AQR TSMOM strategies — replace with DB-loaded strategies.
  const strategies: Strategy[] = [
    new TimeSeriesMomentumStrategy({
      id: 1, symbol: '005930', currency: 'KRW', mode: 'PAPER',
      lookback: 20, orderNotional: 1_000_000,
    }),
    new TimeSeriesMomentumStrategy({
      id: 2, symbol: '000660', currency: 'KRW', mode: 'PAPER',
      lookback: 20, orderNotional: 1_000_000,
    }),
    // id=3: Volatility-breakout day-trade. Mode is env-gated (PAPER by default; LIVE
    // requires LIVE_ENABLED=1 AND DAYTRADE_MODE=LIVE). Symbol list/K/budget/minRangePct configurable.
    // The affordability filter (floor(budget/todayOpen) >= 1) auto-drops any symbol the budget can't buy.
    new VolatilityBreakoutStrategy({
      id: DAYTRADE_STRATEGY_ID,
      symbols: config.daytrade.symbols,
      currency: 'KRW',
      mode: config.daytrade.mode,
      k: config.daytrade.k,
      budget: config.daytrade.budget,
      minRangePct: config.daytrade.minRangePct,
      getDailyRange: dailyRange,
    }),
  ];
  for (const s of strategies) {
    engine.register(s);
    // Volbreakout (id=3): human-readable Korean name; status tracks the resolved mode.
    // Registering as LIVE at boot is the owner's explicit env-flag approval; the HTTP
    // promotion gate remains the guard for all other strategies (unchanged).
    const name = s.id === DAYTRADE_STRATEGY_ID
      ? '변동성돌파 단타'
      : `strategy-${s.id}`;
    const status = (s.id === DAYTRADE_STRATEGY_ID && config.daytrade.mode === 'LIVE')
      ? 'LIVE' as const
      : 'PAPER_TESTING' as const;
    registry.register(s, name, status);
  }

  // Reserved stub for the AQR 4-Factor Portfolio (id=1000). Registered in registry only —
  // NOT in StrategyEngine tick loop. Lifecycle managed by rebalanceFactorPortfolio() HTTP trigger.
  const factorStrategy: Strategy = {
    id: FACTOR_PORTFOLIO_STRATEGY_ID,
    symbols: new Set<string>(),
    currency: 'KRW',
    mode: 'PAPER',
    evaluate: () => null,
  };
  registry.register(factorStrategy, 'AQR 4-Factor Portfolio', 'PAPER_TESTING');

  // Build the watchList seeded from static strategies' symbols (deduped — WatchList.add is idempotent).
  const watchList = new WatchList(
    strategies.flatMap((s) => [...s.symbols].map((symbol) => ({ symbol, market: marketOf(s.currency) }))),
  );

  // Create deployer; self-referential onChange persists state immediately after each deploy/undeploy.
  let deployer!: StrategyDeployer;
  deployer = new StrategyDeployer(
    {
      engine, registry, watchList, currency: 'KRW', mode: 'PAPER',
      onChange: () => {
        try { statePersistence.save(repo, tracker, { registry, strategies, deployer }); } catch { /* best-effort */ }
      },
    },
    strategies.length + 1,
  );

  // Restore prior run's orders/positions/equity/streaks + registry statuses + strategy
  // indicator windows, now that strategies are registered. Throws on a version mismatch.
  if (statePersistence.load(repo, tracker, { registry, strategies, deployer })) {
    console.log('restored trading state from disk');
  }

  const calendar = new MarketCalendarService({ fetchCalendar: (m) => client.getMarketCalendar(m) });

  const equityRecorder = new EquityRecorder({
    repo,
    book,
    capitalFor: (id: number) =>
      id === FACTOR_PORTFOLIO_STRATEGY_ID ? FACTOR_PORTFOLIO_CAPITAL
      : id === DAYTRADE_STRATEGY_ID ? config.daytrade.budget
      : STRATEGY_CAPITAL,
  });
  const snapshotScheduler = new SnapshotScheduler({
    recorder: equityRecorder,
    targets: () => strategies.map((s) => ({ id: s.id, mode: s.mode, currency: s.currency })),
    onSkip: (t) => logger.log({ type: 'SNAPSHOT_SKIPPED', strategyId: t.id, message: 'open position lacks a quote', at: Date.now() }),
  });

  const worker = new MarketDataWorker({
    // /prices unwraps to a bare array — re-wrap into the { result } shape the worker reads.
    fetchPrices: async (symbols) => ({ result: await client.getPrices(symbols) }),
    getWatched: () => watchList.list(),
    book,
    // Sample each strategy off its OWN market's tick (q.currency) at the tick's time (q.ts).
    onTick: async (q) => { await engine.onTick(q); snapshotScheduler.maybeSnapshot(q.ts, q.currency); },
    isMarketOpen: (m) => calendar.isMarketOpen(m),
    intervalMs: 2000,
    onError: (err) => logger.log({ type: 'MARKETDATA_ERROR', message: String(err), at: Date.now() }),
  });

  const reconciliation = new ReconciliationService(paperBroker, repo, logger, { mode: 'PAPER', tracker });
  const perf = new PerformanceService(repo, tracker, () => STRATEGY_CAPITAL);
  // Symbol search uses a static KRX list — Toss /stocks needs explicit symbols (no list-all endpoint).
  const symbolCatalog = new SymbolCatalog(async () => KRX_SYMBOLS);

  // OpenDART fundamentals: enabled when DART_API_KEY is non-empty.
  // Provides Value (earnings yield, book-to-market) + Quality (ROE, GP/Assets, D/E) factors.
  // Never log the API key.
  let dartFundamentals: FundamentalsService | undefined;
  let dartGetStocks: ((s: string[]) => Promise<import('./toss/types.js').TossStock[]>) | undefined;
  if (config.dart.apiKey !== '') {
    const dartClient = new DartApiClient({ apiKey: config.dart.apiKey });
    const fundamentalsYear = new Date().getFullYear() - 1;
    dartFundamentals = new FundamentalsService({ dart: dartClient, year: fundamentalsYear });
    dartGetStocks = (s) => client.getStocks(s);
  }

  // Factor ranking: assembles full KRX universe, fetches 280 daily candles per symbol
  // sequentially (respects rate limits), runs AQR FactorModel. 280 bars > 252 needed
  // for 12-month momentum + 252-bar vol/MDD, with margin for non-trading days.
  // With DART key: full 4-factor model (Value + Momentum + Quality + Defensive).
  // Without DART key: price-only 2-factor model (Momentum + Defensive).
  const factorRanking = new FactorRankingService({
    universe: () => KRX_SYMBOLS,
    getCandles: (s, i, n) => client.getCandles(s, i, n),
    model: new FactorModel(),
    ...(dartGetStocks !== undefined ? { getStocks: dartGetStocks } : {}),
    ...(dartFundamentals !== undefined ? { fundamentals: dartFundamentals } : {}),
  });

  // Factor backtest: same KRX universe + 500 daily bars → BacktestSymbol[] matrix (cached 1h).
  // FactorBacktest engine runs per-request (cheap) against the cached matrix.
  const factorBacktest = new FactorBacktestService({
    universe: () => KRX_SYMBOLS,
    getCandles: (s, i, n) => client.getCandles(s, i, n),
    model: new FactorModel(),
  });

  // FactorPortfolioManager: rebalance-driven (HTTP trigger), PAPER only.
  // submitIntent bridges PortfolioOrderIntent → OrderManager.handleIntent.
  const factorPortfolio = new FactorPortfolioManager(
    {
      ranking: factorRanking,
      priceOf: (sym) => book.getQuote(sym)?.last,
      currentQty: (sym) => {
        const pos = repo.getPosition(FACTOR_PORTFOLIO_STRATEGY_ID, sym, 'PAPER');
        return pos?.quantity ?? 0;
      },
      heldSymbols: () =>
        repo.getPositions(FACTOR_PORTFOLIO_STRATEGY_ID, 'PAPER')
          .filter((p) => p.quantity !== 0)
          .map((p) => p.symbol),
      submitIntent: async (pIntent) => {
        const quote = book.getQuote(pIntent.symbol);
        if (quote === undefined) throw new Error(`no quote for ${pIntent.symbol}`);
        // C2: inspect the structured outcome — treat 'blocked' and 'error' as
        // thrown errors so FactorPortfolioManager routes them to `skipped`
        // instead of silently counting them as `ordersSubmitted`.
        const outcome = await orderManager.handleIntent(
          factorStrategy,
          { side: pIntent.side, quantity: pIntent.quantity, orderType: 'MARKET', reason: pIntent.reason },
          quote,
        );
        if (outcome.status !== 'placed') {
          const msg = outcome.status === 'blocked'
            ? (outcome.reason ?? 'risk blocked')
            : String((outcome as { error?: unknown }).error ?? outcome.status);
          throw new Error(msg);
        }
      },
      isHalted: () => haltSwitch.halted,
    },
    {
      strategyId: FACTOR_PORTFOLIO_STRATEGY_ID,
      topN: 10,
      totalNotional: 100_000_000,   // ₩100M so each of 10 large-caps gets a fillable ~₩10M slice
      currency: 'KRW',
      mode: 'PAPER',
    },
  );

  const AUTO_REBALANCE = process.env.AUTO_REBALANCE === '1';
  const REBALANCE_INTERVAL_MS = Number(process.env.REBALANCE_INTERVAL_MS ?? '') || 86_400_000;

  // Construct scheduler before system (rebalance closure captures systemRef lazily to avoid circular dep).
  let systemRef!: TradingSystem;
  const rebalanceScheduler = new RebalanceScheduler({
    rebalance: () => systemRef.rebalanceFactorPortfolio(),
    isHalted: () => haltSwitch.halted,
    isTradingDay: () => calendar.isTradingDaySync('KR'),
    intervalMs: REBALANCE_INTERVAL_MS,
    logger: { log: (e) => logger.log({ type: 'REBALANCE_ERROR', message: String(e), at: Date.now() }) },
  });

  // Real Toss account holdings (read-only). Cached: accountSeq forever, holdings 30 s.
  const accountService = new AccountService({ client });

  const system = new TradingSystem({
    repo, book, registry, logger, haltSwitch,
    // Real §7 metrics: APPROVED/LIVE now unlock once 30+ days / 50+ trades / criteria are met.
    promotionInputFor: (id) => perf.promotionInput(id, 'PAPER'),
    symbolCatalog,
    getCandles: (s, i) => client.getCandles(s, i),
    deployer,
    factorRanking,
    factorBacktest,
    factorPortfolio,
    getPrices: (s) => client.getPrices(s),
    factorPortfolioTopN: 10,
    rebalanceScheduler,
    performance: perf,
    account: accountService,
  });
  systemRef = system;

  if (AUTO_REBALANCE) {
    rebalanceScheduler.start();
    logger.log({ type: 'REBALANCE_SCHEDULER_ARMED', message: `[rebalance] auto-scheduler armed, interval=${REBALANCE_INTERVAL_MS}ms`, at: Date.now() });
    console.log(`[rebalance] auto-scheduler armed, interval=${REBALANCE_INTERVAL_MS}ms`);
  }

  const server = buildServer(system, { ...(process.env.API_TOKEN ? { authToken: process.env.API_TOKEN } : {}) });

  return {
    client, repo, book, logger, tracker, haltSwitch, registry, system, server, statePersistence,
    paperBroker, engine, worker, reconciliation, equityRecorder, snapshotScheduler, perf, strategies,
    deployer, watchList, rebalanceScheduler, accountService,
    setActiveLiveBroker: (b: Broker) => { activeLiveBroker = b; },
  };
}

export async function main(): Promise<void> {
  const {
    worker, reconciliation, server, system, repo, tracker, statePersistence,
    registry, strategies, deployer, rebalanceScheduler,
    client, haltSwitch, setActiveLiveBroker,
  } = bootstrap();
  console.log('auto-trading paper pipeline starting…');
  console.log(
    `[daytrade] strategy id=${DAYTRADE_STRATEGY_ID}` +
    ` candidates=[${config.daytrade.symbols.join(',')}]` +
    ` K=${config.daytrade.k} budget=${config.daytrade.budget}` +
    ` minRangePct=${config.daytrade.minRangePct} mode=${config.daytrade.mode}` +
    ` liveBrokerArmed=${config.daytrade.liveEnabled}`,
  );

  // Live broker: resolve Toss account and arm LiveBroker when LIVE_ENABLED=1.
  // Must happen before worker.start() so the first quote tick finds the broker ready.
  if (config.daytrade.liveEnabled) {
    try {
      const accounts = await client.getAccounts();
      const first = accounts[0];
      if (first === undefined || typeof first.accountSeq !== 'number') {
        throw new Error('[live] no usable Toss account returned from getAccounts()');
      }
      const accountSeq = String(first.accountSeq);
      const liveBroker = new LiveBroker(
        client,
        accountSeq,
        repo,
        { enabled: true, isHalted: () => haltSwitch.halted },
      );
      setActiveLiveBroker(liveBroker);
      console.log('[live] LiveBroker armed (LIVE_ENABLED=1)');
    } catch (err) {
      // Fail loud — if LIVE_ENABLED=1 and broker cannot be armed, operator must know
      console.error('[live] FAILED to arm LiveBroker:', err);
      throw err;
    }
  }

  if (system.haltStatus().halted) {
    console.warn(`⚠️ kill switch is SET (${system.haltStatus().reason}); brokers will refuse orders until /api/resume`);
  }
  await reconciliation.reconcile().catch((err) => console.error('reconcile failed:', err));
  await server.listen({ port: HTTP_PORT, host: '127.0.0.1' });   // localhost only; front with an authed proxy
  console.log(`API listening on 127.0.0.1:${HTTP_PORT}`);

  // Persist state periodically + on shutdown so a restart resumes from disk.
  const saveState = () => {
    try { statePersistence.save(repo, tracker, { registry, strategies, deployer }); }
    catch (e) { console.error('state save failed:', e); }
  };
  const saveTimer = setInterval(saveState, STATE_SAVE_MS);
  saveTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(saveTimer);
    rebalanceScheduler.stop();
    saveState();
    worker.stop();
    await server.close().catch(() => { /* already closing */ });
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    await worker.start();          // blocks until stop()
  } finally {
    await server.close().catch(() => { /* */ });   // tie server lifetime to the worker loop
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('index.ts') || entry.endsWith('index.js')) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
