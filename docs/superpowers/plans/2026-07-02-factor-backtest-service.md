# Factor Backtest Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the committed `FactorBacktest` engine to real universe data + a `POST /api/factors/backtest` HTTP endpoint, with full TDD and live smoke test.

**Architecture:** `FactorBacktestService` (new) caches the expensive `BacktestSymbol[]` matrix (sequential candle fetches) with a configurable TTL; each `run(params)` within TTL reuses the matrix and re-runs the cheap `FactorBacktest` engine with different params. `TradingSystem` gets an optional `factorBacktest` dep that returns 503 when absent. The HTTP server exposes `POST /api/factors/backtest` with param validation.

**Tech Stack:** TypeScript ESM, Fastify 5, Vitest, `tsx` for local dev. Strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). `.js` imports required.

## Global Constraints

- `exactOptionalPropertyTypes`: conditional-spread optional properties; never `prop?: T` where you assign `undefined` directly.
- `noUncheckedIndexedAccess`: always guard `arr[i]` with `?? fallback` or `!` after bounds check.
- All imports use `.js` extension (ESM).
- Toss numeric fields (e.g. `closePrice`) are strings; always `Number(c.closePrice)`.
- Sequential candle fetch; no concurrency. Per-symbol try/catch to isolate failures.
- No debug/scratch files left behind.

---

### Task 1: `FactorBacktestService` + its tests (TDD)

**Files:**
- Create: `src/factor/FactorBacktestService.ts`
- Create: `src/factor/FactorBacktestService.test.ts`

**Interfaces produced:**
```typescript
// FactorBacktestService.ts
export interface FactorBacktestParams {
  topN?: number;
  rebalanceEvery?: number;
  startCapital?: number;
}
export interface FactorBacktestServiceDeps {
  universe: () => TossStock[] | Promise<TossStock[]>;
  getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  model: FactorModel;
  now?: () => number;
  ttlMs?: number;
  historyBars?: number;
}
export interface FactorBacktestReport {
  result: FactorBacktestResult;
  universeSize: number;
  fetched: number;
  skipped: number;
  asOf: number;
}
export class FactorBacktestService {
  constructor(deps: FactorBacktestServiceDeps);
  async run(params?: FactorBacktestParams): Promise<FactorBacktestReport>;
}
```

- [ ] **Step 1: Write failing tests**

Create `src/factor/FactorBacktestService.test.ts`:

