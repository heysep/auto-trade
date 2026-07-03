export interface WatchEntry {
  symbol: string;
  market: 'KR' | 'US';
}

/** Mutable set of watched symbols, keyed by symbol string. */
export class WatchList {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(initial?: WatchEntry[]) {
    if (initial) {
      for (const entry of initial) {
        this.entries.set(entry.symbol, entry);
      }
    }
  }

  /** Add an entry; idempotent by symbol (duplicate adds are ignored). */
  add(entry: WatchEntry): void {
    if (!this.entries.has(entry.symbol)) {
      this.entries.set(entry.symbol, entry);
    }
  }

  /** Remove entry by symbol; no-op if not present. */
  remove(symbol: string): void {
    this.entries.delete(symbol);
  }

  /** Return a snapshot of the current watch list. */
  list(): WatchEntry[] {
    return [...this.entries.values()];
  }
}
