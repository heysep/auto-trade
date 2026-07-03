// Read-only real Toss account holdings, with accountSeq caching (forever) and
// a short TTL (default 30 s) + in-flight dedup guard on the holdings fetch.

import type { TossApiClient } from '../toss/TossApiClient.js';

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

export interface AccountHoldingsSummary {
  /** 매입금액 (KRW) */
  purchaseAmount: number;
  /** 평가금액 (KRW) */
  marketValue: number;
  /** 평가손익 (KRW) */
  profitLoss: number;
  /** 일간손익 (KRW) */
  dailyProfitLoss: number;
}

export interface AccountHoldingsItem {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  marketValue: number;
  profitLoss: number;
  /** profitLoss / costBasis. costBasis = cost field if >0, else avgPrice*qty. */
  returnPct: number;
}

export interface AccountHoldingsView {
  summary: AccountHoldingsSummary;
  items: AccountHoldingsItem[];
}

// ---------------------------------------------------------------------------
// Deps / constructor
// ---------------------------------------------------------------------------

export interface AccountServiceDeps {
  client: Pick<TossApiClient, 'getAccounts' | 'getHoldings'>;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Holdings cache TTL in ms. Default: 30 000. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

export class AccountService {
  private readonly client: Pick<TossApiClient, 'getAccounts' | 'getHoldings'>;
  private readonly now: () => number;
  private readonly ttlMs: number;

  /** Cached forever once resolved (rate-limit awareness: 1 req/s for /accounts). */
  private accountSeqCache: number | undefined;

  private holdingsCache: AccountHoldingsView | undefined;
  private holdingsCachedAt: number | undefined;
  /** In-flight guard: concurrent callers share one pending fetch. */
  private inflight: Promise<AccountHoldingsView> | undefined;

  constructor(deps: AccountServiceDeps) {
    this.client = deps.client;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async holdings(): Promise<AccountHoldingsView> {
    const now = this.now();

    // Cache hit.
    if (
      this.holdingsCache !== undefined &&
      this.holdingsCachedAt !== undefined &&
      now - this.holdingsCachedAt < this.ttlMs
    ) {
      return this.holdingsCache;
    }

    // Join an in-flight fetch (thundering-herd guard).
    if (this.inflight !== undefined) return this.inflight;

    // Start a new fetch; store the promise synchronously.
    this.inflight = this.fetchHoldings();
    try {
      const result = await this.inflight;
      this.holdingsCache = result;
      this.holdingsCachedAt = this.now();
      return result;
    } finally {
      this.inflight = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveAccountSeq(): Promise<number> {
    if (this.accountSeqCache !== undefined) return this.accountSeqCache;

    const accounts = await this.client.getAccounts();
    const first = accounts[0];

    if (first === undefined || typeof first.accountSeq !== 'number') {
      throw new Error('no usable account returned from Toss API');
    }
    this.accountSeqCache = first.accountSeq;
    return this.accountSeqCache;
  }

  private async fetchHoldings(): Promise<AccountHoldingsView> {
    const seq = await this.resolveAccountSeq();
    const raw = await this.client.getHoldings(String(seq));

    /** Parse a string to a finite number; return 0 on NaN/Infinity. */
    const toNum = (s: string): number => {
      const v = Number(s);
      return Number.isFinite(v) ? v : 0;
    };

    const summary: AccountHoldingsSummary = {
      purchaseAmount: toNum(raw.totalPurchaseAmount.krw),
      marketValue: toNum(raw.marketValue.krw),
      profitLoss: toNum(raw.profitLoss.krw),
      dailyProfitLoss: toNum(raw.dailyProfitLoss.krw),
    };

    const items: AccountHoldingsItem[] = [];

    for (const item of raw.items) {
      const quantity = Number(item.quantity);
      const avgPrice = Number(item.averagePurchasePrice);
      const lastPrice = Number(item.lastPrice);

      // Skip items where essential display fields cannot be parsed.
      if (!Number.isFinite(quantity) || !Number.isFinite(avgPrice) || !Number.isFinite(lastPrice)) {
        continue;
      }

      const marketValue = toNum(item.marketValue);
      const profitLoss = toNum(item.profitLoss);
      const cost = Number(item.cost);

      // cost field → avgPrice*qty fallback when cost is missing/zero.
      const costBasis = Number.isFinite(cost) && cost > 0 ? cost : avgPrice * quantity;
      const returnPct = costBasis > 0 ? profitLoss / costBasis : 0;

      items.push({
        symbol: item.symbol,
        name: item.name,
        quantity,
        avgPrice,
        lastPrice,
        marketValue,
        profitLoss,
        returnPct,
      });
    }

    return { summary, items };
  }
}
