import type { Strategy } from '../strategy/Strategy.js';
import type { Currency, OrderRequest, Position } from '../domain/types.js';
import { PaperBroker } from '../broker/PaperBroker.js';
import { QuoteBook } from '../market/PriceSource.js';
import { InMemoryRepository } from '../persistence/repository.js';
import { InMemoryTradeTracker, type RoundTrip } from '../risk/TradeTracker.js';
import { analyze, type PerformanceMetrics } from '../performance/PerformanceAnalyzer.js';

export interface Bar { ts: number; price: number; }   // close-only; ts strictly increasing

export interface BacktestOptions {
  capital: number;
  currency: Currency;
  /** Synthetic half-spread charged on fills, so backtest cost ≈ live (default 10 bps). */
  spreadBps?: number;
}

/** A single fill captured for chart marker overlay (BUY/SELL pins on the candle chart). */
export interface BacktestFill {
  time: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
}

export interface BacktestResult {
  metrics: PerformanceMetrics;
  equityCurve: number[];     // capital-anchored NAV after each bar (length = bars + 1)
  trades: RoundTrip[];
  rejected: number;          // orders that couldn't fill (e.g. oversell)
  fills: BacktestFill[];     // per-fill markers for chart overlay (MARKET orders only; resting-limit fills via onQuote are not captured)
  finalPosition?: Position;  // omitted when flat
}

/**
 * Replays a strategy over a historical price series through the SAME PaperBroker that runs
 * live paper trading. To avoid look-ahead, a signal on bar i fills on bar i+1 (next-bar
 * execution), and a synthetic bid/ask spread is charged so fills aren't free of the spread
 * cost live pays. No risk gate — backtests measure raw strategy edge.
 *
 * ⚠️ `capital` is only the return DENOMINATOR; there is no buying-power cap, so a strategy
 * may deploy more than `capital` and overstate returns relative to deployed cash.
 */
export class BacktestEngine {
  async run(strategy: Strategy, bars: Bar[], opts: BacktestOptions): Promise<BacktestResult> {
    if (strategy.symbols.size !== 1) throw new Error('backtest supports single-symbol strategies');
    const symbol = [...strategy.symbols][0]!;
    validateBars(bars);

    const repo = new InMemoryRepository();
    const book = new QuoteBook();
    const tracker = new InMemoryTradeTracker();
    let now = 0;
    const broker = new PaperBroker(repo, book, { tracker, now: () => now, maxQuoteAgeMs: Number.POSITIVE_INFINITY });
    const halfSpread = (opts.spreadBps ?? 10) / 2 / 10_000;

    const equityCurve: number[] = [opts.capital];   // day-0 baseline = allocated capital
    let pending: OrderRequest | null = null;         // intent queued on the prior bar
    let seq = 0;
    let rejected = 0;
    const fills: BacktestFill[] = [];

    for (const bar of bars) {
      now = bar.ts;
      const half = bar.price * halfSpread;
      book.set({ symbol, currency: opts.currency, bid: bar.price - half, ask: bar.price + half, last: bar.price, ts: bar.ts });
      const quote = book.getQuote(symbol)!;

      // 1) Execute the previous bar's decision at THIS bar's prices (no look-ahead).
      if (pending) {
        try {
          const result = await broker.placeOrder(pending);
          for (const f of result.fills) {
            fills.push({ time: bar.ts, side: result.order.side, price: f.price, quantity: f.quantity });
          }
        }
        catch (err) { if (/Oversell/.test(String(err))) rejected++; else throw err; }
        pending = null;
      }
      // 2) Match any resting LIMIT orders against this bar.
      broker.onQuote(quote);

      // 3) Decide on this bar's close; queue for next bar.
      const position = repo.getPosition(strategy.id, symbol, 'PAPER');
      const intent = strategy.evaluate({ quote, position });
      if (intent) {
        pending = {
          strategyId: strategy.id, symbol, currency: opts.currency,
          side: intent.side, orderType: intent.orderType, quantity: intent.quantity,
          ...(intent.limitPrice !== undefined ? { limitPrice: intent.limitPrice } : {}),
          idempotencyKey: `bt-${strategy.id}-${seq++}`,
        };
      }
      equityCurve.push(equityOf(repo, book, strategy.id, opts.capital));
    }
    // A signal on the final bar intentionally does not execute (no next bar).

    const trades = tracker.trades(strategy.id, 'PAPER');
    const finalPosition = repo.getPosition(strategy.id, symbol, 'PAPER');
    return {
      metrics: analyze(equityCurve, trades.map((t) => t.pnl)),
      equityCurve,
      trades,
      rejected,
      fills,
      ...(finalPosition && finalPosition.quantity !== 0 ? { finalPosition } : {}),
    };
  }
}

function validateBars(bars: Bar[]): void {
  let prevTs = -Infinity;
  for (const bar of bars) {
    if (!Number.isFinite(bar.price) || bar.price <= 0) throw new Error(`invalid bar price: ${bar.price}`);
    if (!(bar.ts > prevTs)) throw new Error('bar timestamps must be strictly increasing');
    prevTs = bar.ts;
  }
}

/** NAV = capital + realized + open mark-to-market, from the simulated book. */
function equityOf(repo: InMemoryRepository, book: QuoteBook, strategyId: number, capital: number): number {
  const positions = repo.getPositions(strategyId, 'PAPER');
  const realized = positions.reduce((s, p) => s + p.realizedPnl, 0);
  const unrealized = positions.reduce((s, p) => {
    const q = book.getQuote(p.symbol);
    return q ? s + p.quantity * (q.last - p.avgPrice) : s;
  }, 0);
  return capital + realized + unrealized;
}
