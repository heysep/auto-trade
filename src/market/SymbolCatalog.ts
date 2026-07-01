import type { TossStock } from '../toss/types.js';

const DEFAULT_TTL_MS = 60 * 60_000; // 1 hour
const DEFAULT_LIMIT = 30;

export interface SymbolCatalogOpts {
  now?: () => number;
  ttlMs?: number;
}

/**
 * Cached, searchable stock symbol catalog.
 *
 * Fetches the full stock list on first use and caches it for `ttlMs` (default 1h).
 * `search` does a case-insensitive substring match on `symbol` OR `name`.
 * An empty / whitespace-only query returns the first `limit` entries of the full list.
 */
export class SymbolCatalog {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cache: TossStock[] | null = null;
  private fetchedAt = -Infinity;

  constructor(
    private readonly fetchStocks: () => Promise<TossStock[]>,
    opts?: SymbolCatalogOpts,
  ) {
    this.now = opts?.now ?? Date.now;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  private async getAll(): Promise<TossStock[]> {
    const nowMs = this.now();
    if (this.cache !== null && nowMs - this.fetchedAt < this.ttlMs) {
      return this.cache;
    }
    const list = await this.fetchStocks();
    this.cache = list;
    this.fetchedAt = this.now();
    return list;
  }

  async search(query: string, limit = DEFAULT_LIMIT): Promise<TossStock[]> {
    const all = await this.getAll();
    const trimmed = query.trim();

    if (trimmed === '') {
      return all.slice(0, limit);
    }

    const lower = trimmed.toLowerCase();
    const results: TossStock[] = [];
    for (const stock of all) {
      if (results.length >= limit) break;
      if (
        stock.symbol.toLowerCase().includes(lower) ||
        stock.name.toLowerCase().includes(lower)
      ) {
        results.push(stock);
      }
    }
    return results;
  }
}
