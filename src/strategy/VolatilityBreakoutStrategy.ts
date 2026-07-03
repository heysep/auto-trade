import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode } from '../domain/types.js';

export interface VolBreakoutConfig {
  id: number;
  /** Candidate symbol universe. Strategy.symbols exposes them all so the engine routes every tick. */
  symbols: string[];
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
   * Minimum (prevHigh - prevLow) / todayOpen to qualify as a volatile-enough symbol.
   * Symbols below this threshold are skipped all day. Default: 0.01 (1 %).
   */
  minRangePct?: number;
  /**
   * Async provider of the previous day's high/low and today's open.
   * Returning undefined means no trade today for that symbol (weekend / holiday / data unavailable).
   */
  getDailyRange: (
    symbol: string,
  ) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
}

interface SerializedState {
  dayKey: string | undefined;
  enteredToday: boolean;
  /** null when no symbol has been chosen yet today. */
  chosenSymbol: string | null;
  /** Per-symbol last-seen timestamp (dedup guard). Survives day resets. */
  lastSeenTsMap: Record<string, number>;
  /** Which symbols have had their range fetch settle today. */
  rangeReadySymbols: string[];
  /** Per-symbol eligibility (only present for symbols where rangeReady). */
  eligibleMap: Record<string, boolean>;
  /** Per-symbol entry target (only present for eligible symbols). */
  targetMap: Record<string, number>;
}

/**
 * KRX intraday VOLATILITY BREAKOUT strategy — multi-symbol scanner (Larry Williams K-breakout).
 *
 * Rule summary:
 *   For each candidate symbol independently:
 *     target = todayOpen + k * (prevHigh - prevLow)
 *
 *   ELIGIBLE today: range resolved AND floor(budget/todayOpen) >= 1 (affordable)
 *                   AND (prevHigh-prevLow)/todayOpen >= minRangePct (has volatility)
 *
 *   FIRST-BREAKOUT-WINS LOCK: the first eligible symbol whose price ≥ its target
 *   in [entryStartMin, entryEndMin] is chosen for the day; all others return null.
 *
 *   EXIT: tick for the chosen symbol at or after exitMin while holding a position.
 *
 * No intraday stop-loss — the upstream RiskManager's dailyMaxLoss circuit-breaker
 * provides the safety net.
 *
 * Async range fetch:
 *   evaluate() is synchronous (Strategy interface contract). getDailyRange is kicked off
 *   per-symbol on the symbol's first tick of the day (non-blocking, fire-and-forget).
 *   evaluate returns null for that symbol until its promise resolves.
 *
 * Timestamp deduplication is per-symbol (Map). A global guard would erroneously drop
 * legitimate ticks from symbol B when B's stream lags behind A's wall-clock time.
 */
export class VolatilityBreakoutStrategy implements Strategy {
  readonly id: number;
  readonly symbols: ReadonlySet<string>;
  readonly currency: Currency;
  readonly mode: TradingMode;

  private readonly cfg: VolBreakoutConfig;

  // ---- Per-symbol tick deduplication (not reset on day change; serialized) ----
  private lastSeenTsMap = new Map<string, number>();

  // ---- Day state (reset on KST date change) ----
  private dayKey: string | undefined = undefined;
  private enteredToday = false;
  /** Symbol chosen by the first-breakout-wins lock. Undefined until first breakout. */
  private chosenSymbol: string | undefined = undefined;

  // ---- Per-symbol range cache (reset on day change) ----
  /** Set of symbols for which getDailyRange has been called today. */
  private fetchInitiated = new Set<string>();
  /** Set of symbols whose range fetch has settled (resolved or errored). */
  private rangeReadySet = new Set<string>();
  /** Eligibility by symbol (true = passes affordability + volatility filters). */
  private eligibleMap = new Map<string, boolean>();
  /** Entry price target by symbol (only populated for eligible symbols). */
  private targetMap = new Map<string, number>();

  constructor(cfg: VolBreakoutConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.symbols = new Set(cfg.symbols);
    this.currency = cfg.currency;
    this.mode = cfg.mode;
  }

  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    const sym = quote.symbol;

    // ------------------------------------------------------------------
    // 1. Per-symbol duplicate / rewound-timestamp guard
    // ------------------------------------------------------------------
    const lastTs = this.lastSeenTsMap.get(sym) ?? -Infinity;
    if (quote.ts <= lastTs) return null;
    this.lastSeenTsMap.set(sym, quote.ts);

    // ------------------------------------------------------------------
    // 2. KST time decomposition
    // ------------------------------------------------------------------
    const kst = new Date(quote.ts + 9 * 3_600_000);
    const min = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    const dateKey = kst.toISOString().slice(0, 10);

    // ------------------------------------------------------------------
    // 3. Day boundary — reset per-day state; per-symbol ts guard persists
    // ------------------------------------------------------------------
    if (dateKey !== this.dayKey) {
      this.dayKey = dateKey;
      this.enteredToday = false;
      this.chosenSymbol = undefined;
      this.fetchInitiated.clear();
      this.rangeReadySet.clear();
      this.eligibleMap.clear();
      this.targetMap.clear();
    }

