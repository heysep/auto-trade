import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode } from '../domain/types.js';

export interface VolBreakoutConfig {
  id: number;
  symbol: string;
  currency: Currency;
  mode: TradingMode;
  /** Breakout multiplier — e.g. 0.5 means target = todayOpen + 0.5 * prevRange */
  k: number;
  /** Total notional budget per day in base currency (KRW). */
  budget: number;
  /** First minute-of-day (KST) to consider entries. Default: 9*60+5 = 545 (09:05). */
  entryStartMin?: number;
  /** Last minute-of-day (KST) that may trigger a fresh entry. Default: 14*60+30 = 870 (14:30). */
  entryEndMin?: number;
  /**
   * Minute-of-day (KST) at or after which any open position is force-liquidated.
   * Default: 15*60+10 = 910 (15:10). Must be before the 15:19 close-auction cutoff.
   */
  exitMin?: number;
  /**
   * Async provider of the previous day's high/low and today's open.
   * Returning undefined means no trade today (weekend / holiday / data unavailable).
   */
  getDailyRange: (
    symbol: string,
  ) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
}

interface SerializedState {
  dayKey: string | undefined;
  enteredToday: boolean;
  target: number | undefined;
  rangeReady: boolean;
  lastSeenTs: number;
}

/**
 * KRX intraday VOLATILITY BREAKOUT strategy (Larry Williams K-breakout).
 *
 * Rule summary:
 *   target = todayOpen + k * (prevHigh - prevLow)
 *   ENTRY  : first tick of the day in [entryStartMin, entryEndMin] where price >= target
 *   EXIT   : any tick at or after exitMin where position.quantity > 0
 *
 * No intraday stop-loss in v1 — the upstream RiskManager's dailyMaxLoss circuit-breaker
 * provides the safety net for catastrophic intraday drawdowns.
 *
 * Async range fetch:
 *   evaluate() is synchronous (Strategy interface contract). The getDailyRange promise is kicked
 *   off on the first tick of each trading day; evaluate returns null until the promise resolves
 *   (cached into rangeReady/target). The pending promise is never awaited inside evaluate().
 */
export class VolatilityBreakoutStrategy implements Strategy {
  readonly id: number;
  readonly symbols: ReadonlySet<string>;
  readonly currency: Currency;
  readonly mode: TradingMode;

  private readonly cfg: VolBreakoutConfig;

  // ---- Tick deduplication ----
  private lastSeenTs = -Infinity;

  // ---- Day state (reset on KST date change) ----
  private dayKey: string | undefined = undefined;
  private enteredToday = false;

  // ---- Async range cache ----
  private rangeReady = false;                  // true once the day's fetch has settled
  private target: number | undefined = undefined; // undefined if range was unavailable

  constructor(cfg: VolBreakoutConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.symbols = new Set([cfg.symbol]);
    this.currency = cfg.currency;
    this.mode = cfg.mode;
  }

  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    // ------------------------------------------------------------------
    // 1. Duplicate / rewound-timestamp guard (mirrors TSMOM pattern)
    // ------------------------------------------------------------------
    if (quote.ts <= this.lastSeenTs) return null;
    this.lastSeenTs = quote.ts;

    // ------------------------------------------------------------------
    // 2. KST time decomposition
    // ------------------------------------------------------------------
    const kst = new Date(quote.ts + 9 * 3_600_000);
    const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const dateKey = kst.toISOString().slice(0, 10);

    // ------------------------------------------------------------------
    // 3. Day boundary — reset state and kick off the async range fetch
    // ------------------------------------------------------------------
    if (dateKey !== this.dayKey) {
      this.dayKey = dateKey;
      this.enteredToday = false;
      this.target = undefined;
      this.rangeReady = false;
      // Non-blocking: fire-and-forget; result lands in .then() as a microtask
      this.cfg.getDailyRange(this.cfg.symbol).then((range) => {
        if (range === undefined) {
          // Holiday / weekend / data gap — mark ready with no target so we
          // skip entry but still allow exit if somehow a position is held.
          this.target = undefined;
        } else {
          this.target = range.todayOpen + this.cfg.k * (range.prevHigh - range.prevLow);
        }
        this.rangeReady = true;
      }).catch(() => {
        // On fetch error treat as no-data day (stay flat).
        this.rangeReady = true;
        this.target = undefined;
      });
    }

    // ------------------------------------------------------------------
    // 4. EXIT — takes priority over entry; fires regardless of entry state
    // ------------------------------------------------------------------
    const exitMin = this.cfg.exitMin ?? 15 * 60 + 10; // 15:10 KST
    const heldQty = position?.quantity ?? 0;
    if (heldQty > 0 && min >= exitMin) {
      // Lock enteredToday so we cannot accidentally re-enter on a later same-day tick.
      this.enteredToday = true;
      return {
        side: 'SELL',
        quantity: heldQty,
        orderType: 'MARKET',
        reason: 'end-of-day liquidation',
      };
    }

    // ------------------------------------------------------------------
    // 5. ENTRY — guarded by window, range availability, and one-entry-per-day
    // ------------------------------------------------------------------
    if (!this.rangeReady) return null;          // still awaiting range
    if (this.target === undefined) return null; // holiday / unavailable data
    if (this.enteredToday) return null;         // already traded today
    if (heldQty > 0) return null;              // already holding (should not normally occur)

    const entryStartMin = this.cfg.entryStartMin ?? 9 * 60 + 5;   // 09:05 KST
    const entryEndMin = this.cfg.entryEndMin ?? 14 * 60 + 30;     // 14:30 KST
    if (min < entryStartMin || min > entryEndMin) return null;     // outside entry window

    if (quote.last < this.target) return null;  // price has not broken out yet

    const qty = Math.floor(this.cfg.budget / quote.last);
    if (qty < 1) return null; // budget too small to buy even one share

    this.enteredToday = true;
    return {
      side: 'BUY',
      quantity: qty,
      orderType: 'MARKET',
      reason: 'volatility breakout',
    };
  }

  serialize(): SerializedState {
    return {
      dayKey: this.dayKey,
      enteredToday: this.enteredToday,
      target: this.target,
      rangeReady: this.rangeReady,
      lastSeenTs: this.lastSeenTs,
    };
  }

  deserialize(state: unknown): void {
    const s = state as Partial<SerializedState>;
    if (typeof s.dayKey === 'string') this.dayKey = s.dayKey;
    if (typeof s.enteredToday === 'boolean') this.enteredToday = s.enteredToday;
    // target may be undefined in serialized state; use 'in' check to distinguish
    // "not present" from "explicitly undefined" (exactOptionalPropertyTypes safe)
    if ('target' in s) {
      const t = s.target;
      this.target = typeof t === 'number' ? t : undefined;
    }
    if (typeof s.rangeReady === 'boolean') this.rangeReady = s.rangeReady;
    if (typeof s.lastSeenTs === 'number') this.lastSeenTs = s.lastSeenTs;
  }
}
