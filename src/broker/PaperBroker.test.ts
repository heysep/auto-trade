import { describe, it, expect, beforeEach } from 'vitest';
import { PaperBroker } from './PaperBroker.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { InMemoryTradeTracker } from '../risk/TradeTracker.js';
import type { OrderRequest, Quote } from '../domain/types.js';

const T = 1_700_000_000_000;
const krQuote = (over: Partial<Quote> = {}): Quote => ({
  symbol: '005930', currency: 'KRW', bid: 70000, ask: 70100, last: 70050, ts: T, ...over,
});
const usQuote = (over: Partial<Quote> = {}): Quote => ({
  symbol: 'AAPL', currency: 'USD', bid: 100, ask: 100.1, last: 100.05, ts: T, ...over,
});

function make() {
  const repo = new InMemoryRepository();
  const book = new QuoteBook();
  const broker = new PaperBroker(repo, book, { now: () => T });
  return { repo, book, broker };
}

let n = 0;
const req = (o: Partial<OrderRequest>): OrderRequest => ({
  strategyId: 1, symbol: '005930', currency: 'KRW', side: 'BUY',
  orderType: 'MARKET', quantity: 10, idempotencyKey: `k${n++}`, ...o,
});

describe('PaperBroker', () => {
  beforeEach(() => { n = 0; });

  it('fills a KR market buy at the slippage-adjusted ask and opens a position', async () => {
    const { broker, book, repo } = make();
    book.set(krQuote());
    const { order, fills } = await broker.placeOrder(req({}));

    expect(order.status).toBe('FILLED');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe(70135);      // 70100 * 1.0005, rounded to won
    expect(fills[0]!.fee).toBe(105);
    expect(fills[0]!.tax).toBe(0);            // no tax on buys
    const pos = repo.getPosition(1, '005930', 'PAPER')!;
    expect(pos.quantity).toBe(10);
    expect(pos.avgPrice).toBe(70145.5);       // (70135*10 + 105) / 10, kept at basis precision
  });

  it('is idempotent: same key never double-trades', async () => {
    const { broker, book, repo } = make();
    book.set(krQuote());
    const r = req({ idempotencyKey: 'dup' });
    const a = await broker.placeOrder(r);
    const b = await broker.placeOrder(r);
    expect(b.order.id).toBe(a.order.id);
    expect(repo.getFills(a.order.id)).toHaveLength(1);
    expect(repo.getPosition(1, '005930', 'PAPER')!.quantity).toBe(10);
  });

  it('rejects fractional quantity for KR, allows it for US', async () => {
    const { broker, book } = make();
    book.set(krQuote());
    await expect(broker.placeOrder(req({ quantity: 1.5 }))).rejects.toThrow(/Invalid quantity/);
    book.set(usQuote());
    const ok = await broker.placeOrder(req({ symbol: 'AAPL', currency: 'USD', quantity: 1.5 }));
    expect(ok.order.status).toBe('FILLED');
  });

  it('rests a non-marketable LIMIT buy as PENDING with no fill or position', async () => {
    const { broker, book, repo } = make();
    book.set(krQuote());
    const { order, fills } = await broker.placeOrder(
      req({ orderType: 'LIMIT', limitPrice: 69000 }),    // below ask 70100
    );
    expect(order.status).toBe('PENDING');
    expect(fills).toHaveLength(0);
    expect(repo.getPosition(1, '005930', 'PAPER')).toBeUndefined();
    expect(await broker.getOpenOrders()).toHaveLength(1);
  });

  it('fills a marketable LIMIT buy at the slippage-adjusted touch, capped at the limit', async () => {
    const { broker, book } = make();
    book.set(krQuote());
    const { order, fills } = await broker.placeOrder(
      req({ orderType: 'LIMIT', limitPrice: 71000 }),    // >= ask 70100
    );
    expect(order.status).toBe('FILLED');
    expect(fills[0]!.price).toBe(70135);                 // 70100*1.0005, below the 71000 cap
  });

  it('fills a resting non-marketable limit once a later quote crosses it', async () => {
    const { broker, book, repo } = make();
    book.set(krQuote());                                  // ask 70100
    const { order } = await broker.placeOrder(
      req({ side: 'BUY', orderType: 'LIMIT', limitPrice: 69000 }),  // rests PENDING
    );
    expect(order.status).toBe('PENDING');

    const crossing = krQuote({ bid: 68000, ask: 68500, last: 68200 }); // ask <= 69000
    broker.onQuote(crossing);

    expect(await broker.getOpenOrders()).toHaveLength(0);
    expect(repo.getPosition(1, '005930', 'PAPER')!.quantity).toBe(10);
    expect(repo.getFills(order.id)).toHaveLength(1);
  });

  it('requires a positive limitPrice for LIMIT orders', async () => {
    const { broker, book } = make();
    book.set(krQuote());
    await expect(broker.placeOrder(req({ orderType: 'LIMIT' }))).rejects.toThrow(/limitPrice/);
  });

  it('realizes profit on a KR sell and applies sell-side tax', async () => {
    const { broker, book, repo } = make();
    book.set(krQuote());
    await broker.placeOrder(req({ side: 'BUY' }));                 // buy 10 ~70146 avg
    book.set(krQuote({ bid: 71000, ask: 71100 }));
    const { fills } = await broker.placeOrder(req({ side: 'SELL' }));

    expect(fills[0]!.tax).toBeGreaterThan(0);                     // KR sell taxed
    const pos = repo.getPosition(1, '005930', 'PAPER')!;
    expect(pos.quantity).toBe(0);
    expect(pos.avgPrice).toBe(0);
    expect(pos.realizedPnl).toBeGreaterThan(0);                  // sold higher than cost
  });

  it('does not tax US sells', async () => {
    const { broker, book } = make();
    book.set(usQuote());
    await broker.placeOrder(req({ symbol: 'AAPL', currency: 'USD', side: 'BUY', quantity: 5 }));
    book.set(usQuote({ bid: 110, ask: 110.1 }));
    const { fills } = await broker.placeOrder(
      req({ symbol: 'AAPL', currency: 'USD', side: 'SELL', quantity: 5 }),
    );
    expect(fills[0]!.tax).toBe(0);
  });

  it('blocks overselling beyond the held quantity', async () => {
    const { broker, book } = make();
    book.set(krQuote());
    await broker.placeOrder(req({ side: 'BUY', quantity: 10 }));
    await expect(broker.placeOrder(req({ side: 'SELL', quantity: 11 }))).rejects.toThrow(/Oversell/);
  });

  it('averages cost across two buys', async () => {
    const { broker, book, repo } = make();
    book.set(krQuote({ bid: 100, ask: 100, last: 100 }));
    await broker.placeOrder(req({ quantity: 10 }));               // ~100
    book.set(krQuote({ bid: 200, ask: 200, last: 200 }));
    await broker.placeOrder(req({ quantity: 10 }));               // ~200
    const pos = repo.getPosition(1, '005930', 'PAPER')!;
    expect(pos.quantity).toBe(20);
    expect(pos.avgPrice).toBeGreaterThan(149);                   // ~150 + fees/slippage
    expect(pos.avgPrice).toBeLessThan(152);
  });

  it('throws when no quote is available', async () => {
    const { broker } = make();
    await expect(broker.placeOrder(req({}))).rejects.toThrow(/No quote/);
  });

  it('records a closing round-trip loss to the tracker (feeds the risk halts)', async () => {
    const repo = new InMemoryRepository();
    const book = new QuoteBook();
    const tracker = new InMemoryTradeTracker();
    const broker = new PaperBroker(repo, book, { now: () => T, tracker });

    book.set(krQuote());
    await broker.placeOrder(req({ side: 'BUY' }));            // open ~70146
    book.set(krQuote({ bid: 60_000, ask: 60_100 }));         // price dropped
    await broker.placeOrder(req({ side: 'SELL' }));          // close at a loss

    expect(tracker.consecutiveLosses(1, 'PAPER')).toBe(1);
    expect(tracker.dailyRealizedPnl(1, 'PAPER', 'KRW', T)).toBeLessThan(0);
  });

  it('refuses fills on every path while halted', async () => {
    const repo = new InMemoryRepository();
    const book = new QuoteBook();
    let halted = false;
    const broker = new PaperBroker(repo, book, { now: () => T, isHalted: () => halted });
    book.set(krQuote());

    // resting limit placed while live
    const { order } = await broker.placeOrder(req({ side: 'BUY', orderType: 'LIMIT', limitPrice: 69_000 }));
    expect(order.status).toBe('PENDING');

    halted = true;
    await expect(broker.placeOrder(req({ side: 'BUY' }))).rejects.toThrow(/halted/);   // direct fill blocked
    broker.onQuote(krQuote({ bid: 68_000, ask: 68_500 }));                              // would cross 69k
    expect(await broker.getOpenOrders()).toHaveLength(1);                               // resting limit NOT filled
  });

  it('cancels a resting order', async () => {
    const { broker, book } = make();
    book.set(krQuote());
    const { order } = await broker.placeOrder(req({ orderType: 'LIMIT', limitPrice: 1 }));
    await broker.cancelOrder(order.id);
    expect(await broker.getOpenOrders()).toHaveLength(0);
  });
});
