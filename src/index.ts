// Composition root: wires the paper-trading pipeline end to end.
// LIVE is intentionally NOT wired here — promotion is a deliberate, separate step.

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
import { StrategyRegistry } from './strategy/StrategyRegistry.js';
import type { Strategy } from './strategy/Strategy.js';
import { InMemoryEventLogger } from './observability/EventLogger.js';
import { HaltSwitch } from './app/HaltSwitch.js';
import { FileHaltStore } from './app/HaltStore.js';
import { TradingSystem } from './app/TradingSystem.js';
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
import { FACTOR_PORTFOLIO_STRATEGY_ID } from './app/TradingSystem.js';
import { EquityRecorder } from './performance/EquityRecorder.js';
import { SnapshotScheduler } from './performance/SnapshotScheduler.js';
import { PerformanceService } from './performance/PerformanceService.js';
import type { Currency } from './domain/types.js';

const HTTP_PORT = Number(process.env.PORT ?? 3000);
// Absolute so a launch from a different cwd can't read/write a different kill-switch file.
const HALT_FILE = resolve(process.env.HALT_FILE ?? './halt-state.json');
const STATE_FILE = resolve(process.env.STATE_FILE ?? './trading-state.json');
const STATE_SAVE_MS = 60_000;

const STRATEGY_CAPITAL = 10_000_000;
const RISK_LIMITS = { maxPositionPct: 30, dailyMaxLoss: 500_000, maxConsecutiveLosses: 5 };

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
  const risk = new RiskManager();

  const riskContext = (strategy: Strategy, symbol: string): RiskContext => {
    const positions = repo.getPositions(strategy.id, strategy.mode);
    // Open mark-to-market loss so the daily-loss halt isn't blind to unrealized drawdown.
    const unrealizedPnl = positions.reduce((s, pos) => {
      const q = book.getQuote(pos.symbol);
      return q ? s + pos.quantity * (q.last - pos.avgPrice) : s;
    }, 0);
    const dailyRealizedPnl = tracker.dailyRealizedPnl(strategy.id, strategy.mode, strategy.currency, Date.now());
    // Record a daily-max-loss breach (realized + open) so it counts against §7 promotion.
    if (dailyRealizedPnl + unrealizedPnl <= -RISK_LIMITS.dailyMaxLoss) {
      tracker.markDailyLoss(strategy.id, strategy.mode, strategy.currency, Date.now());
    }
    return {
      mode: strategy.mode,
      // Single source of truth: the API-mutable registry status feeds the live-enable gate.
      status: registry.get(strategy.id)?.status ?? 'PAPER_TESTING',
      capital: STRATEGY_CAPITAL,
      limits: RISK_LIMITS,
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
    brokerFor: () => paperBroker,     // paper only here
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
  ];
  for (const s of strategies) {
    engine.register(s);
    registry.register(s, `strategy-${s.id}`, 'PAPER_TESTING');
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

  const equityRecorder = new EquityRecorder({ repo, book, capitalFor: () => STRATEGY_CAPITAL });
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
    dartFundamentals = new FundamentalsService({ dart: dartClient, year: 2024 });
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
        await orderManager.handleIntent(
          factorStrategy,
          { side: pIntent.side, quantity: pIntent.quantity, orderType: 'MARKET', reason: pIntent.reason },
          quote,
        );
      },
      isHalted: () => haltSwitch.halted,
    },
    {
      strategyId: FACTOR_PORTFOLIO_STRATEGY_ID,
      topN: 10,
      totalNotional: 10_000_000,
      currency: 'KRW',
      mode: 'PAPER',
    },
  );

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
  });
  const server = buildServer(system, { ...(process.env.API_TOKEN ? { authToken: process.env.API_TOKEN } : {}) });

  return {
    client, repo, book, logger, tracker, haltSwitch, registry, system, server, statePersistence,
    paperBroker, engine, worker, reconciliation, equityRecorder, snapshotScheduler, perf, strategies,
    deployer, watchList,
  };
}

export async function main(): Promise<void> {
  const { worker, reconciliation, server, system, repo, tracker, statePersistence, registry, strategies, deployer } = bootstrap();
  console.log('auto-trading paper pipeline starting…');
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
