import { describe, it, expect, vi } from 'vitest';
import { SymbolCatalog } from './SymbolCatalog.js';
import type { TossStock } from '../toss/types.js';

const stocks: TossStock[] = [
  { symbol: '005930', name: '삼성전자', market: 'KR' },
  { symbol: '000660', name: 'SK하이닉스', market: 'KR' },
  { symbol: '005380', name: '현대자동차', market: 'KR' },
  { symbol: 'AAPL', name: 'Apple Inc', market: 'US' },
  { symbol: 'MSFT', name: 'Microsoft Corp', market: 'US' },
  { symbol: 'GOOGL', name: 'Alphabet Inc Class A', market: 'US' },
];

describe('SymbolCatalog', () => {
  it('fetchStocks called once within TTL (cache hit)', async () => {
    const fetchStocks = vi.fn(async (): Promise<TossStock[]> => stocks);
    let nowMs = 1_000_000;
    const catalog = new SymbolCatalog(fetchStocks, { now: () => nowMs, ttlMs: 60_000 });

    const r1 = await catalog.search('005930');
    expect(r1).toHaveLength(1);

    nowMs += 30_000; // still within TTL
    const r2 = await catalog.search('AAPL');
    expect(r2).toHaveLength(1);

    expect(fetchStocks).toHaveBeenCalledTimes(1); // cache hit — only one fetch
  });

  it('refetches after TTL expires', async () => {
    const fetchStocks = vi.fn(async (): Promise<TossStock[]> => stocks);
    let nowMs = 1_000_000;
    const catalog = new SymbolCatalog(fetchStocks, { now: () => nowMs, ttlMs: 60_000 });

    await catalog.search('AAPL');
    expect(fetchStocks).toHaveBeenCalledTimes(1);

    nowMs += 60_000; // exactly at TTL boundary — expired
    await catalog.search('AAPL');
    expect(fetchStocks).toHaveBeenCalledTimes(2); // refetch
  });

  it('matches symbol substring case-insensitively', async () => {
    const fetchStocks = vi.fn(async (): Promise<TossStock[]> => stocks);
    const catalog = new SymbolCatalog(fetchStocks);

    const r1 = await catalog.search('005');
    expect(r1.map((s) => s.symbol)).toContain('005930');
    expect(r1.map((s) => s.symbol)).not.toContain('000660'); // 000660 has no '005'
    expect(r1.map((s) => s.symbol)).toContain('005380');

    const r2 = await catalog.search('aapl');
    expect(r2).toHaveLength(1);
    expect(r2[0]?.symbol).toBe('AAPL');
  });

  it('matches name substring case-insensitively', async () => {
    const fetchStocks = vi.fn(async (): Promise<TossStock[]> => stocks);
    const catalog = new SymbolCatalog(fetchStocks);

    const r1 = await catalog.search('삼성');
    expect(r1).toHaveLength(1);
    expect(r1[0]?.symbol).toBe('005930');

    const r2 = await catalog.search('apple');
    expect(r2).toHaveLength(1);
    expect(r2[0]?.symbol).toBe('AAPL');

    const r3 = await catalog.search('inc');
    // 'Apple Inc' and 'Alphabet Inc Class A' both match
    const symbols = r3.map((s) => s.symbol);
    expect(symbols).toContain('AAPL');
    expect(symbols).toContain('GOOGL');
  });

  it('empty/whitespace query returns up to limit items from full list', async () => {
    const fetchStocks = vi.fn(async (): Promise<TossStock[]> => stocks);
    const catalog = new SymbolCatalog(fetchStocks);

    const r1 = await catalog.search('');
    expect(r1).toHaveLength(6); // all 6 stocks (default limit 30 >= 6)

    const r2 = await catalog.search('   ');
    expect(r2).toHaveLength(6); // whitespace-only also returns full list up to limit
  });

  it('limit caps results', async () => {
    const fetchStocks = vi.fn(async (): Promise<TossStock[]> => stocks);
    const catalog = new SymbolCatalog(fetchStocks);

    const r1 = await catalog.search('', 2);
    expect(r1).toHaveLength(2);

    const r2 = await catalog.search('inc', 1);
    expect(r2).toHaveLength(1);
  });

  it('defaults: ttlMs=1h, limit=30', async () => {
    const bigList: TossStock[] = Array.from({ length: 50 }, (_, i) => ({
      symbol: `SYM${i}`,
      name: `Stock ${i}`,
      market: 'KR',
    }));
    const fetchStocks = vi.fn(async (): Promise<TossStock[]> => bigList);
    let nowMs = 0;
    const catalog = new SymbolCatalog(fetchStocks, { now: () => nowMs });

    // default limit=30 caps empty query
    const r1 = await catalog.search('');
    expect(r1).toHaveLength(30);

    // advance 59 min — still within default 1h TTL
    nowMs += 59 * 60_000;
    await catalog.search('');
    expect(fetchStocks).toHaveBeenCalledTimes(1);

    // advance 1 more minute — 60 min total, TTL expired
    nowMs += 60_000;
    await catalog.search('');
    expect(fetchStocks).toHaveBeenCalledTimes(2);
  });
});
