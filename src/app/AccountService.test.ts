// TDD tests for AccountService (real Toss account holdings, read-only).
// Fixtures mirror the LIVE-probed /api/v1/holdings shape (2026-07): summary figures are
// nested { amount: { krw, usd }, rate? } objects; item money figures are nested objects
// in the item's own currency.

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
    marketValue: { purchaseAmount: '1000000', amount: '1100000' },
    profitLoss: { amount: '100000', rate: '0.1' },
    ...overrides,
  };
}

function makeHoldings(overrides: Partial<TossHoldings> = {}): TossHoldings {
  return {
    totalPurchaseAmount: { krw: '1000000', usd: '0' },
    marketValue: { amount: { krw: '1100000', usd: '0' } },
    profitLoss: { amount: { krw: '100000', usd: '0' }, rate: '0.1' },
    dailyProfitLoss: { amount: { krw: '5000', usd: '0' }, rate: '0.005' },
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

  // 2. String fields are normalized to numbers (KRW account)
  it('normalizes nested summary fields to numbers (KRW account)', async () => {
    const client = fakeClient();
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.summary.currency).toBe('KRW');
    expect(result.summary.purchaseAmount).toBe(1_000_000);
    expect(result.summary.marketValue).toBe(1_100_000);
    expect(result.summary.profitLoss).toBe(100_000);
    expect(result.summary.profitRate).toBeCloseTo(0.1);
    expect(result.summary.dailyProfitLoss).toBe(5_000);
    expect(result.summary.dailyRate).toBeCloseTo(0.005);
  });

  // 2b. USD account: every krw field is "0" → summary switches to the usd figures
  it('falls back to USD summary figures when all krw fields are zero (US account)', async () => {
    const client = fakeClient([42], makeHoldings({
      totalPurchaseAmount: { krw: '0', usd: '11214.246' },
      marketValue: { amount: { krw: '0', usd: '11174.47' } },
      profitLoss: { amount: { krw: '0', usd: '-39.776' }, rate: '-0.0008' },
      dailyProfitLoss: { amount: { krw: '0', usd: '158.32' }, rate: '0.0141' },
    }));
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.summary.currency).toBe('USD');
    expect(result.summary.purchaseAmount).toBeCloseTo(11_214.246);
    expect(result.summary.marketValue).toBeCloseTo(11_174.47);
    expect(result.summary.profitLoss).toBeCloseTo(-39.776);
    expect(result.summary.dailyProfitLoss).toBeCloseTo(158.32);
    expect(result.summary.dailyRate).toBeCloseTo(0.0141);
  });

  it('normalizes item fields to numbers (nested money objects)', async () => {
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
    expect(item.currency).toBe('KRW');
  });

  // 3. returnPct prefers the Toss-reported rate
  it('uses the Toss-reported profitLoss.rate as returnPct', async () => {
    const client = fakeClient([42], makeHoldings({
      items: [makeItem({ profitLoss: { amount: '6.16', rate: '0.0028' } })],
    }));
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.items[0]?.returnPct).toBeCloseTo(0.0028);
  });

  it('falls back to profitLoss/purchaseAmount when rate is absent', async () => {
    const client = fakeClient([42], makeHoldings({
      items: [makeItem({
        marketValue: { purchaseAmount: '1000000', amount: '1050000' },
        profitLoss: { amount: '50000' },   // no rate
      })],
    }));
    const svc = new AccountService({ client, now: () => 0, ttlMs: 60_000 });
    const result = await svc.holdings();

    expect(result.items[0]?.returnPct).toBeCloseTo(0.05);
  });

  it('falls back to avgPrice*quantity as cost basis when purchaseAmount is absent', async () => {
    const client = fakeClient([42], makeHoldings({
      items: [makeItem({
        averagePurchasePrice: '100000', quantity: '10',
        marketValue: { amount: '1050000' },      // no purchaseAmount
        profitLoss: { amount: '50000' },          // no rate
      })],
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
