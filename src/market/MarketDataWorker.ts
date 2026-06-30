import type { Quote, Currency } from '../domain/types.js';
import { QuoteBook } from './PriceSource.js';
import { parseNum } from '../domain/money.js';

export type Market = 'KR' | 'US';

export interface WatchedSymbol { symbol: string; market: Market; }

// Minimal shape of GET /api/v1/prices (?symbols=A,B,C) — numbers come as strings.
export interface TossPricesResponse {
  result: Array<{ symbol: string; lastPrice: string; currency?: string; timestamp?: string }>;
}

export interface MarketDataDeps {
  /** Batched price fetch — ONE call per market keeps us under the 10/s prices limit. */
  fetchPrices: (symbols: string[]) => Promise<TossPricesResponse>;
  /** Active watch symbols (from watch_symbols), re-read each cycle. */
  getWatched: () => WatchedSymbol[];
  book: QuoteBook;
  onTick?: (q: Quote) => void | Promise<void>;
  /** Session gate; default open. Real impl parses /market-calendar regularMarket window. */
  isMarketOpen?: (market: Market) => Promise<boolean>;
  intervalMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

/**
 * Long-lived worker (NOT cron) that polls quotes and publishes PRICE_TICK.
 * Batches per market to respect the per-second rate limit; backs off on error.
 */
export class MarketDataWorker {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly isOpen: (m: Market) => Promise<boolean>;

  constructor(private readonly deps: MarketDataDeps) {
    this.intervalMs = deps.intervalMs ?? 2000;
    this.now = deps.now ?? Date.now;
    this.isOpen = deps.isMarketOpen ?? (async () => true);
  }

  /** Sleep that stop() can interrupt; timer is unref'd so it never holds the event loop. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => { this.timer = null; this.wake = null; resolve(); }, ms);
      this.timer.unref?.();
    });
  }

  /** Run one poll cycle across all markets. Returns quotes published. */
  async pollOnce(): Promise<Quote[]> {
    const watched = this.deps.getWatched();
    const byMarket = new Map<Market, string[]>();
    for (const w of watched) {
      const arr = byMarket.get(w.market) ?? [];
      arr.push(w.symbol);
      byMarket.set(w.market, arr);
    }

    const published: Quote[] = [];
    for (const [market, symbols] of byMarket) {
      if (!symbols.length) continue;
      let open: boolean;
      try {
        open = await this.isOpen(market);          // calendar fetch can fail per market
      } catch (err) {
        this.deps.onError?.(err);
        continue;                                  // skip this market, don't blank the others
      }
      if (!open) continue;
      const resp = await this.deps.fetchPrices(symbols);   // single batched call
      const currency: Currency = market === 'KR' ? 'KRW' : 'USD';
      const items = Array.isArray(resp?.result) ? resp.result : [];
      for (const item of items) {
        try {
          const last = parseNum(item.lastPrice);            // throws on bad value
          // No bid/ask from /prices — synthesize a zero-spread quote; slippage model
          // covers transaction cost. Use /orderbook for true spread when needed.
          const q: Quote = {
            symbol: item.symbol, currency, bid: last, ask: last, last, ts: this.now(),
          };
          this.deps.book.set(q);
          await this.deps.onTick?.(q);     // await so a rejecting handler can't leak
          published.push(q);
        } catch (err) {
          this.deps.onError?.(err);                         // one bad symbol can't blank the book
        }
      }
    }
    return published;
  }

  /** Start the polling loop until stop(). Errors are isolated per cycle. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.running) {
      try {
        await this.pollOnce();
        await this.sleep(this.intervalMs);
      } catch (err) {
        this.safeOnError(err);
        if (this.running) await this.sleep(this.intervalMs * 2);   // simple backoff
      }
    }
  }

  /** Stop the loop and interrupt any in-flight sleep so termination is prompt. */
  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  private safeOnError(err: unknown): void {
    try { this.deps.onError?.(err); } catch { /* never let a logger crash the loop */ }
  }
}
