import { describe, it, expect } from 'vitest';
import { LiveBroker, type LiveOrderClient } from './LiveBroker.js';
import { InMemoryRepository } from '../persistence/repository.js';
import type { OrderRequest } from '../domain/types.js';
import type { OrderCreateRequest, TossOrder } from '../toss/types.js';

const T = 1_700_000_000_000;
const req = (o: Partial<OrderRequest> = {}): OrderRequest => ({
  strategyId: 1, symbol: '005930', currency: 'KRW', side: 'BUY',
  orderType: 'MARKET', quantity: 10, idempotencyKey: 'idem-1', ...o,
});

function mockClient(over: Partial<LiveOrderClient> = {}) {
  const placed: OrderCreateRequest[] = [];
  const client: LiveOrderClient = {
    placeOrder: async (_a, body) => { placed.push(body); return { orderId: 'TID-1' }; },
    cancelOrder: async () => ({}),
    getOrders: async () => ({
      orders: [{
        orderId: 'TID-9', symbol: '005930', side: 'BUY', orderType: 'LIMIT',
        status: 'PARTIAL_FILLED', quantity: '10', execution: { filledQuantity: '4' },
      } as TossOrder],
    }),
    getOrder: async (_a, id) => ({
      orderId: id, symbol: '005930', side: 'SELL', orderType: 'MARKET', status: 'FILLED',
      execution: {
        filledQuantity: '10', averageFilledPrice: '71000', commission: '100', tax: '1277',
        filledAt: '2026-06-30T01:00:00Z',
      },
    } as TossOrder),
    ...over,
  };
  return { client, placed };
}

describe('LiveBroker', () => {
  it('refuses to place orders while disabled (default)', async () => {
    const { client } = mockClient();
    const broker = new LiveBroker(client, '1', new InMemoryRepository(), { now: () => T });
    await expect(broker.placeOrder(req())).rejects.toThrow(/disabled/);
  });

  it('serializes numerics to strings, persists the order, and maps the create response', async () => {
    const { client, placed } = mockClient();
    const repo = new InMemoryRepository();
    const broker = new LiveBroker(client, '1', repo, { enabled: true, now: () => T });
    const { order, fills } = await broker.placeOrder(req({ orderType: 'LIMIT', limitPrice: 69000 }));

    expect(placed[0]).toMatchObject({
      clientOrderId: 'idem-1', symbol: '005930', side: 'BUY', orderType: 'LIMIT',
      quantity: '10', price: '69000',
    });
    expect(order.id).toBe('TID-1');
    expect(order.status).toBe('PENDING');
    expect(order.mode).toBe('LIVE');
    expect(fills).toHaveLength(0);                 // status unknown until queried
    expect(repo.getOpenOrders('LIVE').map((o) => o.id)).toEqual(['TID-1']);  // persisted
  });

  it('rejects an invalid order before hitting the live API', async () => {
    const { client, placed } = mockClient();
    const broker = new LiveBroker(client, '1', new InMemoryRepository(), { enabled: true });
    await expect(broker.placeOrder(req({ orderType: 'LIMIT' }))).rejects.toThrow(/limitPrice/);
    expect(placed).toHaveLength(0);                // never reached the API
  });

  it('maps open orders to broker-native view including filled quantity', async () => {
    const { client } = mockClient();
    const broker = new LiveBroker(client, '1', new InMemoryRepository(), { enabled: true });
    const open = await broker.getOpenOrders();
    expect(open).toEqual([{
      brokerOrderId: 'TID-9', symbol: '005930', side: 'BUY',
      status: 'PARTIAL_FILLED', quantity: 10, filledQuantity: 4,
    }]);
  });

  it('maps execution into a fill', async () => {
    const { client } = mockClient();
    const broker = new LiveBroker(client, '1', new InMemoryRepository(), { enabled: true });
    const fills = await broker.getFills('TID-1');
    expect(fills[0]).toMatchObject({ quantity: 10, price: 71000, fee: 100, tax: 1277 });
  });
});
