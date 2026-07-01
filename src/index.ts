// Composition root: wires the paper-trading pipeline end to end.
// LIVE is intentionally NOT wired here — promotion is a deliberate, separate step.

import { resolve } from 'node:path';
import { config } from './config/env.js';
import { TossApiClient } from './toss/TossApiClient.js';
import { MarketDataWorker, type WatchedSymbol, type Market } from './market/MarketDataWorker.js';
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
import { ThresholdStrategy } from './strategy/ThresholdStrategy.js';
import { MovingAverageCrossStrategy } from './strategy/MovingAverageCrossStrategy.js';
import { StrategyRegistry } from './strategy/StrategyRegistry.js';
import type { Strategy } from './strategy/Strategy.js';
import { InMemoryEventLogger } from './observability/EventLogger.js';
import { HaltSwitch } from './app/HaltSwitch.js';
import { FileHaltStore } from './app/HaltStore.js';
import { TradingSystem } from './app/TradingSystem.js';
import { buildServer } from './api/server.js';
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

  // Sample strategy — replace with DB-loaded strategies.
  const strategies: Strategy[] = [
    new ThresholdStrategy({
      id: 1, symbol: '005930', currency: 'KRW', mode: 'PAPER',
      buyBelow: 70_000, sellAbove: 80_000, orderNotional: 1_000_000,
    }),
    new MovingAverageCrossStrategy({
      id: 2, symbol: '000660', currency: 'KRW', mode: 'PAPER',
      fastPeriod: 5, slowPeriod: 20, orderNotional: 1_000_000,
    }),
  ];
  for (const s of strategies) {
    engine.register(s);
    registry.register(s, `strategy-${s.id}`, 'PAPER_TESTING');
  }

  // Restore prior run's orders/positions/equity/streaks + registry statuses + strategy
  // indicator windows, now that strategies are registered. Throws on a version mismatch.
  if (statePersistence.load(repo, tracker, { registry, strategies })) {
    console.log('restored trading state from disk');
  }

  // Dedupe so two strategies sharing a symbol don't produce a duplicate batch-fetch entry.
  const seenSymbols = new Set<string>();
  const watched: WatchedSymbol[] = [];
  for (const s of strategies) {
    for (const symbol of s.symbols) {
      if (seenSymbols.has(symbol)) continue;
      seenSymbols.add(symbol);
      watched.push({ symbol, market: marketOf(s.currency) });
    }
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
    getWatched: () => watched,
    book,
    // Sample each strategy off its OWN market's tick (q.currency) at the tick's time (q.ts).
    onTick: async (q) => { await engine.onTick(q); snapshotScheduler.maybeSnapshot(q.ts, q.currency); },
    isMarketOpen: (m) => calendar.isMarketOpen(m),
    intervalMs: 2000,
    onError: (err) => logger.log({ type: 'MARKETDATA_ERROR', message: String(err), at: Date.now() }),
  });

  const reconciliation = new ReconciliationService(paperBroker, repo, logger, { mode: 'PAPER', tracker });
  const perf = new PerformanceService(repo, tracker, () => STRATEGY_CAPITAL);
  const system = new TradingSystem({
    repo, book, registry, logger, haltSwitch,
    // Real §7 metrics: APPROVED/LIVE now unlock once 30+ days / 50+ trades / criteria are met.
    promotionInputFor: (id) => perf.promotionInput(id, 'PAPER'),
  });
  const server = buildServer(system, { ...(process.env.API_TOKEN ? { authToken: process.env.API_TOKEN } : {}) });

  return {
    client, repo, book, logger, tracker, haltSwitch, registry, system, server, statePersistence,
    paperBroker, engine, worker, reconciliation, equityRecorder, snapshotScheduler, perf, strategies,
  };
}

export async function main(): Promise<void> {
  const { worker, reconciliation, server, system, repo, tracker, statePersistence, registry, strategies } = bootstrap();
  console.log('auto-trading paper pipeline starting…');
  if (system.haltStatus().halted) {
    console.warn(`⚠️ kill switch is SET (${system.haltStatus().reason}); brokers will refuse orders until /api/resume`);
  }
  await reconciliation.reconcile().catch((err) => console.error('reconcile failed:', err));
  await server.listen({ port: HTTP_PORT, host: '127.0.0.1' });   // localhost only; front with an authed proxy
  console.log(`API listening on 127.0.0.1:${HTTP_PORT}`);

  // Persist state periodically + on shutdown so a restart resumes from disk.
  const saveState = () => {
    try { statePersistence.save(repo, tracker, { registry, strategies }); }
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
