import { describe, it, expect } from 'vitest';
import { InMemoryTradeTracker, tradingDay, type FillContext } from './TradeTracker.js';
import type { FillEffect } from '../domain/positionAccounting.js';

const ctx: FillContext = { strategyId: 1, symbol: '005930', mode: 'PAPER', currency: 'KRW' };
const open = (posRealized = 0): FillEffect => ({
  realizedDelta: 0, openedFromFlat: true, closedToFlat: false, positionRealizedPnl: posRealized,
});
const partial = (): FillEffect => ({
  realizedDelta: -1, openedFromFlat: false, closedToFlat: false, positionRealizedPnl: 0,
});
const close = (posRealized: number): FillEffect => ({
  realizedDelta: 0, openedFromFlat: false, closedToFlat: true, positionRealizedPnl: posRealized,
});

const DAY_A = Date.parse('2026-06-30T05:00:00+09:00');   // KST
const DAY_B = Date.parse('2026-07-01T05:00:00+09:00');

describe('InMemoryTradeTracker', () => {
  it('records one round-trip outcome on position close, ignoring intermediate partial sells', () => {
    const t = new InMemoryTradeTracker();
    t.onFill(ctx, open(0), DAY_A);
    t.onFill(ctx, partial(), DAY_A);          // not flat yet -> no outcome
    t.onFill(ctx, close(-30), DAY_A);         // round trip closes at -30
    expect(t.consecutiveLosses(1, 'PAPER')).toBe(1);          // one round-trip loss, not 2 fills
    expect(t.dailyRealizedPnl(1, 'PAPER', 'KRW', DAY_A)).toBe(-30);
  });

  it('scores round-trip P&L via the open baseline across consecutive trips', () => {
    const t = new InMemoryTradeTracker();
    t.onFill(ctx, open(0), DAY_A);
    t.onFill(ctx, close(95), DAY_A);          // trip 1: 95 - 0 = +95 (win)
    expect(t.consecutiveLosses(1, 'PAPER')).toBe(0);
    t.onFill(ctx, open(95), DAY_A);           // baseline = cumulative 95
    t.onFill(ctx, close(65), DAY_A);          // trip 2: 65 - 95 = -30 (loss)
    expect(t.consecutiveLosses(1, 'PAPER')).toBe(1);
    expect(t.dailyRealizedPnl(1, 'PAPER', 'KRW', DAY_A)).toBe(65);   // +95 then -30
  });

  it('a win resets the loss streak; breakeven is neutral', () => {
    const t = new InMemoryTradeTracker();
    const rt = (pnl: number) => { t.onFill(ctx, open(0), DAY_A); t.onFill(ctx, close(pnl), DAY_A); };
    rt(-10); rt(-5);
    expect(t.consecutiveLosses(1, 'PAPER')).toBe(2);
    rt(0);                                     // breakeven -> unchanged
    expect(t.consecutiveLosses(1, 'PAPER')).toBe(2);
    rt(20);                                    // win -> reset
    expect(t.consecutiveLosses(1, 'PAPER')).toBe(0);
  });

  it('scopes dailyRealizedPnl to the market trading day; streak persists across days', () => {
    const t = new InMemoryTradeTracker();
    t.onFill(ctx, open(0), DAY_A);
    t.onFill(ctx, close(-40), DAY_A);
    expect(t.dailyRealizedPnl(1, 'PAPER', 'KRW', DAY_A)).toBe(-40);
    expect(t.dailyRealizedPnl(1, 'PAPER', 'KRW', DAY_B)).toBe(0);   // new day -> nothing realized yet
    expect(t.consecutiveLosses(1, 'PAPER')).toBe(1);               // streak survives the day rollover
  });

  it('uses the market timezone for the day boundary (KRW=Seoul, USD=New_York)', () => {
    // 2026-06-30T20:00:00Z = 2026-07-01 05:00 KST but still 2026-06-30 16:00 ET
    const ms = Date.parse('2026-06-30T20:00:00Z');
    expect(tradingDay(ms, 'KRW')).toBe('2026-07-01');
    expect(tradingDay(ms, 'USD')).toBe('2026-06-30');
  });
});
