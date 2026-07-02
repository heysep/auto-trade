import { describe, it, expect, vi } from 'vitest';
import { buildServer, type ServerOptions } from './server.js';
import { TradingSystem } from '../app/TradingSystem.js';
import { StrategyRegistry } from '../strategy/StrategyRegistry.js';
import { TimeSeriesMomentumStrategy } from '../strategy/TimeSeriesMomentumStrategy.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import { HaltSwitch } from '../app/HaltSwitch.js';
import { SymbolCatalog } from '../market/SymbolCatalog.js';
import { StrategyEngine } from '../strategy/StrategyEngine.js';
import { WatchList } from '../market/WatchList.js';
import { StrategyDeployer } from '../app/StrategyDeployer.js';
import { FactorRankingService } from '../factor/FactorRankingService.js';
import { FactorBacktestService } from '../factor/FactorBacktestService.js';
import { FactorModel } from '../factor/FactorModel.js';
import type { PromotionInput } from '../strategy/PromotionGate.js';
import type { Order, Position, Quote } from '../domain/types.js';
import type { TossCandle, TossStock, ChartCandle } from '../toss/types.js';
import type { OrderManager } from '../order/OrderManager.js';
import type { StrategyView } from '../strategy/StrategyRegistry.js';
import type { RankingResult } from '../factor/FactorRankingService.js';
import type { FactorBacktestReport } from '../factor/FactorBacktestService.js';
import { FactorPortfolioManager } from '../factor/FactorPortfolioManager.js';
import type { RebalancePlan } from '../factor/FactorPortfolioManager.js';
import type { TossPriceItem } from '../toss/types.js';
import { FACTOR_PORTFOLIO_STRATEGY_ID } from '../app/TradingSystem.js';

const ELIGIBLE: PromotionInput = {
  paperDays: 35, navSnapshotCount: 35, dailyLossViolations: 0,
  metrics: { totalReturn: 0.08, maxDrawdown: -0.05, winRate: 0.6, profitFactor: 1.6, tradeCount: 60, avgWinLoss: 1.4 },
};

function harness(opts: {
  server?: ServerOptions;
  promotionInputFor?: (id: number) => PromotionInput;
  symbolCatalog?: SymbolCatalog;
  getCandles?: (symbol: string, interval: '1m' | '1d') => Promise<TossCandle[]>;
  /** When true, harness builds a StrategyEngine + WatchList + StrategyDeployer sharing the same registry as the system. */
  withDeployer?: boolean;
  factorRanking?: FactorRankingService;
  factorBacktest?: FactorBacktestService;
  factorPortfolio?: FactorPortfolioManager;
  getPrices?: (symbols: string[]) => Promise<TossPriceItem[]>;
  factorPortfolioTopN?: number;
} = {}) {
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  const registry = new StrategyRegistry();
  const logger = new InMemoryEventLogger();
  const haltSwitch = new HaltSwitch();

  registry.register(new TimeSeriesMomentumStrategy({
    id: 1, symbol: '005930', currency: 'KRW', mode: 'PAPER',
    lookback: 20, orderNotional: 1_000_000,
  }), 'tsmom-flagship');

  book.set({ symbol: '005930', currency: 'KRW', bid: 70_000, ask: 70_100, last: 70_050, ts: 0 } as Quote);
  repo.upsertPosition({ strategyId: 1, symbol: '005930', mode: 'PAPER', quantity: 10, avgPrice: 70_000, realizedPnl: 0 } as Position);
  repo.saveOrder({ id: 'o1', strategyId: 1, symbol: '005930', currency: 'KRW', side: 'BUY', orderType: 'MARKET', quantity: 10, status: 'FILLED', mode: 'PAPER', idempotencyKey: 'o1', createdAt: 0 } as Order);

  // Optionally build a deployer that shares the same registry so system.deploy() can look up the view.
  let deployer: StrategyDeployer | undefined;
  if (opts.withDeployer) {
    const orderManager = { handleIntent: vi.fn() } as unknown as OrderManager;
    const engine = new StrategyEngine({ orderManager, getPosition: () => undefined });
    const watchList = new WatchList();
    // Static strategy has id=1; dynamic deployer starts at id=10 to avoid collisions.
    deployer = new StrategyDeployer({ engine, registry, watchList, currency: 'KRW', mode: 'PAPER' }, 10);
  }

  const system = new TradingSystem({
    repo, book, registry, logger, haltSwitch, now: () => 0,
    ...(opts.promotionInputFor ? { promotionInputFor: opts.promotionInputFor } : {}),
    ...(opts.symbolCatalog ? { symbolCatalog: opts.symbolCatalog } : {}),
    ...(opts.getCandles ? { getCandles: opts.getCandles } : {}),
    ...(deployer ? { deployer } : {}),
    ...(opts.factorRanking !== undefined ? { factorRanking: opts.factorRanking } : {}),
    ...(opts.factorBacktest !== undefined ? { factorBacktest: opts.factorBacktest } : {}),
    ...(opts.factorPortfolio !== undefined ? { factorPortfolio: opts.factorPortfolio } : {}),
    ...(opts.getPrices !== undefined ? { getPrices: opts.getPrices } : {}),
    ...(opts.factorPortfolioTopN !== undefined ? { factorPortfolioTopN: opts.factorPortfolioTopN } : {}),
  });
  return { app: buildServer(system, opts.server ?? {}), logger, haltSwitch, deployer, book, repo };
}

