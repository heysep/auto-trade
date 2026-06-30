import { describe, it, expect } from 'vitest';
import { SnapshotScheduler } from './SnapshotScheduler.js';
import { EquityRecorder } from './EquityRecorder.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { QuoteBook } from '../market/PriceSource.js';
import type { Position, Quote } from '../domain/types.js';

const D1 = Date.parse('2026-06-29T05:00:00+09:00');
const D2 = Date.parse('2026-06-30T05:00:00+09:00');

function setup() {
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  repo.upsertPosition({ strategyId: 1, symbol: '005930', mode: 'PAPER', quantity: 10, avgPrice: 70_000, realizedPnl: 0 } as Position);
  const recorder = new EquityRecorder({ repo, book, capitalFor: () => 1_000_000 });
  const scheduler = new SnapshotScheduler({ recorder, targets: () => [{ id: 1, mode: 'PAPER', currency: 'KRW' }] });
  return { repo, book, scheduler };
}
const setQuote = (book: QuoteBook) =>
  book.set({ symbol: '005930', currency: 'KRW', bid: 70_000, ask: 70_000, last: 70_000, ts: 0 } as Quote);

describe('SnapshotScheduler', () => {
  it('records one snapshot per market day, idempotent within a day', () => {
    const { repo, book, scheduler } = setup();
    setQuote(book);
    scheduler.maybeSnapshot(D1);
    scheduler.maybeSnapshot(D1);   // same day -> no new row
    scheduler.maybeSnapshot(D2);
    const snaps = repo.getEquitySnapshots(1, 'PAPER');
    expect(snaps.map((s) => s.day)).toEqual(['2026-06-29', '2026-06-30']);
  });

  it('does not advance the day marker when no quote is available, fires onSkip, retries later', () => {
    const repo = new InMemoryRepository();
    const book = new QuoteBook();
    repo.upsertPosition({ strategyId: 1, symbol: '005930', mode: 'PAPER', quantity: 10, avgPrice: 70_000, realizedPnl: 0 } as Position);
    const recorder = new EquityRecorder({ repo, book, capitalFor: () => 1_000_000 });
    const skipped: number[] = [];
    const scheduler = new SnapshotScheduler({
      recorder, targets: () => [{ id: 1, mode: 'PAPER', currency: 'KRW' }], onSkip: (t) => skipped.push(t.id),
    });

    scheduler.maybeSnapshot(D1);
    expect(repo.getEquitySnapshots(1, 'PAPER')).toHaveLength(0);   // skipped, not marked done
    expect(skipped).toEqual([1]);                                 // freeze is observable
    setQuote(book);
    scheduler.maybeSnapshot(D1);                                  // same day, now succeeds
    expect(repo.getEquitySnapshots(1, 'PAPER')).toHaveLength(1);
  });

  it('only snapshots targets of the market whose tick fired (currency gate)', () => {
    const { repo, book, scheduler } = setup();   // single KRW target
    setQuote(book);
    scheduler.maybeSnapshot(D1, 'USD');                           // a US tick -> KR target untouched
    expect(repo.getEquitySnapshots(1, 'PAPER')).toHaveLength(0);
    scheduler.maybeSnapshot(D1, 'KRW');                           // KR tick -> recorded
    expect(repo.getEquitySnapshots(1, 'PAPER')).toHaveLength(1);
  });
});
