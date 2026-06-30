// Composition root: wires the paper-trading pipeline end to end.
// LIVE is intentionally NOT wired here — promotion is a deliberate, separate step.

import { config } from './config/env.js';
import { TossApiClient } from './toss/TossApiClient.js';
import { MarketDataWorker, type WatchedSymbol, type Market } from './market/MarketDataWorker.js';
import { MarketCalendarService } from './market/MarketCalendar.js';
import { QuoteBook } from './market/PriceSource.js';
import { InMemoryRepository } from './persistence/repository.js';
import { PaperBroker } from './broker/PaperBroker.js';
import { RiskManager, type RiskContext } from './risk/RiskManager.js';
import { InMemoryTradeTracker } from './risk/TradeTracker.js';
import { OrderManager } from './order/OrderManager.js';
import { ReconciliationService } from './order/ReconciliationService.js';
import { StrategyEngine } from './strategy/StrategyEngine.js';
import { ThresholdStrategy } from './strategy/ThresholdStrategy.js';
import type { Strategy } from './strategy/Strategy.js';
import { InMemoryEventLogger } from './observability/EventLogger.js';
import type { Currency } from './domain/types.js';

const STRATEGY_CAPITAL = 10_000_000;
const RISK_LIMITS = { maxPositionPct: 30, dailyMaxLoss: 500_000, maxConsecutiveLosses: 5 };

const marketOf = (c: Currency): Market => (c === 'KRW' ? 'KR' : 'US');

export function bootstrap() {
  const client = new TossApiClient();
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  const logger = new InMemoryEventLogger();

  const tracker = new InMemoryTradeTracker();
  const paperBroker = new PaperBroker(repo, book, { tracker });
  const risk = new RiskManager();

  const riskContext = (strategy: Strategy, symbol: string): RiskContext => {
    const positions = repo.getPositions(strategy.id, strategy.mode);
    // Open mark-to-market loss so the daily-loss halt isn't blind to unrealized drawdown.
    const unrealizedPnl = positions.reduce((s, pos) => {
      const q = book.getQuote(pos.symbol);
      return q ? s + pos.quantity * (q.last - pos.avgPrice) : s;
    }, 0);
    return {
      mode: strategy.mode,
      status: 'PAPER_TESTING',
      capital: STRATEGY_CAPITAL,
      limits: RISK_LIMITS,
      positions,
      openOrdersForSymbol: repo.getOpenOrdersBySymbol(symbol, strategy.mode).length,
      // Live, round-trip + market-tz derived halts (no longer hardcoded 0).
      // ⚠️ In-memory: resets on restart — rederive from persisted fills when DB lands.
      dailyRealizedPnl: tracker.dailyRealizedPnl(strategy.id, strategy.mode, strategy.currency, Date.now()),
      unrealizedPnl,
      consecutiveLosses: tracker.consecutiveLosses(strategy.id, strategy.mode),
    };
  };

  const orderManager = new OrderManager({
    brokerFor: () => paperBroker,     // paper only here
    risk, riskContext, logger,
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
  ];
  for (const s of strategies) engine.register(s);

  const watched: WatchedSymbol[] = strategies.flatMap((s) =>
    [...s.symbols].map((symbol) => ({ symbol, market: marketOf(s.currency) })),
  );

  const calendar = new MarketCalendarService({ fetchCalendar: (m) => client.getMarketCalendar(m) });

  const worker = new MarketDataWorker({
    // /prices unwraps to a bare array — re-wrap into the { result } shape the worker reads.
    fetchPrices: async (symbols) => ({ result: await client.getPrices(symbols) }),
    getWatched: () => watched,
    book,
    onTick: (q) => engine.onTick(q),
    isMarketOpen: (m) => calendar.isMarketOpen(m),
    intervalMs: 2000,
    onError: (err) => logger.log({ type: 'MARKETDATA_ERROR', message: String(err), at: Date.now() }),
  });

  const reconciliation = new ReconciliationService(paperBroker, repo, logger, { mode: 'PAPER', tracker });

  return { client, repo, book, logger, tracker, paperBroker, engine, worker, reconciliation };
}

export async function main(): Promise<void> {
  const { worker, reconciliation } = bootstrap();
  console.log('auto-trading paper pipeline starting…');
  await reconciliation.reconcile().catch((err) => console.error('reconcile failed:', err));
  process.on('SIGINT', () => worker.stop());
  process.on('SIGTERM', () => worker.stop());
  await worker.start();
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('index.ts') || entry.endsWith('index.js')) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