describe('HTTP API', () => {
  it('lists strategies, positions, and orders', async () => {
    const { app } = harness();
    expect((await app.inject({ method: 'GET', url: '/api/strategies' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/positions' })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/orders' })).json()[0].id).toBe('o1');
    expect((await app.inject({ method: 'GET', url: '/api/logs' })).statusCode).toBe(200);
  });

  it('serves the dashboard HTML at /', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('auto-trading');
    expect(res.body).toContain('긴급 정지');
    expect(res.headers['content-type']).toMatch(/charset=utf-8/);
    expect(res.body).toMatch(/replace\(\/\[&<>/);   // cell() escapes interpolated values (anti-XSS)
  });

  it('composer page: lightweight-charts CDN, backtest UI, deploy button, anti-XSS helper', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-type']).toMatch(/charset=utf-8/);
    expect(res.body).toContain('lightweight-charts');
    expect(res.body).toContain('백테스트');
    expect(res.body).toContain('페이퍼 배포');
    expect(res.body).toContain('esc(');
    expect(res.body).toContain('팩터 랭킹');
    expect(res.body).toContain('팩터 백테스트');
    expect(res.body).toContain('리밸런싱');
  });

  it('404s unknown strategy/quote; 400s a bad mode', async () => {
    const { app } = harness();
    expect((await app.inject({ method: 'GET', url: '/api/strategies/99' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/market/price/NOPE' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/orders?mode=foo' })).statusCode).toBe(400);
  });

  it('enforces the promotion gate on status transitions', async () => {
    const { app } = harness({ promotionInputFor: () => ELIGIBLE });
    const patch = (status: string, approved?: boolean) =>
      app.inject({ method: 'PATCH', url: '/api/strategies/1/status', payload: { status, ...(approved ? { approved } : {}) } });

    expect((await patch('LIVE', true)).statusCode).toBe(400);          // illegal: must be APPROVED first
    expect((await patch('PAUSED')).statusCode).toBe(200);              // legal, ungated
    // back to PAPER_TESTING then up the ladder
    expect((await patch('PAPER_TESTING')).statusCode).toBe(200);
    expect((await patch('APPROVED')).statusCode).toBe(403);            // gated: needs approval
    expect((await patch('APPROVED', true)).statusCode).toBe(200);      // approved + eligible
    expect((await patch('LIVE', true)).statusCode).toBe(200);
  });

  it('fails closed: APPROVED is refused when no promotion metrics are available', async () => {
    const { app } = harness();   // no promotionInputFor
    const res = await app.inject({ method: 'PATCH', url: '/api/strategies/1/status', payload: { status: 'APPROVED', approved: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/promotion criteria/);
  });

  it('emergency-stop trips the halt and logs it; resume clears it (worker untouched)', async () => {
    const { app, haltSwitch, logger } = harness();
    const stop = await app.inject({ method: 'POST', url: '/api/emergency-stop', payload: { reason: 'panic' } });
    expect(stop.json()).toEqual({ halted: true, reason: 'panic' });
    expect(haltSwitch.halted).toBe(true);
    expect(logger.ofType('EMERGENCY_STOP')).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/resume' })).json()).toEqual({ halted: false, reason: undefined });
  });

  it('emergency-stop works with an empty JSON body', async () => {
    const { app, haltSwitch } = harness();
    const res = await app.inject({ method: 'POST', url: '/api/emergency-stop', headers: { 'content-type': 'application/json' }, payload: '' });
    expect(res.statusCode).toBe(200);
    expect(haltSwitch.halted).toBe(true);
  });

  it('requires the api token on mutations when configured', async () => {
    const { app } = harness({ server: { authToken: 'secret' } });
    expect((await app.inject({ method: 'POST', url: '/api/emergency-stop' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/strategies' })).statusCode).toBe(200);   // reads open
    const ok = await app.inject({ method: 'POST', url: '/api/emergency-stop', headers: { 'x-api-token': 'secret' } });
    expect(ok.statusCode).toBe(200);
    // DELETE is also token-gated
    expect((await app.inject({ method: 'DELETE', url: '/api/strategies/99' })).statusCode).toBe(401);
  });

  describe('market/symbols + market/candles', () => {
    const STOCKS: TossStock[] = [
      { symbol: '005930', name: '삼성전자', market: 'KR' },
      { symbol: '000660', name: 'SK하이닉스', market: 'KR' },
    ];
    // Raw TossCandle shape (returned by getCandles dep); system.candles() normalises to ChartCandle.
    const CANDLES: TossCandle[] = [
      {
        timestamp: '2026-03-25T09:00:00+09:00',
        openPrice: '70000',
        highPrice: '72000',
        lowPrice: '69000',
        closePrice: '71000',
      },
    ];

    function marketHarness() {
      const catalog = new SymbolCatalog(async () => STOCKS);
      const getCandles = async (_s: string, _i: '1m' | '1d'): Promise<TossCandle[]> => CANDLES;
      return harness({ symbolCatalog: catalog, getCandles });
    }

    it('/api/market/symbols?q=삼성 returns matching stocks', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/symbols?q=%EC%82%BC%EC%84%B1' });
      expect(res.statusCode).toBe(200);
      const body = res.json<TossStock[]>();
      expect(body).toHaveLength(1);
      expect(body[0]?.symbol).toBe('005930');
    });

    it('/api/market/symbols with no q returns all stocks', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/symbols' });
      expect(res.statusCode).toBe(200);
      expect(res.json<TossStock[]>()).toHaveLength(2);
    });

    it('/api/market/candles?symbol=005930 returns ChartCandle[] with numeric OHLC', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/candles?symbol=005930' });
      expect(res.statusCode).toBe(200);
      const body = res.json<ChartCandle[]>();
      expect(body).toHaveLength(1);
      // close is a number (string was normalised server-side)
      expect(body[0]?.close).toBe(71000);
      expect(typeof body[0]?.time).toBe('number');
    });

    it('/api/market/candles without symbol returns 400', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/candles' });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/symbol/);
    });

    it('/api/market/candles with invalid interval returns 400', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/candles?symbol=005930&interval=5m' });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/interval/);
    });

    it('/api/market/candles accepts interval=1m', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/candles?symbol=005930&interval=1m' });
      expect(res.statusCode).toBe(200);
    });

    it('/api/market/symbols returns [] when no catalog is wired', async () => {
      const { app } = harness();
      const res = await app.inject({ method: 'GET', url: '/api/market/symbols?q=삼성' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('/api/market/candles returns [] when no candles fn is wired', async () => {
      const { app } = harness();
      const res = await app.inject({ method: 'GET', url: '/api/market/candles?symbol=005930' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  describe('backtest', () => {
    // TSMOM lookback=2 requires 3 warmup bars then buy signal + fill + sell signal + fill.
    // Bar 1 (60000): NEUTRAL  Bar 2 (60000): NEUTRAL  Bar 3 (85000): BULLISH→BUY queued
    // Bar 4 (85000): BUY fills; BULLISH, null   Bar 5 (40000): BEARISH→SELL queued
    // Bar 6 (40000): SELL fills → tradeCount = 1
    // Timestamps: Date.parse(t)/1000 = 1000..6000 (epoch seconds).
    const BT_CANDLES: TossCandle[] = [
      { timestamp: '1970-01-01T00:16:40.000Z', openPrice: '60000', highPrice: '61000', lowPrice: '59000', closePrice: '60000' },
      { timestamp: '1970-01-01T00:33:20.000Z', openPrice: '60000', highPrice: '61000', lowPrice: '59000', closePrice: '60000' },
      { timestamp: '1970-01-01T00:50:00.000Z', openPrice: '85000', highPrice: '86000', lowPrice: '84000', closePrice: '85000' },
      { timestamp: '1970-01-01T01:06:40.000Z', openPrice: '85000', highPrice: '86000', lowPrice: '84000', closePrice: '85000' },
      { timestamp: '1970-01-01T01:23:20.000Z', openPrice: '40000', highPrice: '41000', lowPrice: '39000', closePrice: '40000' },
      { timestamp: '1970-01-01T01:40:00.000Z', openPrice: '40000', highPrice: '41000', lowPrice: '39000', closePrice: '40000' },
    ];

    const SPEC = {
      type: 'tsmom' as const,
      params: { lookback: 2, orderNotional: 1_000_000 },
    };

    function btHarness() {
      return harness({ getCandles: async () => BT_CANDLES });
    }

    it('returns 200 with metrics.tradeCount >= 1 for a trading spec', async () => {
      const { app } = btHarness();
      const res = await app.inject({
        method: 'POST',
        url: '/api/backtest',
        payload: { symbol: '005930', spec: SPEC },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ metrics: { tradeCount: number }; equityCurve: number[]; rejected: number; markers: unknown[] }>();
      expect(body.metrics.tradeCount).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(body.equityCurve)).toBe(true);
      expect(typeof body.rejected).toBe('number');
      expect(Array.isArray(body.markers)).toBe(true);
      expect(body.markers.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when symbol is missing', async () => {
      const { app } = btHarness();
      const res = await app.inject({
        method: 'POST',
        url: '/api/backtest',
        payload: { spec: SPEC },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when spec is missing', async () => {
      const { app } = btHarness();
      const res = await app.inject({
        method: 'POST',
        url: '/api/backtest',
        payload: { symbol: '005930' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('dynamic strategy deploy / undeploy', () => {
    const TSMOM_SPEC = {
      type: 'tsmom' as const,
      params: { lookback: 10, orderNotional: 500_000 },
    };

    it('POST /api/strategies deploys a strategy (201) and it appears in GET /api/strategies', async () => {
      const { app } = harness({ withDeployer: true });

      const post = await app.inject({
        method: 'POST', url: '/api/strategies',
        payload: { symbol: '035720', spec: TSMOM_SPEC, name: 'dynamic-dip' },
      });
      expect(post.statusCode).toBe(201);
      const view = post.json<StrategyView>();
      expect(view.name).toBe('dynamic-dip');
      expect(view.status).toBe('PAPER_TESTING');

      const list = await app.inject({ method: 'GET', url: '/api/strategies' });
      const strategies = list.json<StrategyView[]>();
      expect(strategies.some((s) => s.name === 'dynamic-dip')).toBe(true);
    });

    it('DELETE /api/strategies/:id removes a deployed strategy', async () => {
      const { app } = harness({ withDeployer: true });

      const post = await app.inject({
        method: 'POST', url: '/api/strategies',
        payload: { symbol: '035720', spec: TSMOM_SPEC, name: 'to-remove' },
      });
      expect(post.statusCode).toBe(201);
      const { id } = post.json<StrategyView>();

      const del = await app.inject({ method: 'DELETE', url: `/api/strategies/${id}` });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ ok: true });

      // No longer in the deployer's registry
      const del2 = await app.inject({ method: 'DELETE', url: `/api/strategies/${id}` });
      expect(del2.statusCode).toBe(404);
    });

    it('DELETE /api/strategies/:id returns 404 for unknown id', async () => {
      const { app } = harness({ withDeployer: true });
      const res = await app.inject({ method: 'DELETE', url: '/api/strategies/9999' });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toMatch(/not found/);
    });

    it('POST /api/strategies returns 400 when deployer is not configured', async () => {
      const { app } = harness();  // no deployer
      const res = await app.inject({
        method: 'POST', url: '/api/strategies',
        payload: { symbol: '035720', spec: TSMOM_SPEC, name: 'wont-work' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/deployer/);
    });

    it('POST /api/strategies returns 400 when spec is missing', async () => {
      const { app } = harness({ withDeployer: true });
      const res = await app.inject({
        method: 'POST', url: '/api/strategies',
        payload: { symbol: '035720', name: 'no-spec' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/spec/);
    });
  });

  describe('GET /api/factors/ranking', () => {
    const SMALL_PERIODS = { momSkip: 1, momLong: 3, momMid: 2, volWindow: 3, mddWindow: 3 };
    const UNIVERSE: TossStock[] = [
      { symbol: 'A', name: 'Alpha', market: 'KR' },
      { symbol: 'B', name: 'Beta', market: 'KR' },
    ];
    // 5 bars: enough for SMALL_PERIODS
    function makeCandles(closes: number[]): TossCandle[] {
      return closes.map((close, i) => ({
        timestamp: new Date(1000 * (i + 1)).toISOString(),
        openPrice: String(close),
        highPrice: String(close),
        lowPrice: String(close),
        closePrice: String(close),
      }));
    }
    const CANDLES_A = makeCandles([100, 102, 104, 106, 108]);
    const CANDLES_B = makeCandles([100, 80, 120, 60, 50]);

    function factorHarness() {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const svc = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles: async (symbol: string, _interval: '1d') =>
          symbol === 'A' ? CANDLES_A : CANDLES_B,
        model,
      });
      return harness({ factorRanking: svc });
    }

    it('returns 200 with a scored ranking when FactorRankingService is wired', async () => {
      const { app } = factorHarness();
      const res = await app.inject({ method: 'GET', url: '/api/factors/ranking' });
      expect(res.statusCode).toBe(200);

      const body = res.json<RankingResult>();
      expect(body.universeSize).toBe(2);
      expect(body.scored).toHaveLength(2);
      expect(body.scored[0]?.rank).toBe(1);
      expect(body.scored[1]?.rank).toBe(2);
      expect(typeof body.asOf).toBe('number');
    });

    it('respects ?limit= and returns only the top N entries', async () => {
      const { app } = factorHarness();
      const res = await app.inject({ method: 'GET', url: '/api/factors/ranking?limit=1' });
      expect(res.statusCode).toBe(200);
      expect(res.json<RankingResult>().scored).toHaveLength(1);
    });

    it('returns 503 with error body when FactorRankingService is not wired', async () => {
      const { app } = harness(); // no factorRanking
      const res = await app.inject({ method: 'GET', url: '/api/factors/ranking' });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: string }>().error).toBe('factor ranking unavailable');
    });
  });

  describe('POST /api/factors/backtest', () => {
    const SMALL_PERIODS = { momSkip: 1, momLong: 3, momMid: 2, volWindow: 3, mddWindow: 3 };
    const BT_UNIVERSE: TossStock[] = [
      { symbol: 'A', name: 'Alpha',  market: 'KOSPI'  },
      { symbol: 'B', name: 'Beta',   market: 'KOSDAQ' },
      { symbol: 'C', name: 'Gamma',  market: 'KOSPI'  },
    ];
    function makeBtCandles(closes: number[]): TossCandle[] {
      return closes.map((close, i) => ({
        timestamp: new Date(86_400_000 * (i + 1)).toISOString(),
        openPrice: String(close),
        highPrice: String(close),
        lowPrice: String(close),
        closePrice: String(close),
      }));
    }
    const BT_CLOSES: Record<string, number[]> = {
      A: [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122],
      B: [100,  80, 120,  60,  50,  55,  60,  65,  70,  75,  80,  85],
      C: [100, 100, 100, 100, 100, 101, 101, 102, 102, 103, 103, 104],
    };

    function btFactorHarness() {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const svc = new FactorBacktestService({
        universe: () => BT_UNIVERSE,
        getCandles: async (symbol: string, _interval: '1d', _count: number): Promise<TossCandle[]> => {
          const data = BT_CLOSES[symbol];
          if (data === undefined) throw new Error(`unknown: ${symbol}`);
          return makeBtCandles(data);
        },
        model,
      });
      return harness({ factorBacktest: svc });
    }

    it('returns 200 with a backtest report when FactorBacktestService is wired', async () => {
      const { app } = btFactorHarness();
      const res = await app.inject({
        method: 'POST',
        url: '/api/factors/backtest',
        payload: { topN: 2, rebalanceEvery: 3 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<FactorBacktestReport>();
      expect(body.universeSize).toBe(3);
      expect(body.fetched).toBe(3);
      expect(body.skipped).toBe(0);
      expect(Array.isArray(body.result.equityCurve)).toBe(true);
      expect(Array.isArray(body.result.rebalances)).toBe(true);
      expect(typeof body.result.metrics.totalReturn).toBe('number');
      expect(typeof body.result.metrics.finalNav).toBe('number');
    });

    it('returns 503 when FactorBacktestService is not wired', async () => {
      const { app } = harness(); // no factorBacktest
      const res = await app.inject({ method: 'POST', url: '/api/factors/backtest', payload: {} });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: string }>().error).toBe('factor backtest unavailable');
    });

    it('returns 400 for topN: -1', async () => {
      const { app } = btFactorHarness();
      const res = await app.inject({
        method: 'POST',
        url: '/api/factors/backtest',
        payload: { topN: -1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/topN/);
    });

    it('returns 400 for rebalanceEvery: 0', async () => {
      const { app } = btFactorHarness();
      const res = await app.inject({
        method: 'POST',
        url: '/api/factors/backtest',
        payload: { rebalanceEvery: 0 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/rebalanceEvery/);
    });

    it('returns 400 for startCapital: -1000', async () => {
      const { app } = btFactorHarness();
      const res = await app.inject({
        method: 'POST',
        url: '/api/factors/backtest',
        payload: { startCapital: -1000 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/startCapital/);
    });
  });
});

describe('POST /api/factors/rebalance', () => {
  const SYMBOLS = ['005930', '000660'];

  /** Minimal duck-typed ranking usable as both FactorRankingService and FactorPortfolioDeps.ranking. */
  function makeRanking(symbols: string[]) {
    return {
      rank: async (_limit?: number) => ({
        asOf: 0,
        scored: symbols.map((symbol, i) => ({ symbol, rank: i + 1, composite: 1 - i * 0.1, sector: 'KR', factors: {} })),
        universeSize: symbols.length,
        fetched: symbols.length,
        skipped: 0,
      }),
    };
  }

  function makeGetPrices(price: string) {
    return async (syms: string[]): Promise<TossPriceItem[]> =>
      syms.map((symbol) => ({ symbol, lastPrice: price }));
  }

  it('returns 503 when factorPortfolio dep is absent', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/unavailable/i);
  });

  it('returns 409 when TradingSystem halt switch is set', async () => {
    const ranking = makeRanking(SYMBOLS);
    const { app, haltSwitch, book } = harness({
      factorRanking: ranking as unknown as FactorRankingService,
      factorPortfolio: new FactorPortfolioManager(
        {
          ranking,
          priceOf: (sym) => book.getQuote(sym)?.last,
          currentQty: () => 0,
          heldSymbols: () => [],
          submitIntent: async () => {},
          isHalted: () => haltSwitch.halted,
        },
        { strategyId: FACTOR_PORTFOLIO_STRATEGY_ID, topN: 2, totalNotional: 10_000_000, currency: 'KRW', mode: 'PAPER' },
      ),
      getPrices: makeGetPrices('70000'),
      factorPortfolioTopN: 2,
    });
    haltSwitch.trip('test halt');
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/halt/i);
  });

  it('returns RebalancePlan with targets/ordersSubmitted/halted:false', async () => {
    const ranking = makeRanking(SYMBOLS);
    const { app, haltSwitch, book } = harness({
      factorRanking: ranking as unknown as FactorRankingService,
      factorPortfolio: new FactorPortfolioManager(
        {
          ranking,
          priceOf: (sym) => book.getQuote(sym)?.last,
          currentQty: () => 0,
          heldSymbols: () => [],
          submitIntent: async () => {},
          isHalted: () => haltSwitch.halted,
        },
        { strategyId: FACTOR_PORTFOLIO_STRATEGY_ID, topN: 2, totalNotional: 10_000_000, currency: 'KRW', mode: 'PAPER' },
      ),
      getPrices: makeGetPrices('70000'),
      factorPortfolioTopN: 2,
    });
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(200);
    const plan = res.json() as RebalancePlan;
    expect(plan.halted).toBe(false);
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets[0]?.price).toBe(70000);
    expect(plan.targets[0]?.targetQty).toBe(Math.floor(5_000_000 / 70000));
    expect(plan.targets[1]?.price).toBe(70000);
    expect(plan.targets[1]?.targetQty).toBe(Math.floor(5_000_000 / 70000));
    expect(Array.isArray(plan.ordersSubmitted)).toBe(true);
    expect(Array.isArray(plan.skipped)).toBe(true);
  });

  it('sets quotes in QuoteBook (prices visible in targets) before rebalance', async () => {
    // TradingSystem.rebalanceFactorPortfolio sets quotes in its book dep THEN calls rebalance().
    // FactorPortfolioManager.priceOf reads from that same book (via closure).
    // Evidence: plan.targets have price=75000, meaning quotes were populated before rebalance ran.
    const ranking = makeRanking(SYMBOLS);
    const { app, haltSwitch, book } = harness({
      factorRanking: ranking as unknown as FactorRankingService,
      factorPortfolio: new FactorPortfolioManager(
        {
          ranking,
          priceOf: (sym) => book.getQuote(sym)?.last,
          currentQty: () => 0,
          heldSymbols: () => [],
          submitIntent: async () => {},
          isHalted: () => haltSwitch.halted,
        },
        { strategyId: FACTOR_PORTFOLIO_STRATEGY_ID, topN: 2, totalNotional: 10_000_000, currency: 'KRW', mode: 'PAPER' },
      ),
      getPrices: makeGetPrices('75000'),
      factorPortfolioTopN: 2,
    });
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(200);
    const plan = res.json() as RebalancePlan;
    // targets priced at 75000 proves book was populated before rebalance() ran
    expect(plan.targets.length).toBeGreaterThan(0);
    expect(plan.targets[0]?.price).toBe(75000);
    // Confirm via GET /api/market/price/:symbol
    for (const sym of SYMBOLS) {
      const qRes = await app.inject({ method: 'GET', url: `/api/market/price/${sym}` });
      expect(qRes.statusCode).toBe(200);
      expect(qRes.json().last).toBe(75000);
    }
  });
});
