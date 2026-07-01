# Trading UI + Strategy Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a TradingView-style UI to pick any Toss symbol, view its candle chart, compose two strategies with AND/OR, backtest with signals overlaid, and deploy to the paper pipeline.

**Architecture:** Refactor strategies to emit a position-independent `Signal` (BULLISH/BEARISH/NEUTRAL); a `CompositeStrategy` combines two signals with AND/OR; a shared `SignalToIntent` adapter turns target-direction + current position into an order (reusing existing state-targeting logic). A `StrategySpec` + factory enables dynamic creation/backtest/deploy/persistence. New Fastify endpoints back a single vanilla HTML page using TradingView `lightweight-charts`.

**Tech Stack:** TypeScript (strict), Fastify, vitest, TradingView lightweight-charts (CDN, no build).

## Global Constraints

- Node ≥ 20; strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Use the conditional-spread idiom for optional props (`...(x !== undefined ? { k: x } : {})`), never `k: undefined`.
- All existing 101 tests must stay green after each task (`npx vitest run`).
- Numbers from Toss are strings — parse with `parseNum`. Money via `roundMoney`; KR quantities integer.
- API values rendered in the browser MUST be HTML-escaped (existing `esc()` in the dashboard).
- Deploy is PAPER only. LIVE stays behind the promotion gate.
- Commit after every task. Keep files focused (one responsibility).

---

## Phase 1 — Signal model refactor (pure, no UI)

### Task 1: Signal type + SignalToIntent adapter

**Files:**
- Create: `src/strategy/signal.ts`
- Test: `src/strategy/signal.test.ts`

**Interfaces:**
- Produces: `type Signal = 'BULLISH'|'BEARISH'|'NEUTRAL'`; `signalToIntent(signal: Signal, held: number, opts: { currency: Currency; price: number; orderNotional: number }): OrderIntent | null`

- [ ] **Step 1: Write failing test** — `src/strategy/signal.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { signalToIntent } from './signal.js';

const opts = { currency: 'KRW' as const, price: 100, orderNotional: 1000 };

describe('signalToIntent', () => {
  it('BULLISH while flat -> BUY sized from notional (KR integer)', () => {
    expect(signalToIntent('BULLISH', 0, opts)).toMatchObject({ side: 'BUY', quantity: 10, orderType: 'MARKET' });
  });
  it('BEARISH while long -> SELL the whole position', () => {
    expect(signalToIntent('BEARISH', 7, opts)).toMatchObject({ side: 'SELL', quantity: 7 });
  });
  it('holds otherwise (already long & bullish, flat & bearish, neutral)', () => {
    expect(signalToIntent('BULLISH', 5, opts)).toBeNull();
    expect(signalToIntent('BEARISH', 0, opts)).toBeNull();
    expect(signalToIntent('NEUTRAL', 0, opts)).toBeNull();
    expect(signalToIntent('NEUTRAL', 5, opts)).toBeNull();
  });
  it('returns null when notional buys < 1 share', () => {
    expect(signalToIntent('BULLISH', 0, { ...opts, orderNotional: 50 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL** — `npx vitest run src/strategy/signal.test.ts` → "signalToIntent is not a function".

- [ ] **Step 3: Implement** — `src/strategy/signal.ts`

```ts
import type { Currency } from '../domain/types.js';
import type { OrderIntent } from './Strategy.js';
import { isValidQuantity } from '../domain/money.js';

export type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/** Target-direction (from a signal) + current holding -> at most one order intent. */
export function signalToIntent(
  signal: Signal,
  held: number,
  opts: { currency: Currency; price: number; orderNotional: number },
): OrderIntent | null {
  if (signal === 'BULLISH' && held === 0) {
    const raw = opts.orderNotional / opts.price;
    const qty = opts.currency === 'KRW' ? Math.floor(raw) : raw;
    if (!isValidQuantity(qty, opts.currency)) return null;
    return { side: 'BUY', quantity: qty, orderType: 'MARKET', reason: 'signal BULLISH' };
  }
  if (signal === 'BEARISH' && held > 0) {
    return { side: 'SELL', quantity: held, orderType: 'MARKET', reason: 'signal BEARISH' };
  }
  return null;
}
```

- [ ] **Step 4: Run test, verify PASS** — `npx vitest run src/strategy/signal.test.ts`.
- [ ] **Step 5: Commit** — `git add src/strategy/signal.ts src/strategy/signal.test.ts && git commit -m "feat(strategy): Signal type + signalToIntent adapter"`

### Task 2: ThresholdStrategy emits signal()

**Files:**
- Modify: `src/strategy/ThresholdStrategy.ts`
- Modify: `src/strategy/Strategy.ts` (add optional `signal?(quote): Signal`)
- Test: `src/strategy/ThresholdStrategy.test.ts` (add cases)

**Interfaces:**
- Consumes: `Signal`, `signalToIntent` (Task 1).
- Produces: `ThresholdStrategy.signal(quote): Signal`; `evaluate()` unchanged externally.

- [ ] **Step 1: Add to `Strategy.ts`** the optional method on the interface:

```ts
  // in interface Strategy:
  signal?(quote: Quote): import('./signal.js').Signal;
