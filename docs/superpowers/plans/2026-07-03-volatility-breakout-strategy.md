# Volatility Breakout Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a KRX intraday volatility breakout (Larry Williams K-breakout) strategy class with full TDD, plus register it in `strategySpec.ts` with a backward-compatible factory extension.

**Architecture:** A pure `VolatilityBreakoutStrategy` class implementing the `Strategy` interface: sync `evaluate()` that never blocks — the async daily-range fetch is kicked off on the first tick of each trading day and cached; evaluate returns null until the range resolves. Day state resets on date-key change (KST). Serialize/deserialize persist day key, target, and entered-today flag for restart-safe mid-day recovery.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Vitest, ESM `.js` imports.

## Global Constraints

- TypeScript strict mode: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` — every array index access must be guarded with `!` or type-checked.
- ESM imports: all local imports must end in `.js` (e.g. `from './Strategy.js'`).
- `evaluate()` is synchronous per the `Strategy` interface — never await inside it, never block on async range fetch.
- KST time math: `const kst = new Date(quote.ts + 9*3600*1000); const min = kst.getUTCHours()*60 + kst.getUTCMinutes();`
- Day key: `kst.toISOString().slice(0, 10)` — string YYYY-MM-DD in KST.
- Branch: `feat/trading-ui`. All existing 375 tests must remain green.
- Report file: `/Users/im-yoseb/auto-trading/.superpowers/sdd/volbreakout-report.md`.
- Commit message (exact): `feat(strategy): volatility-breakout KRX day-trade strategy (K-breakout, EOD liquidation)`.

---

## File Map

| Status | Path | Responsibility |
|--------|------|----------------|
| Create | `src/strategy/VolatilityBreakoutStrategy.ts` | Strategy class + exported config interface |
| Create | `src/strategy/VolatilityBreakoutStrategy.test.ts` | All TDD tests (12 cases) |
| Modify | `src/strategy/strategySpec.ts` | Add `volbreakout` union arm + `deps?` param |
| Modify | `src/strategy/strategySpec.test.ts` | Add `volbreakout` build case |

---

### Task 1: Write failing tests for VolatilityBreakoutStrategy

**Files:**
- Create: `src/strategy/VolatilityBreakoutStrategy.test.ts`

**Interfaces:**
- Consumes: nothing yet (class doesn't exist — tests will fail to import)
- Produces: 12 test cases that define the exact contract VolatilityBreakoutStrategy must satisfy

- [ ] **Step 1: Create the test file**

```typescript
// src/strategy/VolatilityBreakoutStrategy.test.ts
import { describe, it, expect } from 'vitest';
import { VolatilityBreakoutStrategy } from './VolatilityBreakoutStrategy.js';
import type { Quote, Position } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Quote with an exact KST clock time. */
function makeQuote(last: number, dateStr: string, hhmm: string): Quote {
  return {
    symbol: 'A005930',
    currency: 'KRW',
    bid: last,
    ask: last,
    last,
    ts: Date.parse(`${dateStr}T${hhmm}:00+09:00`),
  };
}

/** A non-weekend KRX trading day. */
const DATE = '2026-07-03';
const NEXT_DATE = '2026-07-04'; // next trading day (for day-reset tests)

/** Fake range: target = 100 + 0.5 * (110 - 90) = 110 */
const fakeRange = async (_: string) => ({ prevHigh: 110, prevLow: 90, todayOpen: 100 });

/** Factory with sensible defaults — override individual fields via second arg. */
function makeStrategy(overrides: Partial<{
  k: number;
  budget: number;
  getDailyRange: (s: string) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
}> = {}) {
  return new VolatilityBreakoutStrategy({
    id: 1,
    symbol: 'A005930',
    currency: 'KRW',
    mode: 'PAPER',
    k: 0.5,
    budget: 100_000,
    getDailyRange: fakeRange,
    ...overrides,
  });
}