```typescript
// TDD: tests written BEFORE the implementation.
import { describe, it, expect } from 'vitest';
import { FactorBacktestService } from './FactorBacktestService.js';
import { FactorModel } from './FactorModel.js';
import type { TossStock, TossCandle } from '../toss/types.js';

// Short periods so a ~10-bar series scores properly
const SMALL_PERIODS = { momSkip: 1, momLong: 3, momMid: 2, volWindow: 3, mddWindow: 3 };

function makeCandles(closes: number[]): TossCandle[] {
  return closes.map((close, i) => ({
    timestamp: new Date(86400_000 * (i + 1)).toISOString(), // day apart
    openPrice: String(close),
    highPrice: String(close),
    lowPrice: String(close),
    closePrice: String(close),
  }));
}

const UNIVERSE: TossStock[] = [
  { symbol: 'A', name: 'Alpha', market: 'KOSPI' },
  { symbol: 'B', name: 'Beta',  market: 'KOSDAQ' },
  { symbol: 'C', name: 'Gamma', market: 'KOSPI' },
  { symbol: 'D', name: 'Delta', market: 'KOSDAQ' },
];

const CLOSES: Record<string, number[]> = {
  A: [100,102,104,106,108,110,112,114,116,118,120,122],
  B: [100, 80,120, 60, 50, 55, 60, 65, 70, 75, 80, 85],
  C: [100,100,100,100,100,101,101,102,102,103,103,104],
  D: [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45],
};

function makeGetCandles(
  closes: Record<string, number[]>,
): (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]> {
  return async (symbol: string, _interval: '1d', _count: number) => {
    const data = closes[symbol];
    if (data === undefined) throw new Error(`unknown: ${symbol}`);
    return makeCandles(data);
  };
}

describe('FactorBacktestService', () => {
  describe('basic run', () => {
    it('returns a report with equityCurve + rebalances + metrics', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles: makeGetCandles(CLOSES),
        model,
      });
      const report = await svc.run({ topN: 2, rebalanceEvery: 3, startCapital: 1_000_000 });
      expect(report.universeSize).toBe(4);
      expect(report.fetched).toBeGreaterThanOrEqual(1);
      expect(typeof report.asOf).toBe('number');
      expect(Array.isArray(report.result.equityCurve)).toBe(true);
      expect(Array.isArray(report.result.rebalances)).toBe(true);
      expect(typeof report.result.metrics.totalReturn).toBe('number');
      expect(typeof report.result.metrics.maxDrawdown).toBe('number');
      expect(typeof report.result.metrics.rebalanceCount).toBe('number');
      expect(typeof report.result.metrics.finalNav).toBe('number');
      // At least one rebalance occurred
      expect(report.result.result.rebalances.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('matrix cache', () => {
    it('fetches candles once then reuses cache across two run() calls with different params', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let callCount = 0;
      const getCandles = async (symbol: string, _interval: '1d', _count: number): Promise<TossCandle[]> => {
        callCount++;
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs: 60_000,
      });

      // First run: fetches all 4 symbols
      await svc.run({ topN: 2, rebalanceEvery: 3 });
      const firstCallCount = callCount;
      expect(firstCallCount).toBe(4);

      // Second run within TTL with different params: no new fetches
      callCount = 0;
      await svc.run({ topN: 1, rebalanceEvery: 5 });
      expect(callCount).toBe(0); // cache reused
    });

    it('refetches after TTL expires', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let callCount = 0;
      const getCandles = async (symbol: string, _interval: '1d', _count: number): Promise<TossCandle[]> => {
        callCount++;
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const ttlMs = 60_000;
      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs,
      });

      await svc.run();
      expect(callCount).toBe(4);

      // Still within TTL
      callCount = 0;
      now = ttlMs - 1;
      await svc.run();
      expect(callCount).toBe(0);

      // Past TTL
      callCount = 0;
      now = ttlMs + 1;
      await svc.run();
      expect(callCount).toBe(4);
    });
  });

  describe('per-symbol failure isolation', () => {
    it('skips a symbol that throws and increments skipped', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      const BAD = 'B';
      const getCandles = async (symbol: string, _interval: '1d', _count: number): Promise<TossCandle[]> => {
        if (symbol === BAD) throw new Error('fetch failure');
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
      });

      const report = await svc.run();
      expect(report.universeSize).toBe(4);
      expect(report.skipped).toBe(1);
      expect(report.fetched).toBe(3);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they FAIL**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorBacktestService.test.ts
```
Expected: FAIL — `FactorBacktestService` not found.

- [ ] **Step 3: Implement `FactorBacktestService.ts`**

Create `src/factor/FactorBacktestService.ts`:

