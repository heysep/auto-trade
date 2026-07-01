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
  TossPriceItem, TossStock, TossCandle,
} from './types.js';

const PREFIX = '/api/v1';

export class TossApiClient {
  constructor(private readonly tokens = new TokenManager()) {}

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

    const res = await fetch(`${config.toss.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),   // never hang forever
    });
    // 429 carries rate-limit context so callers/throttles can back off (spec §6).
    if (res.status === 429) throw RateLimitError.from(res);
    if (!res.ok) throw new Error(`Toss API ${init.method ?? 'GET'} ${path} -> ${res.status}`);
    // Tolerate 204/empty (e.g. cancel) and unwrap the `{ result }` envelope.
    return unwrap(await parseBody(res)) as T;
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
  // ⚠️ confirm exact query params + response field names against live before production use
  getStocks(): Promise<TossStock[]> {
    return this.request(`${PREFIX}/stocks`);
  }
  getCandles(symbol: string, interval: string): Promise<TossCandle[]> {
    return this.request(
      `${PREFIX}/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
    );
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