```

- [ ] **Step 2: Write failing test** — append to `ThresholdStrategy.test.ts`:

```ts
it('signal(): BULLISH below buyBelow, BEARISH above sellAbove, else NEUTRAL', () => {
  const s = new ThresholdStrategy({ id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', buyBelow: 90, sellAbove: 110, orderNotional: 1000 });
  expect(s.signal!({ symbol: 'X', currency: 'KRW', bid: 85, ask: 85, last: 85, ts: 1 })).toBe('BULLISH');
  expect(s.signal!({ symbol: 'X', currency: 'KRW', bid: 115, ask: 115, last: 115, ts: 2 })).toBe('BEARISH');
  expect(s.signal!({ symbol: 'X', currency: 'KRW', bid: 100, ask: 100, last: 100, ts: 3 })).toBe('NEUTRAL');
});
```

- [ ] **Step 3: Run, verify FAIL** — `npx vitest run src/strategy/ThresholdStrategy.test.ts`.

- [ ] **Step 4: Implement** — in `ThresholdStrategy.ts`, add `signal()` and rewrite `evaluate()` to use the adapter:

```ts
import type { Signal } from './signal.js';
import { signalToIntent } from './signal.js';
// ...
signal(quote: Quote): Signal {
  if (quote.last <= this.cfg.buyBelow) return 'BULLISH';
  if (quote.last >= this.cfg.sellAbove) return 'BEARISH';
  return 'NEUTRAL';
}
evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
  return signalToIntent(this.signal(quote), position?.quantity ?? 0,
    { currency: this.currency, price: quote.last, orderNotional: this.cfg.orderNotional });
}
```

(Delete the old inline evaluate body. `Quote` import already present.)

- [ ] **Step 5: Run FULL suite, verify PASS** — `npx vitest run` (existing ThresholdStrategy + backtest tests must stay green; the adapter reproduces the prior behavior).
- [ ] **Step 6: Commit** — `git commit -am "refactor(strategy): ThresholdStrategy via signal() + adapter"`

### Task 3: MovingAverageCrossStrategy emits signal()

**Files:** Modify `src/strategy/MovingAverageCrossStrategy.ts`; add test case.

**Interfaces:** Produces `MovingAverageCrossStrategy.signal(quote): Signal` (advances the price window once per new tick, `NEUTRAL` until warm). `evaluate()` becomes the adapter wrapper.

- [ ] **Step 1: Write failing test** — append to `MovingAverageCrossStrategy.test.ts`:

```ts
it('signal(): NEUTRAL until warm, then BULLISH when fast>slow', () => {
  const s = make(); // fast 2 slow 3
  let ts = 0; const q = (p: number) => ({ symbol: 'X', currency: 'KRW' as const, bid: p, ask: p, last: p, ts: ++ts });
  expect(s.signal!(q(10))).toBe('NEUTRAL');   // warming
  expect(s.signal!(q(10))).toBe('NEUTRAL');
  expect(s.signal!(q(10))).toBe('NEUTRAL');   // equal -> NEUTRAL
  expect(s.signal!(q(16))).toBe('BULLISH');   // fast 13 > slow 12
});
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — move the window-advance + fast/slow compare into `signal()`; return `'BULLISH'|'BEARISH'|'NEUTRAL'` from the `fast>slow`/`fast<slow`/equal branches. `evaluate()` becomes:

```ts
evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
  return signalToIntent(this.signal(quote), position?.quantity ?? 0,
    { currency: this.currency, price: quote.last, orderNotional: this.cfg.orderNotional });
}
```

Keep the `quote.ts <= lastSeenTs` dedup and window push inside `signal()`. NEUTRAL is returned (not null) while `prices.length < slowPeriod`.

- [ ] **Step 4: Run FULL suite, verify PASS** (existing MA + backtest + persistence tests green).
- [ ] **Step 5: Commit** — `git commit -am "refactor(strategy): MovingAverageCrossStrategy via signal() + adapter"`

### Task 4: CompositeStrategy (AND/OR)

**Files:** Create `src/strategy/CompositeStrategy.ts`; test `src/strategy/CompositeStrategy.test.ts`.

**Interfaces:**
- Consumes: `Signal`, `signalToIntent`, `Strategy` (with `signal()`).
- Produces: `class CompositeStrategy implements Strategy` with `signal()` combining two children and `evaluate()` via adapter. Constructor `(cfg: { id; symbol; currency; mode; orderNotional; combine: 'AND'|'OR' }, a: Strategy, b: Strategy)`.

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { CompositeStrategy } from './CompositeStrategy.js';
import type { Strategy } from './Strategy.js';
import type { Signal } from './signal.js';

const stub = (sig: Signal): Strategy => ({ id: 0, symbols: new Set(['X']), currency: 'KRW', mode: 'PAPER', evaluate: () => null, signal: () => sig });
const q = (last: number) => ({ symbol: 'X', currency: 'KRW' as const, bid: last, ask: last, last, ts: 1 });
const comp = (combine: 'AND' | 'OR', a: Signal, b: Signal) =>
  new CompositeStrategy({ id: 1, symbol: 'X', currency: 'KRW', mode: 'PAPER', orderNotional: 1000, combine }, stub(a), stub(b)).signal!(q(100));

describe('CompositeStrategy.signal', () => {
  it('AND: BULLISH only if both bullish; BEARISH if either bearish', () => {
    expect(comp('AND', 'BULLISH', 'BULLISH')).toBe('BULLISH');
    expect(comp('AND', 'BULLISH', 'NEUTRAL')).toBe('NEUTRAL');
    expect(comp('AND', 'BULLISH', 'BEARISH')).toBe('BEARISH');
  });
  it('OR: BULLISH if either bullish; BEARISH only if both bearish', () => {
    expect(comp('OR', 'BULLISH', 'BEARISH')).toBe('BULLISH');
    expect(comp('OR', 'NEUTRAL', 'BEARISH')).toBe('NEUTRAL');
    expect(comp('OR', 'BEARISH', 'BEARISH')).toBe('BEARISH');
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `src/strategy/CompositeStrategy.ts`:

```ts
import type { Strategy, OrderIntent, StrategyDecisionContext } from './Strategy.js';
import type { Currency, TradingMode, Quote } from '../domain/types.js';
import { type Signal, signalToIntent } from './signal.js';

export interface CompositeConfig { id: number; symbol: string; currency: Currency; mode: TradingMode; orderNotional: number; combine: 'AND' | 'OR'; }

export class CompositeStrategy implements Strategy {
  readonly id: number; readonly symbols: ReadonlySet<string>; readonly currency: Currency; readonly mode: TradingMode;
  constructor(private readonly cfg: CompositeConfig, private readonly a: Strategy, private readonly b: Strategy) {
    this.id = cfg.id; this.symbols = new Set([cfg.symbol]); this.currency = cfg.currency; this.mode = cfg.mode;
  }
  signal(quote: Quote): Signal {
    const sa = this.a.signal!(quote), sb = this.b.signal!(quote);
    if (this.cfg.combine === 'AND') {
      if (sa === 'BEARISH' || sb === 'BEARISH') return 'BEARISH';
      return sa === 'BULLISH' && sb === 'BULLISH' ? 'BULLISH' : 'NEUTRAL';
    }
    if (sa === 'BULLISH' || sb === 'BULLISH') return 'BULLISH';
    return sa === 'BEARISH' && sb === 'BEARISH' ? 'BEARISH' : 'NEUTRAL';
  }
  evaluate({ quote, position }: StrategyDecisionContext): OrderIntent | null {
    return signalToIntent(this.signal(quote), position?.quantity ?? 0,
      { currency: this.currency, price: quote.last, orderNotional: this.cfg.orderNotional });
  }
  serialize(): unknown { return { a: this.a.serialize?.(), b: this.b.serialize?.() }; }
  deserialize(state: unknown): void {
    const s = state as { a?: unknown; b?: unknown };
    if (s?.a !== undefined) this.a.deserialize?.(s.a);
    if (s?.b !== undefined) this.b.deserialize?.(s.b);
  }
}
```

- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy): CompositeStrategy AND/OR signal combiner"`

### Task 5: StrategySpec + buildStrategy factory

**Files:** Create `src/strategy/strategySpec.ts`; test `src/strategy/strategySpec.test.ts`.

**Interfaces:**
- Produces: `type StrategySpec` (threshold|sma|composite); `buildStrategy(id, symbol, currency, mode, spec): Strategy`. Composite children get id `0` (only the top-level id matters for the engine).

- [ ] **Step 1: Write failing test** covering each type, a nested composite, and an invalid spec:

```ts
import { describe, it, expect } from 'vitest';
import { buildStrategy, type StrategySpec } from './strategySpec.js';

const q = (last: number) => ({ symbol: 'X', currency: 'KRW' as const, bid: last, ask: last, last, ts: 1 });

describe('buildStrategy', () => {
  it('builds a threshold strategy', () => {
    const s = buildStrategy(1, 'X', 'KRW', 'PAPER', { type: 'threshold', params: { buyBelow: 90, sellAbove: 110, orderNotional: 1000 } });
    expect(s.signal!(q(85))).toBe('BULLISH');
  });
  it('builds a composite of sma AND threshold', () => {
    const spec: StrategySpec = { type: 'composite', combine: 'AND', orderNotional: 1000,
      a: { type: 'threshold', params: { buyBelow: 90, sellAbove: 110, orderNotional: 1 } },
      b: { type: 'sma', params: { fastPeriod: 2, slowPeriod: 3, orderNotional: 1 } } };
    const s = buildStrategy(2, 'X', 'KRW', 'PAPER', spec);
    expect(s.symbols.has('X')).toBe(true);
    expect(typeof s.signal).toBe('function');
  });
  it('throws on an unknown spec type', () => {
    expect(() => buildStrategy(3, 'X', 'KRW', 'PAPER', { type: 'nope' } as unknown as StrategySpec)).toThrow();
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `strategySpec.ts` with a discriminated union + factory that maps `threshold`→`ThresholdStrategy`, `sma`→`MovingAverageCrossStrategy`, `composite`→`CompositeStrategy(buildStrategy(0,...a), buildStrategy(0,...b))`. Throw `Error('unknown strategy spec: ' + type)` on default.

- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(strategy): StrategySpec + buildStrategy factory"`

---

## Phase 2 — Backend endpoints

### Task 6: TossApiClient.getStocks + getCandles

**Files:** Modify `src/toss/TossApiClient.ts`, `src/toss/types.ts`; test via a fake-fetch unit is impractical — instead assert URL shaping in a small test using a stubbed `request`.

**Interfaces:** Produces `getStocks(): Promise<TossStock[]>` and `getCandles(symbol, interval): Promise<TossCandle[]>`; types `TossStock { symbol; name; market }`, `TossCandle { time; open; high; low; close }` (numbers parsed from Toss strings by the SymbolCatalog / candle route, not here).

- [ ] Add types to `toss/types.ts`; add methods to `TossApiClient` using `PREFIX` paths `/stocks` and `/candles?symbol=&interval=` (⚠️ confirm exact params vs live probe). Reuse the existing `request` envelope-unwrap.
- [ ] Test: construct client with a stubbed `tokens` + monkeypatched `request` returning a fixed array; assert the returned value passes through. Commit `feat(toss): getStocks + getCandles`.

### Task 7: SymbolCatalog (cached search)

**Files:** Create `src/market/SymbolCatalog.ts`; test `src/market/SymbolCatalog.test.ts`.

**Interfaces:** `class SymbolCatalog { constructor(fetchStocks: () => Promise<TossStock[]>, opts?: { now; ttlMs }); search(q: string, limit?): Promise<TossStock[]> }` — case-insensitive substring on symbol or name; caches the full list for `ttlMs` (default 1h).

- [ ] TDD: fetch called once within TTL; search matches symbol+name substring, case-insensitive; empty query returns first `limit`. Commit `feat(market): SymbolCatalog search + cache`.

### Task 8: /market/symbols + /market/candles routes

**Files:** Modify `src/api/server.ts`; `src/app/TradingSystem.ts` (add `searchSymbols`, `candles` passthroughs); test `src/api/server.test.ts` (add cases with a stub catalog/client on the system).

**Interfaces:** `GET /api/market/symbols?q=&limit=` → `TossStock[]`; `GET /api/market/candles?symbol=&interval=` → `TossCandle[]` (400 on missing symbol).

- [ ] TDD via `app.inject`: `/api/market/symbols?q=삼성` returns matches; `/candles` returns the normalized array; missing `symbol` → 400. Wire `TradingSystem` to hold a `SymbolCatalog` + a `candles` fn. Commit.

### Task 9: /backtest route

**Files:** Modify `src/api/server.ts`, `src/app/TradingSystem.ts`; test.

**Interfaces:** `POST /api/backtest` body `{ symbol, spec, interval?, capital? }` → `{ metrics, equityCurve, markers: {time, side, price}[] }`. Builds via `buildStrategy`, fetches candles → `Bar[]` (`ts=time*1000` or ms, `price=close`), runs `BacktestEngine`, maps `trades`/fills to markers.

- [ ] TDD: with a stub candles source returning a rising-then-falling series and a threshold spec, `POST /api/backtest` returns `metrics.tradeCount >= 1` and non-empty `markers`. Commit `feat(api): backtest endpoint`.

### Task 10: /strategies deploy + dynamic registration + spec persistence

**Files:** Modify `src/api/server.ts`, `src/app/TradingSystem.ts`, `src/index.ts`, `src/persistence/StatePersistence.ts` (persist deployed specs), `src/strategy/StrategyRegistry.ts` (store spec alongside status if needed); test.

**Interfaces:** `POST /api/strategies` body `{ symbol, spec, name }` → creates id `max+1`, `buildStrategy`, `engine.register`, `registry.register(..., 'PAPER_TESTING')`, adds symbol to a mutable watch set, persists spec; returns the `StrategyView`. `DELETE /api/strategies/:id` → `engine.unregister` + registry remove + watch cleanup. Deployed specs are saved in the state snapshot and rebuilt on boot via the factory.

- [ ] TDD via `inject`: deploy a spec → appears in `GET /api/strategies`; `DELETE` removes it. Persistence test: a deployed spec round-trips through `FileStatePersistence` (extend the snapshot with `deployedSpecs: [id, {symbol, spec, name}][]`; on load, rebuild + register). Commit `feat(api): deploy/undeploy strategies + spec persistence`.

Notes: the watch list in `index.ts` is currently a static array — change it to a mutable `Set`/`Map` owned by `TradingSystem` so deploy can add symbols and the worker's `getWatched` reads it live.

---

## Phase 3 — Frontend (vanilla + lightweight-charts)

### Task 11: Composer page — symbol picker + chart + backtest preview

**Files:** Modify `src/api/server.ts` (replace `DASHBOARD_HTML` with the composer page); no unit test framework for the browser — verify by running.

**Deliverable:** One HTML page served at `/` that:
- loads `lightweight-charts` from `https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js`;
- left panel: search box → `GET /api/market/symbols?q=` → clickable list; selecting a symbol calls `GET /api/market/candles?symbol=` and renders a candlestick series;
- builder: two `<select>` (threshold|sma) with param inputs, an AND/OR toggle, a notional input;
- `Backtest` button → `POST /api/backtest` → draws BUY/SELL markers (`series.setMarkers`) and shows metrics (return, MDD, win%, PF);
- keeps the existing positions/logs/halt panel + emergency-stop button;
- escapes all API strings before DOM insertion.

- [ ] **Verify by running:** `npx tsx src/index.ts`, open `http://127.0.0.1:3000`, search a symbol, load its chart, run a backtest, confirm markers + metrics render. (Market data requires open hours; candles are historical so the chart works anytime.)
- [ ] **Route smoke test** in `server.test.ts`: `GET /` returns 200 `text/html` containing `lightweight-charts` and `Backtest`. Commit `feat(ui): TradingView-style composer page (chart + backtest preview)`.

### Task 12: Deploy button + live overlay

**Files:** Modify the composer page JS (in `server.ts`).

**Deliverable:** `Deploy to paper` button → `POST /api/strategies` with the built spec + symbol; on success it appears in the strategies panel. A poll (existing 3s refresh) updates the chart's last-price line and overlays the deployed strategy's live fills as markers (from `/api/logs`/`/api/positions`). A `DELETE` control removes a deployed strategy.

- [ ] **Verify by running:** deploy a composite, confirm it shows in `/api/strategies` and (during market hours) trades on the chart. Commit `feat(ui): deploy composite to paper + live overlay`.

---

## Self-Review

- **Spec coverage:** signal refactor (T1–3), composite AND/OR (T4), spec/factory (T5), symbols (T6–8), candles (T6,8), backtest (T9), deploy+persistence (T10), chart+picker+builder+preview (T11), deploy+live overlay (T12). All spec sections mapped.
- **Placeholder scan:** logic tasks (T1–5) carry full code + tests; T6–12 carry interfaces, test intent, and the key wiring — the exploratory Toss param/candle-shape and browser-chart bits are marked ⚠️/"verify by running" because they depend on live API shape and are validated by execution, not unit tests.
- **Type consistency:** `Signal`, `signalToIntent(signal, held, opts)`, `StrategySpec`, `buildStrategy(id, symbol, currency, mode, spec)`, `CompositeStrategy(cfg, a, b)` used consistently across tasks.