/** Minimal held position helper. */
const heldPos = (qty: number): Position => ({
  strategyId: 1,
  symbol: 'A005930',
  mode: 'PAPER',
  quantity: qty,
  avgPrice: 110,
  realizedPnl: 0,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VolatilityBreakoutStrategy', () => {
  describe('entry', () => {
    it('returns null for ticks below target inside the entry window', async () => {
      const s = makeStrategy();
      // First tick: kicks fetch
      s.evaluate({ quote: makeQuote(109, DATE, '10:00'), position: undefined });
      await Promise.resolve(); // flush microtask
      // 109 < 110 (target) → no entry
      expect(s.evaluate({ quote: makeQuote(109, DATE, '10:01'), position: undefined })).toBeNull();
    });

    it('BUYs floor(budget/price) shares on first tick at or above target inside entry window', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // price=110 → qty = floor(100_000 / 110) = 909
      const intent = s.evaluate({ quote: makeQuote(110, DATE, '10:01'), position: undefined });
      expect(intent).not.toBeNull();
      expect(intent!.side).toBe('BUY');
      expect(intent!.quantity).toBe(909);
      expect(intent!.orderType).toBe('MARKET');
      expect(intent!.reason).toBe('volatility breakout');
    });

    it('returns null on a second crossing tick (one entry per day)', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // First crossing → BUY
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Second crossing → null
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '10:02'), position: undefined });
      expect(intent).toBeNull();
    });

    it('does NOT enter before the entry window (08:50 KST < 09:05)', async () => {
      const s = makeStrategy();
      // 08:50 tick kicks fetch
      s.evaluate({ quote: makeQuote(90, DATE, '08:50'), position: undefined });
      await Promise.resolve();
      // Still 08:50 range — price above target but before window
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '08:50'), position: undefined });
      expect(intent).toBeNull();
    });

    it('does NOT enter after the entry window (14:40 KST > 14:30 default entryEndMin)', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // 14:40 is after default entryEndMin=14:30
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '14:40'), position: undefined });
      expect(intent).toBeNull();
    });

    it('does NOT enter when budget is smaller than price (qty would be 0)', async () => {
      const s = makeStrategy({ budget: 100 }); // floor(100/110) = 0
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      const intent = s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      expect(intent).toBeNull();
    });

    it('stays flat all day when getDailyRange returns undefined', async () => {
      const s = makeStrategy({ getDailyRange: async () => undefined });
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // Even far above any realistic target
      const intent = s.evaluate({ quote: makeQuote(999, DATE, '10:01'), position: undefined });
      expect(intent).toBeNull();
    });
  });

  describe('exit', () => {
    it('SELLs the full position at or after exitMin (15:10 default)', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // Enter at 10:01
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Exit at 15:11 (>= 15:10)
      const intent = s.evaluate({ quote: makeQuote(112, DATE, '15:11'), position: heldPos(909) });
      expect(intent).not.toBeNull();
      expect(intent!.side).toBe('SELL');
      expect(intent!.quantity).toBe(909);
      expect(intent!.orderType).toBe('MARKET');
      expect(intent!.reason).toBe('end-of-day liquidation');
    });

    it('does NOT re-enter after the end-of-day exit on the same day', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Trigger exit
      s.evaluate({ quote: makeQuote(112, DATE, '15:11'), position: heldPos(909) });
      // Attempt re-entry later same day (position now flat, price above target)
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '15:15'), position: undefined });
      expect(intent).toBeNull();
    });
  });

  describe('day reset', () => {
    it('resets day state on a new KST date and allows a fresh entry', async () => {
      const s = makeStrategy();
      // Day 1: enter
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });
      // Day 2: new date key — should reset
      s.evaluate({ quote: makeQuote(90, NEXT_DATE, '10:00'), position: undefined });
      await Promise.resolve();
      const intent = s.evaluate({ quote: makeQuote(115, NEXT_DATE, '10:01'), position: undefined });
      expect(intent?.side).toBe('BUY');
    });
  });

  describe('async range fetch', () => {
    it('returns null on the very first tick (fetch not yet resolved), then enters once resolved', async () => {
      let resolve!: (val: { prevHigh: number; prevLow: number; todayOpen: number }) => void;
      const p = new Promise<{ prevHigh: number; prevLow: number; todayOpen: number }>((res) => {
        resolve = res;
      });
      const s = makeStrategy({ getDailyRange: () => p });

      // First tick of the day — kicks the fetch but result not yet available
      const first = s.evaluate({ quote: makeQuote(120, DATE, '10:00'), position: undefined });
      expect(first).toBeNull();

      // Resolve the range (target = 100 + 0.5 * 20 = 110)
      resolve({ prevHigh: 110, prevLow: 90, todayOpen: 100 });
      await Promise.resolve(); // flush the .then() microtask

      // Now a tick above target should BUY
      const intent = s.evaluate({ quote: makeQuote(120, DATE, '10:01'), position: undefined });
      expect(intent?.side).toBe('BUY');
    });
  });

  describe('serialize/deserialize', () => {
    it('round-trips day key, enteredToday, and target so mid-day restarts work', async () => {
      const s = makeStrategy();
      s.evaluate({ quote: makeQuote(90, DATE, '10:00'), position: undefined });
      await Promise.resolve();
      // Enter to lock enteredToday = true
      s.evaluate({ quote: makeQuote(115, DATE, '10:01'), position: undefined });

      const state = s.serialize!();

      // Restore into a fresh instance
      const s2 = makeStrategy();
      s2.deserialize!(state);

      // Same day — must NOT allow another entry (enteredToday=true was restored)
      const intent = s2.evaluate({ quote: makeQuote(120, DATE, '10:30'), position: undefined });
      expect(intent).toBeNull();
    });
  });

  describe('duplicate / rewound timestamp guard', () => {
    it('ignores ticks with ts <= lastSeenTs', async () => {
      const s = makeStrategy();
      const q = makeQuote(90, DATE, '10:00');
      s.evaluate({ quote: q, position: undefined });
      await Promise.resolve();
      // Same ts again — must be ignored (no state advance, definitely no BUY even if above target)
      const sameTs: Quote = { ...q, last: 999 };
      expect(s.evaluate({ quote: sameTs, position: undefined })).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail as expected (import error or compile error)**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/strategy/VolatilityBreakoutStrategy.test.ts 2>&1 | head -30
```

Expected: error — `Cannot find module './VolatilityBreakoutStrategy.js'` or similar. Tests must NOT pass yet.

---

### Task 2: Implement VolatilityBreakoutStrategy

**Files:**
- Create: `src/strategy/VolatilityBreakoutStrategy.ts`

**Interfaces:**
- Consumes: `Strategy`, `OrderIntent`, `StrategyDecisionContext` from `./Strategy.js`; `Currency`, `TradingMode` from `../domain/types.js`
- Produces: `VolBreakoutConfig` (exported interface), `VolatilityBreakoutStrategy` (exported class)

- [ ] **Step 1: Write the implementation**

```typescript
// src/strategy/VolatilityBreakoutStrategy.ts
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
 * provides the safety net for catastrophic drawdowns.
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
  private rangeReady = false;               // true once the day's fetch has settled
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
      // Non-blocking: fire-and-forget, result lands in .then()
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
    // target may be undefined in the serialized state (no optional-undefined clash with exactOptionalPropertyTypes)
    if ('target' in s) {
      const t = s.target;
      this.target = typeof t === 'number' ? t : undefined;
    }
    if (typeof s.rangeReady === 'boolean') this.rangeReady = s.rangeReady;
    if (typeof s.lastSeenTs === 'number') this.lastSeenTs = s.lastSeenTs;
  }
}
```

- [ ] **Step 2: Run the targeted tests**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/strategy/VolatilityBreakoutStrategy.test.ts
```

Expected: all 12 tests pass. If any fail, diagnose and fix before continuing.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck
```

Expected: zero errors.

---

### Task 3: Register volbreakout in strategySpec.ts + update its test

**Files:**
- Modify: `src/strategy/strategySpec.ts` (lines 10-55)
- Modify: `src/strategy/strategySpec.test.ts`

**Interfaces:**
- Consumes: `VolatilityBreakoutStrategy`, `VolBreakoutConfig` from `./VolatilityBreakoutStrategy.js`
- Produces: extended `StrategySpec` union; extended `buildStrategy` signature with optional `deps?` param

- [ ] **Step 1: Write the failing volbreakout test case in strategySpec.test.ts**

Append this `it` block inside the existing `describe('buildStrategy', ...)` block in `src/strategy/strategySpec.test.ts`:

```typescript
  it('builds a volbreakout strategy that returns null when range not yet resolved', async () => {
    let resolve!: (val: { prevHigh: number; prevLow: number; todayOpen: number }) => void;
    const p = new Promise<{ prevHigh: number; prevLow: number; todayOpen: number }>((res) => {
      resolve = res;
    });
    const s = buildStrategy(4, 'A005930', 'KRW', 'PAPER',
      { type: 'volbreakout', params: { k: 0.5, budget: 100_000 } },
      { getDailyRange: () => p },
    );
    expect(s.symbols.has('A005930')).toBe(true);
    // First tick: range not yet resolved → null
    const ts = Date.parse('2026-07-03T10:00:00+09:00');
    const quote = { symbol: 'A005930', currency: 'KRW' as const, bid: 120, ask: 120, last: 120, ts };
    expect(s.evaluate({ quote, position: undefined })).toBeNull();
    resolve({ prevHigh: 110, prevLow: 90, todayOpen: 100 });
    await Promise.resolve();
    // Now above target (110) → BUY
    const quote2 = { ...quote, ts: ts + 60_000 };
    expect(s.evaluate({ quote: quote2, position: undefined })?.side).toBe('BUY');
  });
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/strategy/strategySpec.test.ts 2>&1 | head -30
```

Expected: type error or runtime error — `volbreakout` not yet in `StrategySpec`.

- [ ] **Step 3: Update strategySpec.ts**

Replace the entire file content:

```typescript
// src/strategy/strategySpec.ts
import type { Currency, TradingMode } from '../domain/types.js';
import type { Strategy } from './Strategy.js';
import { TimeSeriesMomentumStrategy } from './TimeSeriesMomentumStrategy.js';
import { CompositeStrategy } from './CompositeStrategy.js';
import { VolatilityBreakoutStrategy } from './VolatilityBreakoutStrategy.js';

/**
 * Serializable strategy configuration, expressed as a discriminated union of
 * known strategy types. Composite specs recursively contain child specs.
 */
export type StrategySpec =
  | { type: 'tsmom'; params: { lookback: number; threshold?: number; orderNotional: number } }
  | { type: 'composite'; combine: 'AND' | 'OR'; a: StrategySpec; b: StrategySpec; orderNotional: number }
  | { type: 'volbreakout'; params: { k: number; budget: number } };

/** Optional I/O dependencies injectable at factory time. */
export interface BuildStrategyDeps {
  /**
   * Provider of the previous day's high/low and today's open for volatility-breakout strategies.
   * Defaults to `async () => undefined` (no data → strategy stays flat).
   */
  getDailyRange?: (
    symbol: string,
  ) => Promise<{ prevHigh: number; prevLow: number; todayOpen: number } | undefined>;
}

/**
 * Factory that builds a Strategy from a StrategySpec.
 * Composite children are built with id=0 (only the top-level id matters for the engine).
 *
 * The optional `deps` parameter carries I/O dependencies needed by certain strategy types
 * (e.g. volbreakout needs getDailyRange). Existing callers that omit `deps` are unaffected —
 * each strategy type that requires a dep falls back to a safe no-op default.
 */
export function buildStrategy(
  id: number,
  symbol: string,
  currency: Currency,
  mode: TradingMode,
  spec: StrategySpec,
  deps?: BuildStrategyDeps,
): Strategy {
  if (spec.type === 'tsmom') {
    return new TimeSeriesMomentumStrategy({
      id,
      symbol,
      currency,
      mode,
      lookback: spec.params.lookback,
      ...(spec.params.threshold !== undefined ? { threshold: spec.params.threshold } : {}),
      orderNotional: spec.params.orderNotional,
    });
  }

  if (spec.type === 'composite') {
    const a = buildStrategy(0, symbol, currency, mode, spec.a, deps);
    const b = buildStrategy(0, symbol, currency, mode, spec.b, deps);
    return new CompositeStrategy(
      {
        id,
        symbol,
        currency,
        mode,
        combine: spec.combine,
        orderNotional: spec.orderNotional,
      },
      a,
      b,
    );
  }

  if (spec.type === 'volbreakout') {
    const getDailyRange = deps?.getDailyRange ?? (async () => undefined);
    return new VolatilityBreakoutStrategy({
      id,
      symbol,
      currency,
      mode,
      k: spec.params.k,
      budget: spec.params.budget,
      getDailyRange,
    });
  }

  throw new Error(`unknown strategy spec: ${(spec as unknown as { type?: unknown }).type}`);
}
```

- [ ] **Step 4: Run the strategySpec tests**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/strategy/strategySpec.test.ts
```

Expected: 4 tests pass (3 original + 1 new volbreakout case).

- [ ] **Step 5: Run the full strategy test suite**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/strategy/VolatilityBreakoutStrategy.test.ts src/strategy/strategySpec.test.ts
```

Expected: all pass.

---

### Task 4: Gate checks, report, and commit

**Files:**
- Create: `.superpowers/sdd/volbreakout-report.md` (the report required by spec)

**Interfaces:**
- Consumes: everything built in Tasks 1–3
- Produces: commit `feat(strategy): volatility-breakout KRX day-trade strategy (K-breakout, EOD liquidation)`

- [ ] **Step 1: Run the full test suite (must be 375+ tests, all green)**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run 2>&1 | tail -10
```

Expected output contains:
```
Test Files  40 passed (40)
      Tests  XXX passed (XXX)
```
(Count increases by at least 13 from Task 1 + 1 from Task 3.)

- [ ] **Step 2: Run typecheck (must be zero errors)**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck
```

Expected: exits 0, no diagnostic output.

- [ ] **Step 3: Ensure the report directory exists and write the report**

```bash
mkdir -p /Users/im-yoseb/auto-trading/.superpowers/sdd
```

Then create `/Users/im-yoseb/auto-trading/.superpowers/sdd/volbreakout-report.md`:

```markdown
# volbreakout-report

**Status:** COMPLETE

**Commit hash:** <fill in after commit>

**Test summary:** XX tests pass (0 failed) across 40 test files including 12 VolatilityBreakoutStrategy cases + 1 strategySpec case.

**Concerns:**
- No intraday stop-loss in v1 — upstream RiskManager dailyMaxLoss is the sole drawdown circuit-breaker.
- getDailyRange error path (fetch throws) is treated as a no-data day (target=undefined, stays flat). The rejection is silently swallowed; callers should log or handle upstream.
- buildStrategy composite children receive the same deps object, so a volbreakout nested inside a composite would work, but that composition is untested.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/strategy/VolatilityBreakoutStrategy.ts src/strategy/VolatilityBreakoutStrategy.test.ts src/strategy/strategySpec.ts src/strategy/strategySpec.test.ts .superpowers/sdd/volbreakout-report.md && git commit -m "$(cat <<'EOF'
feat(strategy): volatility-breakout KRX day-trade strategy (K-breakout, EOD liquidation)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Update the report with the commit hash**

```bash
cd /Users/im-yoseb/auto-trading && git log -1 --format="%H"
```

Edit `.superpowers/sdd/volbreakout-report.md` to replace `<fill in after commit>` with the actual hash.

---

## Self-Review Against Spec

Checking each spec requirement against the tasks above:

| Requirement | Task |
|-------------|------|
| `VolBreakoutConfig` interface with all fields | Task 2 Step 1 |
| `VolatilityBreakoutStrategy implements Strategy` | Task 2 Step 1 |
| KST time math `kst.getUTCHours()*60 + kst.getUTCMinutes()` | Task 2 Step 1 |
| Day key `kst.toISOString().slice(0,10)` | Task 2 Step 1 |
| target = todayOpen + k * (prevHigh - prevLow) | Task 2 Step 1 |
| Lazy async fetch once per day, never block evaluate | Task 2 Step 1 |
| ENTRY: window + range ready + qty ≥ 1 guard | Task 2 Step 1 |
| EXIT: at exitMin force-liquidate + no re-entry guard | Task 2 Step 1 |
| No stop-loss, comment about RiskManager | Task 2 Step 1 |
| Weekend/holiday (undefined range) → stay flat | Task 2 Step 1 |
| Duplicate/rewound ts guard | Task 2 Step 1 |
| serialize/deserialize | Task 2 Step 1 |
| All 12 test cases | Task 1 |
| `StrategySpec` union arm `volbreakout` | Task 3 |
| `buildStrategy` `deps?` param, backward-compat | Task 3 |
| `strategySpec.test.ts` volbreakout build case | Task 3 |
| Full suite green | Task 4 |
| typecheck clean | Task 4 |
| Commit message exact | Task 4 |
| Report to `.superpowers/sdd/volbreakout-report.md` | Task 4 |

All requirements covered. No placeholders. Types consistent across all tasks.