    // ------------------------------------------------------------------
    // 4. Per-symbol range fetch (fire-and-forget on first tick of the day)
    // ------------------------------------------------------------------
    if (!this.fetchInitiated.has(sym)) {
      this.fetchInitiated.add(sym);
      const fetchedDayKey = this.dayKey;
      this.cfg.getDailyRange(sym).then((range) => {
        // Guard against late-arriving fetches from a previous day
        if (this.dayKey !== fetchedDayKey) return;
        if (range === undefined) {
          this.eligibleMap.set(sym, false);
        } else {
          const prevRange = range.prevHigh - range.prevLow;
          const minRangePct = this.cfg.minRangePct ?? 0.01;
          const affordable = Math.floor(this.cfg.budget / range.todayOpen) >= 1;
          const volatile = range.todayOpen > 0 && prevRange / range.todayOpen >= minRangePct;
          const eligible = affordable && volatile;
          this.eligibleMap.set(sym, eligible);
          if (eligible) {
            this.targetMap.set(sym, range.todayOpen + this.cfg.k * prevRange);
          }
        }
        this.rangeReadySet.add(sym);
      }).catch(() => {
        if (this.dayKey !== fetchedDayKey) return;
        this.eligibleMap.set(sym, false);
        this.rangeReadySet.add(sym);
      });
    }

    // ------------------------------------------------------------------
    // 5. EXIT — takes priority; fires for any symbol holding a position
    // ------------------------------------------------------------------
    const exitMin = this.cfg.exitMin ?? 15 * 60 + 10; // 15:10 KST
    const heldQty = position?.quantity ?? 0;
    if (heldQty > 0 && min >= exitMin) {
      this.enteredToday = true;
      return {
        side: 'SELL',
        quantity: heldQty,
        orderType: 'MARKET',
        reason: 'end-of-day liquidation',
      };
    }

    // ------------------------------------------------------------------
    // 6. ENTRY — guarded by: range settled, eligibility, first-breakout lock,
    //            one-entry-per-day, window, and price breakout
    // ------------------------------------------------------------------
    if (!this.rangeReadySet.has(sym)) return null;   // still awaiting range
    if (!this.eligibleMap.get(sym)) return null;      // ineligible or holiday

    if (this.chosenSymbol !== undefined) return null; // another symbol was chosen today
    if (this.enteredToday) return null;               // belt-and-suspenders re-entry guard
    if (heldQty > 0) return null;                    // already holding (shouldn't normally occur)

    const entryStartMin = this.cfg.entryStartMin ?? 9 * 60 + 5;   // 09:05 KST
    const entryEndMin = this.cfg.entryEndMin ?? 14 * 60 + 30;     // 14:30 KST
    if (min < entryStartMin || min > entryEndMin) return null;     // outside entry window

    const target = this.targetMap.get(sym);
    if (target === undefined) return null;            // safety guard (eligible implies target set)
    if (quote.last < target) return null;             // price has not broken out yet

    const qty = Math.floor(this.cfg.budget / quote.last);
    if (qty < 1) return null;                        // budget too small (should be caught by eligibility)

    this.enteredToday = true;
    this.chosenSymbol = sym;
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
      chosenSymbol: this.chosenSymbol ?? null,
      lastSeenTsMap: Object.fromEntries(this.lastSeenTsMap),
      rangeReadySymbols: [...this.rangeReadySet],
      eligibleMap: Object.fromEntries(this.eligibleMap),
      targetMap: Object.fromEntries(this.targetMap),
    };
  }

  deserialize(state: unknown): void {
    const s = state as Partial<SerializedState>;
    if (typeof s.dayKey === 'string') this.dayKey = s.dayKey;
    if (typeof s.enteredToday === 'boolean') this.enteredToday = s.enteredToday;
    if (typeof s.chosenSymbol === 'string') this.chosenSymbol = s.chosenSymbol;
    // null means "no symbol chosen yet today" — leave chosenSymbol as undefined
    if (s.lastSeenTsMap !== null && typeof s.lastSeenTsMap === 'object') {
      for (const [k, v] of Object.entries(s.lastSeenTsMap)) {
        if (typeof v === 'number') this.lastSeenTsMap.set(k, v);
      }
    }
    if (Array.isArray(s.rangeReadySymbols)) {
      for (const sym of s.rangeReadySymbols) {
        if (typeof sym === 'string') this.rangeReadySet.add(sym);
      }
    }
    if (s.eligibleMap !== null && typeof s.eligibleMap === 'object') {
      for (const [k, v] of Object.entries(s.eligibleMap)) {
        if (typeof v === 'boolean') this.eligibleMap.set(k, v);
      }
    }
    if (s.targetMap !== null && typeof s.targetMap === 'object') {
      for (const [k, v] of Object.entries(s.targetMap)) {
        if (typeof v === 'number') this.targetMap.set(k, v);
      }
    }
    // Re-mark fetchInitiated for all symbols that have settled (avoids re-firing on restore)
    for (const sym of this.rangeReadySet) {
      this.fetchInitiated.add(sym);
    }
  }
}
