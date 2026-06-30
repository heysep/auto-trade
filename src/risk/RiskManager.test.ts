import { describe, it, expect } from 'vitest';
import { RiskManager, type RiskContext } from './RiskManager.js';
import type { OrderRequest, Position } from '../domain/types.js';

const rm = new RiskManager();
const PRICE = 70_000;

const order = (o: Partial<OrderRequest> = {}): OrderRequest => ({
  strategyId: 1, symbol: '005930', currency: 'KRW', side: 'BUY',
  orderType: 'MARKET', quantity: 10, idempotencyKey: 'k', ...o,
});
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  mode: 'PAPER', status: 'PAPER_TESTING', capital: 2_000_000,
  limits: { maxPositionPct: 50, dailyMaxLoss: 100_000, maxConsecutiveLosses: 5 },
  positions: [], openOrdersForSymbol: 0, dailyRealizedPnl: 0, consecutiveLosses: 0, ...o,
});
const pos = (o: Partial<Position> = {}): Position => ({
  strategyId: 1, symbol: '005930', mode: 'PAPER', quantity: 5, avgPrice: 70_000, realizedPnl: 0, ...o,
});

describe('RiskManager', () => {
  it('allows a BUY within budget and concentration', () => {
    expect(rm.check(order(), PRICE, ctx()).allowed).toBe(true);
  });

  it('blocks a LIVE order when the strategy is not LIVE', () => {
    const d = rm.check(order(), PRICE, ctx({ mode: 'LIVE', status: 'PAPER_TESTING' }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/not LIVE/);
  });

  it('blocks a new BUY while an order is open, but still allows SELL exits', () => {
    expect(rm.check(order({ side: 'BUY' }), PRICE, ctx({ openOrdersForSymbol: 1 })).allowed).toBe(false);
    const held = ctx({ openOrdersForSymbol: 1, positions: [pos({ quantity: 10 })] });
    expect(rm.check(order({ side: 'SELL', quantity: 10 }), PRICE, held).allowed).toBe(true);
  });

  it('blocks a SELL beyond the held quantity (clean RISK_BLOCKED, not a broker error)', () => {
    const d = rm.check(order({ side: 'SELL', quantity: 10 }), PRICE, ctx({ positions: [pos({ quantity: 5 })] }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/oversell/);
  });

  it('folds unrealized loss into the daily-loss halt', () => {
    const d = rm.check(order({ side: 'BUY' }), PRICE, ctx({ dailyRealizedPnl: -60_000, unrealizedPnl: -50_000 }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/daily loss/);
  });

  it('blocks a BUY that exceeds the investment budget', () => {
    const d = rm.check(order({ quantity: 10 }), PRICE, ctx({ capital: 500_000 })); // need 700k > 500k
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/budget/);
  });

  it('blocks a BUY that exceeds the per-symbol concentration cap', () => {
    const d = rm.check(order({ quantity: 10 }), PRICE, ctx({ limits: { maxPositionPct: 10, dailyMaxLoss: 1e9, maxConsecutiveLosses: 9 } }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/max position/);
  });

  it('halts BUYs at the daily loss limit but still allows SELL exits', () => {
    expect(rm.check(order({ side: 'BUY' }), PRICE, ctx({ dailyRealizedPnl: -100_000 })).allowed).toBe(false);
    const losingHeld = ctx({ dailyRealizedPnl: -100_000, positions: [pos({ quantity: 10 })] });
    expect(rm.check(order({ side: 'SELL', quantity: 10 }), PRICE, losingHeld).allowed).toBe(true);
  });

  it('halts BUYs after consecutive losses but still allows SELL exits', () => {
    expect(rm.check(order({ side: 'BUY' }), PRICE, ctx({ consecutiveLosses: 5 })).allowed).toBe(false);
    const streakHeld = ctx({ consecutiveLosses: 5, positions: [pos({ quantity: 10 })] });
    expect(rm.check(order({ side: 'SELL', quantity: 10 }), PRICE, streakHeld).allowed).toBe(true);
  });

  it('counts existing positions against the budget', () => {
    // 800k already invested, capital 1M -> only 200k free, BUY needs 700k
    const d = rm.check(order({ quantity: 10 }), PRICE, ctx({
      capital: 1_000_000, positions: [pos({ quantity: 800_000 / 70_000, avgPrice: 70_000 })],
    }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/budget/);
  });
});
