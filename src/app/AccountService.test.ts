// TDD tests for AccountService (real Toss account holdings, read-only).

import { describe, it, expect, vi } from 'vitest';
import { AccountService } from './AccountService.js';
import type { TossAccount, TossHoldings, TossHoldingsItem } from '../toss/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<TossHoldingsItem> = {}): TossHoldingsItem {
  return {
    symbol: 'A001',
    name: '종목A',
    marketCountry: 'KR',
    currency: 'KRW',
    quantity: '10',
    lastPrice: '110000',
    averagePurchasePrice: '100000',
    marketValue: '1100000',
    profitLoss: '100000',
    cost: '1000000',
    ...overrides,
  };
}

function makeHoldings(overrides: Partial<TossHoldings> = {}): TossHoldings {
  return {
    totalPurchaseAmount: { krw: '1000000', usd: '0' },
    marketValue: { krw: '1100000', usd: '0' },
    profitLoss: { krw: '100000', usd: '0' },
    dailyProfitLoss: { krw: '5000', usd: '0' },
    items: [makeItem()],
    ...overrides,
  };
}

type FakeClient = {
  getAccounts: ReturnType<typeof vi.fn>;
  getHoldings: ReturnType<typeof vi.fn>;
};

function fakeClient(
  accountSeqs: number[] = [42],
  holdings: TossHoldings = makeHoldings(),
): FakeClient {
  return {
    getAccounts: vi.fn(async (): Promise<TossAccount[]> =>
      accountSeqs.map((seq) => ({ accountSeq: seq })),
    ),
    getHoldings: vi.fn(async (_account: string): Promise<TossHoldings> => holdings),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccountService', () => {
  // 1. accountSeq is resolved once across multiple holdings() calls within TTL
  it('resolves accountSeq once across two holdings() calls within TTL', async () => {
    let t = 0;
    const client = fakeClient();
    const svc = new AccountService({ client, now: () => t, ttlMs: 60_000 });

    await svc.holdings();
    t = 1_000; // 1 s — well within 60 s TTL
    await svc.holdings();

    expect(client.getAccounts).toHaveBeenCalledTimes(1);
  });

  // 2. String fields are normalized to numbers
  it('normalizes string summary fields to numbers', async () => {
    const client = fakeClient();
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.summary.purchaseAmount).toBe(1_000_000);
    expect(result.summary.marketValue).toBe(1_100_000);
    expect(result.summary.profitLoss).toBe(100_000);
    expect(result.summary.dailyProfitLoss).toBe(5_000);
  });

  it('normalizes item quantity, avgPrice, lastPrice to numbers', async () => {
    const client = fakeClient();
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    const item = result.items[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.quantity).toBe(10);
    expect(item.avgPrice).toBe(100_000);
    expect(item.lastPrice).toBe(110_000);
    expect(item.marketValue).toBe(1_100_000);
    expect(item.profitLoss).toBe(100_000);
  });

  // 3. returnPct = profitLoss / cost when cost > 0
  it('computes returnPct from cost when cost > 0', async () => {
    const client = fakeClient([42], makeHoldings({
      items: [makeItem({ profitLoss: '100000', cost: '1000000' })],
    }));
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.items[0]?.returnPct).toBeCloseTo(0.1);
  });

  it('falls back to avgPrice*quantity as cost basis when cost=0', async () => {
    // cost=0 but avgPrice=100000, quantity=10 → costBasis=1000000
    const client = fakeClient([42], makeHoldings({
      items: [makeItem({ cost: '0', averagePurchasePrice: '100000', quantity: '10', profitLoss: '50000' })],
    }));
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.items[0]?.returnPct).toBeCloseTo(0.05);
  });

  // 4. After TTL elapses, second call refetches holdings
  it('refetches holdings after TTL expires', async () => {
    let t = 0;
    const client = fakeClient();
    const svc = new AccountService({ client, now: () => t, ttlMs: 30_000 });

    await svc.holdings(); // first fetch
    t = 31_000;            // advance past TTL
    await svc.holdings(); // should refetch

    expect(client.getHoldings).toHaveBeenCalledTimes(2);
  });

  // 5. Concurrent calls join a single in-flight fetch (thundering-herd guard)
  it('in-flight dedup: concurrent calls issue exactly one getHoldings', async () => {
    let resolveDeferred!: (v: TossHoldings) => void;
    const deferred = new Promise<TossHoldings>((r) => {
      resolveDeferred = r;
    });

    const getHoldings = vi.fn(() => deferred);
    const getAccounts = vi.fn(async (): Promise<TossAccount[]> => [{ accountSeq: 42 }]);
    const svc = new AccountService({
      client: { getAccounts, getHoldings },
      now: () => 0,
      ttlMs: 60_000,
    });

    // Fire two concurrent calls before the first one resolves.
    const p1 = svc.holdings();
    const p2 = svc.holdings();

    // Resolve the deferred so both calls can complete.
    resolveDeferred(makeHoldings());

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(getHoldings).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  // 6. Items whose essential numeric fields cannot be parsed are skipped
  it('skips items with un-parseable quantity, keeps other items', async () => {
    const goodItem = makeItem({ symbol: 'B002', name: '종목B' });
    const badItem = makeItem({ symbol: 'BAD', quantity: 'abc' });
    const client = fakeClient([42], makeHoldings({ items: [badItem, goodItem] }));
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.symbol).toBe('B002');
  });
});
