import { describe, it, expect } from 'vitest';
import { buildServer, type ServerOptions } from './server.js';
import { TradingSystem } from '../app/TradingSystem.js';
import { StrategyRegistry } from '../strategy/StrategyRegistry.js';
import { ThresholdStrategy } from '../strategy/ThresholdStrategy.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import { HaltSwitch } from '../app/HaltSwitch.js';
import type { PromotionInput } from '../strategy/PromotionGate.js';
import type { Order, Position, Quote } from '../domain/types.js';

const ELIGIBLE: PromotionInput = {
  paperDays: 35, navSnapshotCount: 35, dailyLossViolations: 0,
  metrics: { totalReturn: 0.08, maxDrawdown: -0.05, winRate: 0.6, profitFactor: 1.6, tradeCount: 60, avgWinLoss: 1.4 },
};

function harness(opts: { server?: ServerOptions; promotionInputFor?: (id: number) => PromotionInput } = {}) {
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

  const system = new TradingSystem({
    repo, book, registry, logger, haltSwitch, now: () => 0,
    ...(opts.promotionInputFor ? { promotionInputFor: opts.promotionInputFor } : {}),
  });
  return { app: buildServer(system, opts.server ?? {}), logger, haltSwitch };
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
  });
});
