import { describe, it, expect } from 'vitest';
import { TossApiClient } from './TossApiClient.js';
import type { TossStock, TossCandle, TossCandlePage } from './types.js';

// Stub TokenManager so no real HTTP is needed.
const fakeTokens = { getToken: async () => 'fake-token' } as never;

describe('TossApiClient.getStocks', () => {
  it('returns whatever the request helper resolves to', async () => {
    const client = new TossApiClient(fakeTokens);
    const fixture: TossStock[] = [
      { symbol: '005930', name: '삼성전자', market: 'KR' },
      { symbol: '000660', name: 'SK하이닉스', market: 'KR' },
    ];
    (client as unknown as Record<string, unknown>)['request'] = async () => fixture;

    const result = await client.getStocks(['005930', '000660']);
    expect(result).toBe(fixture);
  });

  it('builds a URL path that includes the encoded symbols query param', async () => {
    const client = new TossApiClient(fakeTokens);
    let capturedPath = '';
    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      capturedPath = path;
      return [];
    };

    await client.getStocks(['005930', '000660']);
    expect(capturedPath).toContain('/stocks');
    expect(capturedPath).toContain('symbols=');
    expect(capturedPath).toContain('005930');
    expect(capturedPath).toContain('000660');
  });

  it('percent-encodes symbols with special characters', async () => {
    const client = new TossApiClient(fakeTokens);
    let capturedPath = '';
    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      capturedPath = path;
      return [];
    };

    await client.getStocks(['BRK/B', 'AAPL']);
    expect(capturedPath).toContain(encodeURIComponent('BRK/B'));
    expect(capturedPath).toContain('AAPL');
  });
});

describe('TossApiClient.getCandles', () => {
  const candleFixture: TossCandle[] = [
    {
      timestamp: '2026-03-25T09:00:00+09:00',
      openPrice: '70000',
      highPrice: '71000',
      lowPrice: '69500',
      closePrice: '70500',
    },
  ];

  it('unwraps TossCandlePage and returns the candles array', async () => {
    const client = new TossApiClient(fakeTokens);
    const page: TossCandlePage = { candles: candleFixture, nextBefore: null };
    (client as unknown as Record<string, unknown>)['request'] = async () => page;

    const result = await client.getCandles('005930', '1d');
    expect(result).toBe(candleFixture);
  });

  it('returns [] when page.candles is missing/undefined', async () => {
    const client = new TossApiClient(fakeTokens);
    // Simulate a malformed response with no candles array
    (client as unknown as Record<string, unknown>)['request'] = async () => ({} as TossCandlePage);

    const result = await client.getCandles('005930', '1d');
    expect(result).toEqual([]);
  });

  it('builds a URL path that includes symbol, interval, count, and adjusted', async () => {
    const client = new TossApiClient(fakeTokens);
    let capturedPath = '';
    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      capturedPath = path;
      return { candles: [] };
    };

    await client.getCandles('005930', '1d');
    expect(capturedPath).toContain('/candles');
    expect(capturedPath).toContain('005930');
    expect(capturedPath).toContain('interval=1d');
    expect(capturedPath).toContain('adjusted=true');
  });

  it('percent-encodes symbol; interval passed as-is (already safe enum)', async () => {
    const client = new TossApiClient(fakeTokens);
    let capturedPath = '';
    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      capturedPath = path;
      return { candles: [] };
    };

    await client.getCandles('BRK/B', '1m');
    expect(capturedPath).toContain(encodeURIComponent('BRK/B'));
    expect(capturedPath).toContain('interval=1m');
  });
});
