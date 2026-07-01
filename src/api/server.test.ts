import { describe, it, expect, vi } from 'vitest';
import { buildServer, type ServerOptions } from './server.js';
import { TradingSystem } from '../app/TradingSystem.js';
import { StrategyRegistry } from '../strategy/StrategyRegistry.js';
import { ThresholdStrategy } from '../strategy/ThresholdStrategy.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import { HaltSwitch } from '../app/HaltSwitch.js';
import { SymbolCatalog } from '../market/SymbolCatalog.js';
import { StrategyEngine } from '../strategy/StrategyEngine.js';
import { WatchList } from '../market/WatchList.js';
import { StrategyDeployer } from '../app/StrategyDeployer.js';
import type { PromotionInput } from '../strategy/PromotionGate.js';
import type { Order, Position, Quote } from '../domain/types.js';
import type { TossCandle, TossStock } from '../toss/types.js';
import type { OrderManager } from '../order/OrderManager.js';
import type { StrategyView } from '../strategy/StrategyRegistry.js';

const ELIGIBLE: PromotionInput = {
  paperDays: 35, navSnapshotCount: 35, dailyLossViolations: 0,
  metrics: { totalReturn: 0.08, maxDrawdown: -0.05, winRate: 0.6, profitFactor: 1.6, tradeCount: 60, avgWinLoss: 1.4 },
};

function harness(opts: {
  server?: ServerOptions;
  promotionInputFor?: (id: number) => PromotionInput;
  symbolCatalog?: SymbolCatalog;
  getCandles?: (symbol: string, interval: string) => Promise<TossCandle[]>;
  /** When true, harness builds a StrategyEngine + WatchList + StrategyDeployer sharing the same registry as the system. */
  withDeployer?: boolean;
} = {}) {
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  const registry = new StrategyRegistry();
  const logger = new InMemoryEventLogger();
  const haltSwitch = new HaltSwitch();

  registry.register(new ThresholdStrategy({
    id: 1, symbol: '005930', currency: 'KRW', mode: 'PAPER',
    buyBelow: 70_000, sellAbove: 80_000, orderNotional: 1_000_000,
  }), 'dip-buyer');

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
  });
  return { app: buildServer(system, opts.server ?? {}), logger, haltSwitch, deployer };
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
    const CANDLES: TossCandle[] = [
      { time: 1_000_000, open: '70000', high: '72000', low: '69000', close: '71000' },
    ];

    function marketHarness() {
      const catalog = new SymbolCatalog(async () => STOCKS);
      const getCandles = async (_s: string, _i: string): Promise<TossCandle[]> => CANDLES;
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

    it('/api/market/candles?symbol=005930 returns the stub array', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/candles?symbol=005930' });
      expect(res.statusCode).toBe(200);
      const body = res.json<TossCandle[]>();
      expect(body).toHaveLength(1);
      expect(body[0]?.close).toBe('71000');
    });

    it('/api/market/candles without symbol returns 400', async () => {
      const { app } = marketHarness();
      const res = await app.inject({ method: 'GET', url: '/api/market/candles' });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/symbol/);
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
    // Rising-then-falling series: price below buyBelow triggers BUY on bar 0 (filled bar 1),
    // then price above sellAbove triggers SELL on bar 2 (filled bar 3) → tradeCount = 1.
    const BT_CANDLES: TossCandle[] = [
      { time: 1000, open: '60000', high: '61000', low: '59000', close: '60000' },
      { time: 2000, open: '60000', high: '61000', low: '59000', close: '60000' },
      { time: 3000, open: '85000', high: '86000', low: '84000', close: '85000' },
      { time: 4000, open: '85000', high: '86000', low: '84000', close: '85000' },
    ];

    const SPEC = {
      type: 'threshold' as const,
      params: { buyBelow: 70_000, sellAbove: 80_000, orderNotional: 1_000_000 },
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
    const THRESHOLD_SPEC = {
      type: 'threshold' as const,
      params: { buyBelow: 65_000, sellAbove: 75_000, orderNotional: 500_000 },
    };

    it('POST /api/strategies deploys a strategy (201) and it appears in GET /api/strategies', async () => {
      const { app } = harness({ withDeployer: true });

      const post = await app.inject({
        method: 'POST', url: '/api/strategies',
        payload: { symbol: '035720', spec: THRESHOLD_SPEC, name: 'dynamic-dip' },
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
        payload: { symbol: '035720', spec: THRESHOLD_SPEC, name: 'to-remove' },
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
        payload: { symbol: '035720', spec: THRESHOLD_SPEC, name: 'wont-work' },
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
});
