import { describe, it, expect, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { FileStatePersistence } from './StatePersistence.js';
import { InMemoryRepository } from './repository.js';
import { InMemoryTradeTracker, type FillContext } from '../risk/TradeTracker.js';
import { StrategyRegistry } from '../strategy/StrategyRegistry.js';
import { TimeSeriesMomentumStrategy } from '../strategy/TimeSeriesMomentumStrategy.js';
import { StrategyDeployer } from '../app/StrategyDeployer.js';
import { StrategyEngine } from '../strategy/StrategyEngine.js';
import { WatchList } from '../market/WatchList.js';
import type { Order, Fill, Position, EquitySnapshot, Quote } from '../domain/types.js';
import type { FillEffect } from '../domain/positionAccounting.js';
import type { OrderManager } from '../order/OrderManager.js';
import type { StrategySpec } from '../strategy/strategySpec.js';

const D = Date.parse('2026-06-30T05:00:00+09:00');
const order = (id: string): Order => ({
  id, strategyId: 1, symbol: '005930', currency: 'KRW', side: 'BUY', orderType: 'MARKET',
  quantity: 10, status: 'FILLED', mode: 'PAPER', idempotencyKey: id, createdAt: 0,
});
const fill = (orderId: string): Fill => ({ orderId, quantity: 10, price: 70_000, fee: 100, tax: 0, filledAt: 0 });
const position: Position = { strategyId: 1, symbol: '005930', mode: 'PAPER', quantity: 10, avgPrice: 70_000, realizedPnl: 0 };
const snap: EquitySnapshot = { strategyId: 1, mode: 'PAPER', nav: 1_000_500, cash: 300_000, day: '2026-06-30' };

const ctx: FillContext = { strategyId: 1, symbol: '005930', mode: 'PAPER', currency: 'KRW' };
const open: FillEffect = { realizedDelta: 0, openedFromFlat: true, closedToFlat: false, positionRealizedPnl: 0 };
const close = (p: number): FillEffect => ({ realizedDelta: 0, openedFromFlat: false, closedToFlat: true, positionRealizedPnl: p });

function seeded() {
  const repo = new InMemoryRepository();
  repo.saveOrder(order('A')); repo.addFill(fill('A')); repo.upsertPosition(position); repo.saveEquitySnapshot(snap);
  const tracker = new InMemoryTradeTracker();
  tracker.onFill(ctx, open, D); tracker.onFill(ctx, close(-10), D); tracker.markDailyLoss(1, 'PAPER', 'KRW', D);
  return { repo, tracker };
}

describe('InMemoryRepository dump/restore', () => {
  it('round-trips orders, fills, positions, and equity', () => {
    const { repo } = seeded();
    const r2 = new InMemoryRepository();
    r2.restore(repo.dump());
    expect(r2.findByIdempotencyKey('A')?.id).toBe('A');
    expect(r2.getFills('A')).toHaveLength(1);
    expect(r2.getPosition(1, '005930', 'PAPER')?.quantity).toBe(10);
    expect(r2.getEquitySnapshots(1, 'PAPER')).toHaveLength(1);
    expect(r2.allOrders('PAPER')).toHaveLength(1);
  });
});

describe('InMemoryTradeTracker dump/restore', () => {
  it('round-trips streaks, daily P&L, trade history, and violation days', () => {
    const { tracker } = seeded();
    const t2 = new InMemoryTradeTracker();
    t2.restore(tracker.dump());
    expect(t2.consecutiveLosses(1, 'PAPER')).toBe(1);
    expect(t2.dailyRealizedPnl(1, 'PAPER', 'KRW', D)).toBe(-10);
    expect(t2.trades(1, 'PAPER')).toHaveLength(1);
    expect(t2.dailyLossViolationCount(1, 'PAPER')).toBe(1);
  });
});

describe('FileStatePersistence', () => {
  const FILE = join(tmpdir(), `state-test-${process.pid}.json`);
  afterEach(() => { try { rmSync(FILE); } catch { /* */ } });

  it('persists and reloads full state across a fresh repo + tracker (survives restart)', () => {
    const { repo, tracker } = seeded();
    const sp = new FileStatePersistence(FILE);
    sp.save(repo, tracker);

    const r2 = new InMemoryRepository();
    const t2 = new InMemoryTradeTracker();
    expect(sp.load(r2, t2)).toBe(true);
    expect(r2.getPosition(1, '005930', 'PAPER')?.quantity).toBe(10);
    expect(t2.consecutiveLosses(1, 'PAPER')).toBe(1);
    expect(t2.dailyLossViolationCount(1, 'PAPER')).toBe(1);
  });

  it('returns false on a missing or corrupt file (start fresh, not unsafe)', () => {
    expect(new FileStatePersistence(join(tmpdir(), 'state-nope.json')).load(new InMemoryRepository(), new InMemoryTradeTracker())).toBe(false);
    writeFileSync(FILE, 'not json');
    expect(new FileStatePersistence(FILE).load(new InMemoryRepository(), new InMemoryTradeTracker())).toBe(false);
  });

  it('THROWS on a version mismatch rather than silently discarding state', () => {
    writeFileSync(FILE, JSON.stringify({
      version: 999,
      repo: { orders: [], byIdem: [], fills: [], positions: [], equity: [] },
      tracker: { baseline: [], agg: [], history: [], violationDays: [] },
    }));
    expect(() => new FileStatePersistence(FILE).load(new InMemoryRepository(), new InMemoryTradeTracker()))
      .toThrow(/version/);
  });

  it('starts fresh (false) on a structurally invalid snapshot, restoring nothing', () => {
    writeFileSync(FILE, JSON.stringify({
      version: 1,
      repo: { orders: [{ id: 'A' }], byIdem: [], fills: [], positions: [], equity: [] },
      tracker: { baseline: [] },   // missing agg/history/violationDays
    }));
    const r = new InMemoryRepository();
    expect(new FileStatePersistence(FILE).load(r, new InMemoryTradeTracker())).toBe(false);
    expect(r.allOrders()).toHaveLength(0);   // all-or-nothing: nothing restored
  });

  it('round-trips deployed specs through save/load (deployer restore rebuilds records)', () => {
    const tsmomSpec: StrategySpec = {
      type: 'tsmom',
      params: { lookback: 20, orderNotional: 1_000_000 },
    };

    // Build a minimal engine stub
    const orderManager = { handleIntent: vi.fn() } as unknown as OrderManager;
    const engine1 = new StrategyEngine({ orderManager, getPosition: () => undefined });
    const registry1 = new StrategyRegistry();
    const watchList1 = new WatchList();
    const deployer1 = new StrategyDeployer(
      { engine: engine1, registry: registry1, watchList: watchList1, currency: 'KRW', mode: 'PAPER' },
      10,
    );
    deployer1.deploy({ symbol: '005930', spec: tsmomSpec, name: 'dyn-tsmom' });

    const sp = new FileStatePersistence(FILE);
    sp.save(new InMemoryRepository(), new InMemoryTradeTracker(), { deployer: deployer1 });

    // Load into a fresh deployer
    const engine2 = new StrategyEngine({ orderManager, getPosition: () => undefined });
    const registry2 = new StrategyRegistry();
    const watchList2 = new WatchList();
    const deployer2 = new StrategyDeployer(
      { engine: engine2, registry: registry2, watchList: watchList2, currency: 'KRW', mode: 'PAPER' },
      10,
    );
    expect(sp.load(new InMemoryRepository(), new InMemoryTradeTracker(), { deployer: deployer2 })).toBe(true);

    // The record should have been restored
    const records = deployer2.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('dyn-tsmom');
    expect(records[0]?.symbol).toBe('005930');
    expect(records[0]?.spec).toEqual(tsmomSpec);

    // Strategy should be in the registry and watchList
    expect(registry2.get(records[0]!.id)).toBeDefined();
    expect(watchList2.list()).toContainEqual({ symbol: '005930', market: 'KR' });
  });

  it('round-trips registry statuses and strategy indicator windows', () => {
    const cfg = { id: 7, symbol: 'X', currency: 'KRW' as const, mode: 'PAPER' as const, lookback: 3, orderNotional: 1000 };
    const tsmom = new TimeSeriesMomentumStrategy(cfg);
    let ts = 0;
    const q = (last: number): Quote => ({ symbol: 'X', currency: 'KRW', bid: last, ask: last, last, ts: ++ts });
    for (const p of [100, 110, 120, 130]) tsmom.evaluate({ quote: q(p), position: undefined });   // fill the window
    const reg = new StrategyRegistry();
    reg.register(tsmom, 'tsmom'); reg.setStatus(7, 'APPROVED');

    const sp = new FileStatePersistence(FILE);
    sp.save(new InMemoryRepository(), new InMemoryTradeTracker(), { registry: reg, strategies: [tsmom] });

    const tsmom2 = new TimeSeriesMomentumStrategy(cfg);
    const reg2 = new StrategyRegistry(); reg2.register(tsmom2, 'tsmom');
    expect(sp.load(new InMemoryRepository(), new InMemoryTradeTracker(), { registry: reg2, strategies: [tsmom2] })).toBe(true);
    expect(reg2.get(7)?.status).toBe('APPROVED');
    expect((tsmom2.serialize() as { prices: number[] }).prices).toEqual((tsmom.serialize() as { prices: number[] }).prices);
  });
});
