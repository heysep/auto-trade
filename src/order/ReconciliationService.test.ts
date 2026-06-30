import { describe, it, expect } from 'vitest';
import { ReconciliationService } from './ReconciliationService.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { InMemoryEventLogger } from '../observability/EventLogger.js';
import type { Broker, BrokerOrder } from '../broker/Broker.js';
import type { Order, Fill } from '../domain/types.js';

const order = (id: string): Order => ({
  id, strategyId: 1, symbol: '005930', currency: 'KRW', side: 'BUY',
  orderType: 'LIMIT', quantity: 10, limitPrice: 100, status: 'PENDING',
  mode: 'LIVE', idempotencyKey: id, createdAt: 0,
});
const brokerOrder = (id: string): BrokerOrder => ({
  brokerOrderId: id, symbol: '005930', side: 'BUY', status: 'PENDING', quantity: 10, filledQuantity: 0,
});
const brokerWith = (open: BrokerOrder[], fillsById: Record<string, Fill[]> = {}): Broker => ({
  placeOrder: async () => { throw new Error('n/a'); },
  cancelOrder: async () => {},
  getOpenOrders: async () => open,
  getFills: async (id) => fillsById[id] ?? [],
});

describe('ReconciliationService', () => {
  it('matches, flags broker-orphans, and resolves local-orphans by booking/closing them', async () => {
    const repo = new InMemoryRepository();
    repo.saveOrder(order('A'));    // matches broker
    repo.saveOrder(order('B'));    // closed at broker while offline
    const logger = new InMemoryEventLogger();
    const svc = new ReconciliationService(
      brokerWith([brokerOrder('A'), brokerOrder('C')]),   // C = broker-only
      repo, logger, { mode: 'LIVE', now: () => 0 },
    );

    const report = await svc.reconcile();
    expect(report.matched).toBe(1);                 // A
    expect(report.orphanBroker).toEqual(['C']);
    expect(report.resolvedLocal).toEqual(['B']);
    expect(repo.getOpenOrders('LIVE').map((o) => o.id)).toEqual(['A']);  // B closed
    expect(logger.ofType('RECONCILE_MISMATCH')).toHaveLength(1);
  });

  it('books a missed fill onto the position for a local-orphan that actually filled', async () => {
    const repo = new InMemoryRepository();
    repo.saveOrder(order('B'));
    const fill: Fill = { orderId: 'B', quantity: 10, price: 100, fee: 0, tax: 0, filledAt: 0 };
    const svc = new ReconciliationService(
      brokerWith([], { B: [fill] }), repo, new InMemoryEventLogger(), { mode: 'LIVE', now: () => 0 },
    );

    await svc.reconcile();
    const pos = repo.getPosition(1, '005930', 'LIVE')!;
    expect(pos.quantity).toBe(10);
    expect(pos.avgPrice).toBe(100);
    expect(repo.getFills('B')).toHaveLength(1);
  });

  it('logs RECONCILE_ERROR and rethrows when the broker is unreachable', async () => {
    const broker = { ...brokerWith([]), getOpenOrders: async () => { throw new Error('429'); } };
    const logger = new InMemoryEventLogger();
    const svc = new ReconciliationService(broker, new InMemoryRepository(), logger, { mode: 'LIVE', now: () => 0 });
    await expect(svc.reconcile()).rejects.toThrow(/429/);
    expect(logger.ofType('RECONCILE_ERROR')).toHaveLength(1);
  });

  it('logs nothing when fully aligned', async () => {
    const repo = new InMemoryRepository();
    repo.saveOrder(order('A'));
    const logger = new InMemoryEventLogger();
    const svc = new ReconciliationService(brokerWith([brokerOrder('A')]), repo, logger, { mode: 'LIVE', now: () => 0 });

    const report = await svc.reconcile();
    expect(report).toEqual({ matched: 1, orphanBroker: [], resolvedLocal: [] });
    expect(logger.events).toHaveLength(0);
  });
});
