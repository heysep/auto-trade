import { describe, it, expect } from 'vitest';
import { OrderManager } from './OrderManager.js';
import { RiskManager, type RiskContext } from '../risk/RiskManager.js';
import { HaltSwitch } from '../app/HaltSwitch.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import type { Broker } from '../broker/Broker.js';
import type { Strategy, OrderIntent } from '../strategy/Strategy.js';
import type { Order, OrderRequest, Quote } from '../domain/types.js';

const strategy: Strategy = {
  id: 1, symbols: new Set(['005930']), currency: 'KRW', mode: 'PAPER', evaluate: () => null,
};
const intent: OrderIntent = { side: 'BUY', quantity: 10, orderType: 'MARKET', reason: 'test' };
const quote: Quote = { symbol: '005930', currency: 'KRW', bid: 70_000, ask: 70_100, last: 70_050, ts: 0 };

const mkOrder = (req: OrderRequest): Order => ({
  id: req.idempotencyKey, strategyId: req.strategyId, symbol: req.symbol, currency: req.currency,
  side: req.side, orderType: req.orderType, quantity: req.quantity, status: 'FILLED',
  mode: 'PAPER', idempotencyKey: req.idempotencyKey, createdAt: 0,
});

function setup(haltSwitch?: HaltSwitch) {
  let placed = 0;
  const broker: Broker = {
    placeOrder: async (req) => { placed++; return { order: mkOrder(req), fills: [] }; },
    cancelOrder: async () => {},
    getOpenOrders: async () => [],
    getFills: async () => [],
  };
  const riskContext = (): RiskContext => ({
    mode: 'PAPER', status: 'PAPER_TESTING', capital: 1e9,
    limits: { maxPositionPct: 100, dailyMaxLoss: 1e9, maxConsecutiveLosses: 99 },
    positions: [], openOrdersForSymbol: 0, dailyRealizedPnl: 0, consecutiveLosses: 0,
  });
  const logger = new InMemoryEventLogger();
  const om = new OrderManager({
    brokerFor: () => broker, risk: new RiskManager(), riskContext, logger, now: () => 0,
    ...(haltSwitch ? { haltSwitch } : {}),
  });
  return { om, logger, placedCount: () => placed };
}

describe('OrderManager', () => {
  it('places an order through the broker on the happy path', async () => {
    const { om, placedCount } = setup();
    const out = await om.handleIntent(strategy, intent, quote);
    expect(out.status).toBe('placed');
    expect(placedCount()).toBe(1);
  });

  it('refuses every order when the halt switch is tripped, without touching the broker', async () => {
    const halt = new HaltSwitch();
    halt.trip('panic');
    const { om, logger, placedCount } = setup(halt);
    const out = await om.handleIntent(strategy, intent, quote);
    expect(out.status).toBe('blocked');
    expect(out).toMatchObject({ reason: expect.stringMatching(/halted/) });
    expect(placedCount()).toBe(0);                 // never reached the broker
    expect(logger.ofType('HALTED')).toHaveLength(1);
  });
});
