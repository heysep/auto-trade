import { describe, it, expect, vi } from 'vitest';
import { MarketDataWorker } from './MarketDataWorker.js';
import { QuoteBook } from './PriceSource.js';
import type { Quote } from '../domain/types.js';

const T = 1_700_000_000_000;

describe('MarketDataWorker', () => {
  it('batches symbols per market into a single fetch and publishes quotes', async () => {
    const book = new QuoteBook();
    const fetchPrices = vi.fn(async (symbols: string[]) => ({
      result: symbols.map((s) => ({ symbol: s, lastPrice: '70000', currency: 'KRW' })),
    }));
    const ticks: Quote[] = [];
    const w = new MarketDataWorker({
      fetchPrices,
      getWatched: () => [
        { symbol: '005930', market: 'KR' },
        { symbol: '000660', market: 'KR' },
      ],
      book,
      onTick: (q) => { ticks.push(q); },
      now: () => T,
    });

    const published = await w.pollOnce();

    expect(fetchPrices).toHaveBeenCalledTimes(1);                    // one batched call
    expect(fetchPrices).toHaveBeenCalledWith(['005930', '000660']);
    expect(published).toHaveLength(2);
    expect(ticks).toHaveLength(2);
    expect(book.getQuote('005930')).toMatchObject({ currency: 'KRW', last: 70000, bid: 70000, ask: 70000 });
  });

  it('separates calls per market and skips closed markets', async () => {
    const book = new QuoteBook();
    const fetchPrices = vi.fn(async (symbols: string[]) => ({
      result: symbols.map((s) => ({ symbol: s, lastPrice: '100' })),
    }));
    const w = new MarketDataWorker({
      fetchPrices,
      getWatched: () => [
        { symbol: '005930', market: 'KR' },
        { symbol: 'AAPL', market: 'US' },
      ],
      book,
      isMarketOpen: async (m) => m === 'US',          // KR closed
      now: () => T,
    });

    const published = await w.pollOnce();
    expect(fetchPrices).toHaveBeenCalledTimes(1);     // only US
    expect(published.map((q) => q.symbol)).toEqual(['AAPL']);
    expect(book.getQuote('AAPL')!.currency).toBe('USD');
    expect(book.getQuote('005930')).toBeUndefined();
  });
});
