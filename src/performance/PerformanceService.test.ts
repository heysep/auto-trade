import { describe, it, expect } from 'vitest';
import { EquityRecorder } from './EquityRecorder.js';
import { PerformanceService } from './PerformanceService.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryTradeTracker, type FillContext } from '../risk/TradeTracker.js';
import { evaluatePromotion } from '../strategy/PromotionGate.js';
import type { Position, Quote, EquitySnapshot } from '../domain/types.js';
import type { FillEffect } from '../domain/positionAccounting.js';

const D1 = Date.parse('2026-06-29T05:00:00+09:00');
const D2 = Date.parse('2026-06-30T05:00:00+09:00');
const CAPITAL = 1_000_000;

describe('EquityRecorder', () => {
  it('computes NAV = capital + realized + unrealized and tags the market day', () => {
    const repo = new InMemoryRepository();
    const book = new QuoteBook();
    book.set({ symbol: '005930', currency: 'KRW', bid: 70_050, ask: 70_050, last: 70_050, ts: D2 } as Quote);
    repo.upsertPosition({ strategyId: 1, symbol: '005930', mode: 'PAPER', quantity: 10, avgPrice: 70_000, realizedPnl: 0 } as Position);

    const rec = new EquityRecorder({ repo, book, capitalFor: () => CAPITAL, now: () => D2 });
    const snap = rec.snapshot(1, 'PAPER', 'KRW');
    expect(snap).not.toBeNull();
    expect(snap!.nav).toBe(1_000_500);       // 1,000,000 + 0 + 10*(70050-70000)
    expect(snap!.cash).toBe(300_000);
    expect(snap!.day).toBe('2026-06-30');
  });

  it('refuses to record (returns null) when an open position has no quote', () => {
    const repo = new InMemoryRepository();
    const book = new QuoteBook();   // no quote set
    repo.upsertPosition({ strategyId: 1, symbol: '005930', mode: 'PAPER', quantity: 10, avgPrice: 70_000, realizedPnl: 0 } as Position);
    const rec = new EquityRecorder({ repo, book, capitalFor: () => CAPITAL, now: () => D2 });
    expect(rec.snapshot(1, 'PAPER', 'KRW')).toBeNull();
    expect(repo.getEquitySnapshots(1, 'PAPER')).toHaveLength(0);   // nothing persisted
  });
});

describe('PerformanceService', () => {
  it('derives PromotionInput from the equity curve (capital-anchored) + trade history', () => {
    const repo = new InMemoryRepository();
    const tracker = new InMemoryTradeTracker();
    repo.saveEquitySnapshot({ strategyId: 1, mode: 'PAPER', nav: 1_000_500, cash: 300_000, day: '2026-06-29' } as EquitySnapshot);
    repo.saveEquitySnapshot({ strategyId: 1, mode: 'PAPER', nav: 997_000, cash: 997_000, day: '2026-06-30' } as EquitySnapshot);

    const ctx: FillContext = { strategyId: 1, symbol: '005930', mode: 'PAPER', currency: 'KRW' };
    const open: FillEffect = { realizedDelta: 0, openedFromFlat: true, closedToFlat: false, positionRealizedPnl: 0 };
    const close = (p: number): FillEffect => ({ realizedDelta: 0, openedFromFlat: false, closedToFlat: true, positionRealizedPnl: p });
    tracker.onFill(ctx, open, D1); tracker.onFill(ctx, close(50), D1);      // win
    tracker.onFill(ctx, open, D2); tracker.onFill(ctx, close(-30), D2);     // loss
    tracker.markDailyLoss(1, 'PAPER', 'KRW', D2);                           // a breach day

    const input = new PerformanceService(repo, tracker, () => CAPITAL).promotionInput(1, 'PAPER');
    expect(input.navSnapshotCount).toBe(2);
    expect(input.paperDays).toBe(1);                       // calendar span 06-29 -> 06-30
    expect(input.metrics.tradeCount).toBe(2);
    expect(input.metrics.winRate).toBeCloseTo(0.5);
    expect(input.metrics.maxDrawdown).toBeLessThan(0);     // capital 1,000,000 -> 997,000
    expect(input.dailyLossViolations).toBe(1);             // real breach, not hardcoded 0
    expect(evaluatePromotion(input).eligible).toBe(false); // thin data + a violation
  });
});
