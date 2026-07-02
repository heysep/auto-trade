import { describe, it, expect, vi, afterEach } from 'vitest';
import { TossApiClient } from './TossApiClient.js';
import { RateLimitError } from './http.js';
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

  // ---------------------------------------------------------------------------
  // Pagination tests (count > 200)
  // ---------------------------------------------------------------------------

  /** Build N minimal TossCandle objects with sequential daily timestamps. */
  function makeCandles(n: number, baseMs: number): TossCandle[] {
    return Array.from({ length: n }, (_, i) => ({
      timestamp: new Date(baseMs + i * 86_400_000).toISOString(),
      openPrice: '1000',
      highPrice: '1100',
      lowPrice: '900',
      closePrice: '1050',
    }));
  }

  it('count=260 fires two requests and returns 260 bars sorted ascending', async () => {
    const client = new TossApiClient(fakeTokens);
    const DAY = 86_400_000;
    const BASE = Date.UTC(2025, 0, 1); // 2025-01-01
    const CURSOR = '2025-01-01T00:00:00.000Z';

    // Page 1: 200 newer bars (days 61..260); page 2: 60 older bars (days 1..60).
    const page1Candles = makeCandles(200, BASE + 60 * DAY);
    const page2Candles = makeCandles(60, BASE);

    let callCount = 0;
    let page2Path = '';

    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      callCount++;
      if (callCount === 1) {
        return { candles: page1Candles, nextBefore: CURSOR };
      }
      page2Path = path;
      return { candles: page2Candles, nextBefore: null };
    };

    const result = await client.getCandles('005930', '1d', 260);

    expect(result).toHaveLength(260);
    expect(callCount).toBe(2);
    // Second request must carry the before= cursor.
    expect(page2Path).toContain('before=');
    // Result must be sorted ascending by timestamp.
    const timestamps = result.map((c) => Date.parse(c.timestamp));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('count=200 (default) fires exactly one call with no before param in the URL', async () => {
    const client = new TossApiClient(fakeTokens);
    let callCount = 0;
    let capturedPath = '';

    (client as unknown as Record<string, unknown>)['request'] = async (path: string) => {
      callCount++;
      capturedPath = path;
      return { candles: [], nextBefore: null };
    };

    await client.getCandles('005930', '1d');

    expect(callCount).toBe(1);
    expect(capturedPath).not.toContain('before=');
  });

  it('stops pagination on nextBefore: null even when fewer than count bars gathered', async () => {
    const client = new TossApiClient(fakeTokens);
    const BASE = Date.UTC(2025, 5, 1); // 2025-06-01
    const smallBatch = makeCandles(80, BASE);
    let callCount = 0;

    (client as unknown as Record<string, unknown>)['request'] = async () => {
      callCount++;
      // Returns 80 bars and null cursor — server signals no more pages.
      return { candles: smallBatch, nextBefore: null };
    };

    const result = await client.getCandles('005930', '1d', 300);

    // Must stop after one call (nextBefore: null on the very first page).
    expect(callCount).toBe(1);
    // Returns the 80 bars that were gathered, sorted ascending.
    expect(result).toHaveLength(80);
    const timestamps = result.map((c) => Date.parse(c.timestamp));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('deduplicates bars whose timestamp appears on both sides of a page boundary', async () => {

    const client = new TossApiClient(fakeTokens);
    const DAY = 86_400_000;
    const BASE = Date.UTC(2025, 0, 1);
    const CURSOR = '2025-04-11T00:00:00.000Z';

    // Page 1: 200 bars (days 1..200), nextBefore set.
    const page1Candles = makeCandles(200, BASE);
    // The last bar of page 1 — Toss may echo it at the start of page 2.
    const lastOfPage1 = page1Candles.at(-1);
    if (lastOfPage1 === undefined) throw new Error('fixture empty');
    const boundaryCandle: TossCandle = { ...lastOfPage1 };

    // Page 2: boundary dupe + 59 unique bars (days 202..260) = 60 entries, 59 unique.
    const page2Extra = makeCandles(59, BASE + 201 * DAY);
    const page2Candles: TossCandle[] = [boundaryCandle, ...page2Extra];

    let callCount = 0;

    (client as unknown as Record<string, unknown>)['request'] = async () => {
      callCount++;
      if (callCount === 1) return { candles: page1Candles, nextBefore: CURSOR };
      return { candles: page2Candles, nextBefore: null };
    };

    const result = await client.getCandles('005930', '1d', 260);

    // 200 + 59 unique = 259 bars (the boundary timestamp is deduped).
    expect(result).toHaveLength(259);
    // No duplicate timestamps in the result.
    const tSet = new Set(result.map((c) => c.timestamp));
    expect(tSet.size).toBe(259);
  });
});

// ---------------------------------------------------------------------------
// 429 retry-with-backoff tests (uses real fetch path, mocks globalThis.fetch)
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for vi.stubGlobal. */
function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const headersObj = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headersObj,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

/** Candles page fixture for a successful response (wrapped in { result }). */
const successPage: TossCandlePage = {
  candles: [
    {
      timestamp: '2026-01-02T09:00:00+09:00',
      openPrice: '70000',
      highPrice: '71000',
      lowPrice: '69500',
      closePrice: '70500',
    },
  ],
  nextBefore: null,
};

describe('TossApiClient 429 retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries once on 429 and succeeds on the next attempt', async () => {
    const instantSleep = vi.fn().mockResolvedValue(undefined);
    const client = new TossApiClient(fakeTokens, { sleep: instantSleep, maxRetries: 4 });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(429, undefined, { 'retry-after': '1' });
      }
      return makeResponse(200, { result: successPage });
    });

    const result = await client.getCandles('005930', '1d', 1);

    expect(callCount).toBe(2);
    expect(instantSleep).toHaveBeenCalledTimes(1);
    // Delay should be retryAfterSec (1) * 1000 = 1000 ms
    expect(instantSleep).toHaveBeenCalledWith(1000);
    expect(result).toHaveLength(1);
  });

  it('uses exponential backoff when no Retry-After header is present', async () => {
    const instantSleep = vi.fn().mockResolvedValue(undefined);
    const client = new TossApiClient(fakeTokens, { sleep: instantSleep, maxRetries: 4 });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount <= 2) {
        // No Retry-After header — exponential backoff applies
        return makeResponse(429, undefined);
      }
      return makeResponse(200, { result: successPage });
    });

    const result = await client.getCandles('005930', '1d', 1);

    expect(callCount).toBe(3);
    expect(instantSleep).toHaveBeenCalledTimes(2);
    // attempt=1: base * 2^0 = 400ms; attempt=2: base * 2^1 = 800ms
    expect(instantSleep).toHaveBeenNthCalledWith(1, 400);
    expect(instantSleep).toHaveBeenNthCalledWith(2, 800);
    expect(result).toHaveLength(1);
  });

  it('throws RateLimitError after exhausting all retries', async () => {
    const instantSleep = vi.fn().mockResolvedValue(undefined);
    const maxRetries = 3;
    const client = new TossApiClient(fakeTokens, { sleep: instantSleep, maxRetries });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      return makeResponse(429, undefined, { 'retry-after': '2' });
    });

    await expect(client.getCandles('005930', '1d', 1)).rejects.toBeInstanceOf(RateLimitError);
    // 1 original + maxRetries retries = maxRetries+1 total calls
    expect(callCount).toBe(maxRetries + 1);
    expect(instantSleep).toHaveBeenCalledTimes(maxRetries);
  });

  it('clamps large Retry-After (e.g. 3600 s) to RETRY_DELAY_CAP_MS (≤ 30 000 ms)', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    const client = new TossApiClient(fakeTokens, { sleep, maxRetries: 4 });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(429, undefined, { 'retry-after': '3600' });
      }
      return makeResponse(200, { result: successPage });
    });

    await client.getCandles('005930', '1d', 1);

    expect(callCount).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Without cap this would be 3_600_000 ms; with cap it must be ≤ 30_000 ms.
    expect(delays[0]).toBeLessThanOrEqual(30_000);
    expect(delays[0]).toBeGreaterThan(0);
  });

  it('falls back to finite exponential backoff when Retry-After is a non-numeric HTTP date', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    const client = new TossApiClient(fakeTokens, { sleep, maxRetries: 4 });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount === 1) {
        // HTTP-date string → Number(...) = NaN
        return makeResponse(429, undefined, {
          'retry-after': 'Wed, 01 Jan 2026 00:00:00 GMT',
        });
      }
      return makeResponse(200, { result: successPage });
    });

    await client.getCandles('005930', '1d', 1);

    expect(callCount).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Before fix: sleep(NaN) is called (immediate tight retry — bad).
    // After fix: finite exponential backoff > 0.
    const delay = delays[0]!;
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThan(0);
  });

  it('does NOT retry on non-429 errors (exactly one fetch call)', async () => {
    const instantSleep = vi.fn().mockResolvedValue(undefined);
    const client = new TossApiClient(fakeTokens, { sleep: instantSleep, maxRetries: 4 });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      return makeResponse(503, undefined);
    });

    await expect(client.getCandles('005930', '1d', 1)).rejects.toThrow('503');
    expect(callCount).toBe(1);
    expect(instantSleep).not.toHaveBeenCalled();
  });
});
