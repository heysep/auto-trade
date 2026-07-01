import { describe, it, expect } from 'vitest';
import { TossApiClient } from './TossApiClient.js';
import type { TossStock, TossCandle } from './types.js';

// Stub TokenManager so no real HTTP is needed.
const fakeTokens = { getToken: async () => 'fake-token' } as never;

describe('TossApiClient.getStocks', () => {
  it('returns whatever the request helper resolves to', async () => {
    const client = new TossApiClient(fakeTokens);
    const fixture: TossStock[] = [
      { symbol: '005930', name: '삼성전자', market: 'KSE' },
      { symbol: 'AAPL', name: 'Apple Inc.', market: 'US' },
    ];
    // Monkeypatch the private request method — cast to any so TS allows it.
    (client as unknown as Record<string, unknown>)['request'] = async () => fixture;

    const result = await client.getStocks();
    expect(result).toBe(fixture);
  });
});

describe('TossApiClient.getCandles', () => {
  it('passes through the fixed array returned by request', async () => {
    const client = new TossApiClient(fakeTokens);
    const fixture: TossCandle[] = [
      { time: 1_700_000_000, open: '70000', high: '71000', low: '69500', close: '70500' },
    ];
    (client as unknown as Record<string, unknown>)['request'] = async () => fixture;

    const result = await client.getCandles('005930', '1d');
    expect(result).toBe(fixture);
  });

  it('builds a URL path that includes the encoded symbol and interval', async () => {
    const client = new TossApiClient(fakeTokens);
    let capturedPath = '';
    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      capturedPath = path;
      return [];
    };

    await client.getCandles('005930', '1d');
    expect(capturedPath).toContain('005930');
    expect(capturedPath).toContain('1d');
    expect(capturedPath).toContain('/candles');
  });

  it('percent-encodes special characters in symbol and interval', async () => {
    const client = new TossApiClient(fakeTokens);
    let capturedPath = '';
    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      capturedPath = path;
      return [];
    };

    // symbol with a slash-like char to test encoding
    await client.getCandles('BRK/B', '5m');
    expect(capturedPath).toContain(encodeURIComponent('BRK/B'));
    expect(capturedPath).toContain(encodeURIComponent('5m'));
  });
});
