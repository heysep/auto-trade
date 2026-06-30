import type { Quote } from '../domain/types.js';

// Abstraction over "what's the current price". PaperBroker prices fills through
// this; tests inject a fake, MarketDataWorker feeds live quotes from Toss.
export interface PriceSource {
  getQuote(symbol: string): Quote | undefined;
}

/** Simple mutable in-memory quote book (used by worker + tests). */
export class QuoteBook implements PriceSource {
  private quotes = new Map<string, Quote>();
  set(q: Quote): void { this.quotes.set(q.symbol, q); }
  getQuote(symbol: string): Quote | undefined { return this.quotes.get(symbol); }
}