```typescript
// Service that caches the universe price matrix (expensive: N × historyBars candle fetches)
// with a configurable TTL, then re-runs the cheap FactorBacktest engine per request.
// Pattern mirrors FactorRankingService (TTL cache + sequential fetch + per-symbol isolation).

import type { TossStock, TossCandle } from '../toss/types.js';
import type { FactorModel } from './FactorModel.js';
import { FactorBacktest, type BacktestSymbol, type FactorBacktestResult } from './FactorBacktest.js';

export interface FactorBacktestParams {
  topN?: number;
  rebalanceEvery?: number;
  startCapital?: number;
}

export interface FactorBacktestServiceDeps {
  /** Supplier of the universe; called on every cache miss. May be sync or async. */
  universe: () => TossStock[] | Promise<TossStock[]>;
  /** Fetch daily candles for one symbol. Called sequentially, NOT concurrently. */
  getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  /** Pre-constructed FactorModel. */
  model: FactorModel;
  /** Injectable clock — defaults to Date.now. */
  now?: () => number;
  /** Cache TTL in milliseconds. Default: 3_600_000 (1 hour). */
  ttlMs?: number;
  /** Number of daily candles to fetch per symbol. Default: 500. */
  historyBars?: number;
}

export interface FactorBacktestReport {
  result: FactorBacktestResult;
  universeSize: number;
  fetched: number;
  skipped: number;
  asOf: number;
}

const DEFAULT_TTL_MS = 3_600_000;    // 1 hour
const DEFAULT_HISTORY_BARS = 500;
const DEFAULT_TOP_N = 10;
const DEFAULT_REBALANCE_EVERY = 21;
const DEFAULT_START_CAPITAL = 10_000_000;

interface MatrixCache {
  matrix: BacktestSymbol[];
  asOf: number;
  universeSize: number;
  fetched: number;
  skipped: number;
}

export class FactorBacktestService {
  private readonly universe: () => TossStock[] | Promise<TossStock[]>;
  private readonly getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  private readonly model: FactorModel;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly historyBars: number;

  private cache: MatrixCache | undefined;

  constructor(deps: FactorBacktestServiceDeps) {
    this.universe = deps.universe;
    this.getCandles = deps.getCandles;
    this.model = deps.model;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.historyBars = deps.historyBars ?? DEFAULT_HISTORY_BARS;
  }

  async run(params?: FactorBacktestParams): Promise<FactorBacktestReport> {
    const matrixCache = await this.getMatrix();

    const topN = params?.topN ?? DEFAULT_TOP_N;
    const rebalanceEvery = params?.rebalanceEvery ?? DEFAULT_REBALANCE_EVERY;
    const startCapital = params?.startCapital ?? DEFAULT_START_CAPITAL;

    const engine = new FactorBacktest(this.model, { topN, rebalanceEvery, startCapital });
    const result = engine.run(matrixCache.matrix);

    return {
      result,
      universeSize: matrixCache.universeSize,
      fetched: matrixCache.fetched,
      skipped: matrixCache.skipped,
      asOf: matrixCache.asOf,
    };
  }

  private async getMatrix(): Promise<MatrixCache> {
    const now = this.now();

    if (this.cache !== undefined && now - this.cache.asOf < this.ttlMs) {
      return this.cache;
    }

    const stocks = await this.universe();
    const universeSize = stocks.length;

    let fetched = 0;
    let skipped = 0;
    const matrix: BacktestSymbol[] = [];

    // Sequential — one symbol at a time to respect rate limits
    for (const stock of stocks) {
      try {
        const candles = await this.getCandles(stock.symbol, '1d', this.historyBars);
        if (candles.length === 0) {
          skipped++;
          continue;
        }

        // Sort ascending by timestamp
        const sorted = [...candles].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

        // Map to PricePoints; drop NaN
        const series = sorted
          .map((c) => ({ date: Date.parse(c.timestamp), close: Number(c.closePrice) }))
          .filter((pt) => !Number.isNaN(pt.date) && !Number.isNaN(pt.close));

        if (series.length === 0) {
          skipped++;
          continue;
        }

        matrix.push({
          symbol: stock.symbol,
          sector: stock.market || 'KR',
          series,
        });
        fetched++;
      } catch {
        skipped++;
      }
    }

    const cacheEntry: MatrixCache = {
      matrix,
      asOf: now,
      universeSize,
      fetched,
      skipped,
    };
    this.cache = cacheEntry;
    return cacheEntry;
  }
}
```

- [ ] **Step 4: Run tests to confirm they PASS**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorBacktestService.test.ts
```
Expected: all tests green.

---

### Task 2: Wire `TradingSystem.factorBacktest()` + server endpoint + harness tests

**Files:**
- Modify: `src/app/TradingSystem.ts`
- Modify: `src/api/server.ts`
- Modify: `src/api/server.test.ts` (add describe block for POST /api/factors/backtest)
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing server tests for POST /api/factors/backtest**

Add a new `describe('POST /api/factors/backtest', ...)` block to `src/api/server.test.ts`.

- [ ] **Step 2: Run server tests (new ones should fail)**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/api/server.test.ts
```
Expected: new factor/backtest tests fail.

- [ ] **Step 3: Add `factorBacktest` dep + method to TradingSystem**

Modify `TradingSystemDeps` and `TradingSystem` in `src/app/TradingSystem.ts`.

- [ ] **Step 4: Add `POST /api/factors/backtest` to server.ts**

- [ ] **Step 5: Wire in index.ts**

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run
```
Expected: all 253+ tests green.

- [ ] **Step 7: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck
```
Expected: clean.

---

### Task 3: Live smoke test + commit

- [ ] **Step 1: Start server in background**

```bash
cd /Users/im-yoseb/auto-trading && npx tsx src/index.ts &
```

- [ ] **Step 2: Wait ~10s for server to start, then curl**

```bash
curl -s -X POST http://127.0.0.1:3000/api/factors/backtest \
  -H 'content-type: application/json' \
  -d '{"topN":5,"rebalanceEvery":21}' --max-time 240
```

- [ ] **Step 3: Kill server**

- [ ] **Step 4: Commit**

```bash
git add src/factor/FactorBacktestService.ts src/factor/FactorBacktestService.test.ts \
  src/app/TradingSystem.ts src/api/server.ts src/api/server.test.ts src/index.ts
git commit -m "feat(factor): backtest service + POST /api/factors/backtest (universe matrix cache)"
```

- [ ] **Step 5: Write report to `.superpowers/sdd/factor-backtest-service-report.md`**
