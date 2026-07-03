// The ONLY module that talks to the Toss Open API directly (design principle #1).
// Everything above it (LiveBroker, MarketDataWorker) depends on this, not on fetch.
//
// Paths confirmed via live probe (docs/toss-api-spec.md §8, 2026-06-30): /api/v1.
// `account` args are the accountSeq (integer-as-string) from GET /api/v1/accounts —
// NOT accountNo (accountNo => 404 edge-blocked).

import { config } from '../config/env.js';
import { TokenManager } from './TokenManager.js';
import { REQUEST_TIMEOUT_MS, RateLimitError, parseBody, unwrap } from './http.js';
import type {
  OrderCreateRequest, TossOrderCreateResponse, TossOrder, TossOrdersList, TossMarketCalendar,
  TossPriceItem, TossStock, TossCandle, TossCandlePage,
} from './types.js';

const PREFIX = '/api/v1';

const DEFAULT_MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 400;
const RETRY_DELAY_CAP_MS = 30_000;

export class TossApiClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(
    private readonly tokens = new TokenManager(),
    opts: { sleep?: (ms: number) => Promise<void>; maxRetries?: number } = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    account?: string,
  ): Promise<T> {
    const token = await this.tokens.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (account) headers['X-Tossinvest-Account'] = account;

    let lastRateLimitError: RateLimitError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Back off before retrying: use Retry-After if provided and finite (guards NaN
        // from HTTP-date strings like "Wed, 01 Jan 2026 00:00:00 GMT"), else exponential
        // backoff. Cap to RETRY_DELAY_CAP_MS so a large Retry-After (e.g. 3600 s) cannot
        // stall the sequential universe build for hours.
        const ra = lastRateLimitError?.retryAfterSec;
        const base = (ra !== undefined && Number.isFinite(ra))
          ? ra * 1000
          : BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        const delayMs = Math.min(base, RETRY_DELAY_CAP_MS);
        await this.sleep(delayMs);
      }

      const res = await fetch(`${config.toss.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),   // never hang forever
      });

      if (res.status === 429) {
        // 429 carries rate-limit context so callers/throttles can back off (spec §6).
        lastRateLimitError = RateLimitError.from(res);
        continue;
      }
      if (!res.ok) throw new Error(`Toss API ${init.method ?? 'GET'} ${path} -> ${res.status}`);
      // Tolerate 204/empty (e.g. cancel) and unwrap the `{ result }` envelope.
      return unwrap(await parseBody(res)) as T;
    }

    // Exhausted all retries — rethrow the last rate-limit error.
    throw lastRateLimitError!;
  }

  // --- reads ---
  getAccounts(): Promise<unknown> {
    return this.request(`${PREFIX}/accounts`);
  }
  getHoldings(account: string): Promise<unknown> {
    return this.request(`${PREFIX}/holdings`, {}, account);
  }
  getPrices(symbols: string[]): Promise<TossPriceItem[]> {
    // Batch confirmed: ?symbols=A,B,C. NOTE: unwrap() strips the {result} envelope, and
    // for /prices the inner value is a bare ARRAY — so this resolves to TossPriceItem[].
    const q = symbols.map((s) => encodeURIComponent(s)).join(',');
    return this.request(`${PREFIX}/prices?symbols=${q}`);
  }
  getOrders(account: string, status: 'OPEN' | 'CLOSED' = 'OPEN'): Promise<TossOrdersList> {
    return this.request(`${PREFIX}/orders?status=${status}`, {}, account);
  }
  getOrder(account: string, orderId: string): Promise<TossOrder> {
    return this.request(`${PREFIX}/orders/${encodeURIComponent(orderId)}`, {}, account);
  }
  getMarketCalendar(market: 'KR' | 'US'): Promise<TossMarketCalendar> {
    return this.request(`${PREFIX}/market-calendar/${market}`);
  }
  // Confirmed via openapi.json 2026-07. `symbols` is REQUIRED (comma-separated, max 200).
  // sharesOutstanding arrives as a string from the API; parse to number, omit if absent/NaN.
  async getStocks(symbols: string[]): Promise<TossStock[]> {
    // Use a local raw type: sharesOutstanding comes as a string from the Toss API.
    type RawTossStock = Omit<TossStock, 'sharesOutstanding'> & { sharesOutstanding?: string };
    const raw = await this.request<RawTossStock[]>(
      `${PREFIX}/stocks?symbols=${symbols.map(encodeURIComponent).join(',')}`,
    );
    return raw.map((item) => {
      const sharesRaw = item.sharesOutstanding;
      const shares = sharesRaw !== undefined ? Number(sharesRaw) : NaN;
      return {
        symbol: item.symbol,
        name: item.name,
        market: item.market,
        ...(item.englishName !== undefined ? { englishName: item.englishName } : {}),
        ...(item.currency !== undefined ? { currency: item.currency } : {}),
        ...(Number.isFinite(shares) ? { sharesOutstanding: shares } : {}),
      };
    });
  }
  // Confirmed via openapi.json 2026-07. interval enum: '1m' | '1d'. count default 100, max 200.
  // Paginates backward when count > 200 (Toss hard-caps each call at 200 bars).
  async getCandles(symbol: string, interval: '1m' | '1d', count = 200): Promise<TossCandle[]> {
    // Fast path: single call when count ≤ 200 (preserves existing behaviour; no `before` param).
    if (count <= 200) {
      const page = await this.request<TossCandlePage>(
        `${PREFIX}/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&count=${count}&adjusted=true`,
      );
      return page.candles ?? [];
    }

    // Paginate backward for counts that exceed the per-call maximum of 200 bars.
    // Use a Map keyed by timestamp to deduplicate boundary bars that appear on two pages.
    const accumulated = new Map<string, TossCandle>();
    const maxPages = Math.ceil(count / 200) + 2; // safety cap
    let before: string | undefined;

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const remaining = count - accumulated.size;
      const fetchCount = Math.min(200, remaining);
      const beforeParam = before !== undefined ? `&before=${encodeURIComponent(before)}` : '';
      const url =
        `${PREFIX}/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
        `&count=${fetchCount}&adjusted=true${beforeParam}`;

      const resp = await this.request<TossCandlePage>(url);
      const candles = resp.candles ?? [];

      if (candles.length === 0) break;

      for (const candle of candles) {
        accumulated.set(candle.timestamp, candle);
      }

      if (accumulated.size >= count) break;

      // Determine cursor for the next (older) page.
      if (typeof resp.nextBefore === 'string') {
        before = resp.nextBefore; // explicit cursor from Toss
      } else if (resp.nextBefore === null) {
        break; // Toss explicitly signals no more pages
      } else {
        // nextBefore absent (undefined) — fall back to the oldest timestamp in this batch.
        let oldestTs: string | undefined;
        let oldestMs = Infinity;
        for (const candle of candles) {
          const ms = Date.parse(candle.timestamp);
          if (ms < oldestMs) {
            oldestMs = ms;
            oldestTs = candle.timestamp;
          }
        }
        if (oldestTs === undefined) break;
        before = oldestTs;
      }
    }

    // Sort ascending (oldest first), then keep only the newest `count` bars.
    const sorted = [...accumulated.values()].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    return sorted.slice(-count);
  }

  // --- writes (used by LiveBroker only) ---
  placeOrder(account: string, order: OrderCreateRequest): Promise<TossOrderCreateResponse> {
    return this.request(`${PREFIX}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    }, account);
  }
  cancelOrder(account: string, orderId: string): Promise<unknown> {
    // POST subpath, NOT DELETE. ⚠️ exact path absent from openapi.json 14-paths —
    // re-confirm against live openapi.json before enabling LiveBroker (Phase 5).
    return this.request(`${PREFIX}/orders/${orderId}/cancel`, { method: 'POST' }, account);
  }
  modifyOrder(account: string, orderId: string, patch: Partial<OrderCreateRequest>): Promise<unknown> {
    // POST subpath, NOT PATCH. ⚠️ same caveat as cancelOrder.
    return this.request(`${PREFIX}/orders/${orderId}/modify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }, account);
  }
}
