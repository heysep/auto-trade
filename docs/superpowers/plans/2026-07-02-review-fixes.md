# Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three code-review findings (defensive drawdown sign bug, thundering-herd cache, 429 retry clamping) each with a TDD regression test.

**Architecture:** Pure bug-fix pass — no new files, no API changes. Each fix is isolated to one or two source files plus one test file. Tests are written first (TDD), applied fix makes them green.

**Tech Stack:** TypeScript (strict + ESM), Vitest, Node ≥ 20, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.

## Global Constraints

- Strict TypeScript: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, ESM `.js` imports.
- Pure factor functions; no I/O inside factor math.
- Per-symbol failure isolation preserved in both ranking and backtest services.
- Only 429 retried; all other HTTP errors propagate immediately.
- `npm run typecheck` clean after every task.
- `npx vitest run` green (262 + new tests) before commit.

---

### Task 1: Fix defensive-factor drawdown sign in FactorModel

**Files:**
- Test: `src/factor/FactorModel.test.ts` (add new `describe` block)
- Fix: `src/factor/FactorModel.ts` line 136

**Background:** `maxDrawdown` returns a NON-POSITIVE value where closer-to-0 means shallower (safer). A safe stock has higher (closer to 0) raw MDD → higher z-score after standardisation. The current code negates the MDD z-score (`-zm`) which REWARDS deep drawdowns. The volatility term `-zv` is correct (low vol = high score). Fix: remove negation on the drawdown term only.

**Test design:** Two symbols with IDENTICAL realized volatility (same last-2 returns) but clearly different max drawdowns (one shallow ~0%, one deep ~-48%). With equal vols, `zVol=[0,0]` so the defensive score is driven purely by the MDD term. Buggy code produces tied scores (0,0); fixed code correctly scores shallow MDD higher.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `src/factor/FactorModel.test.ts` **before** the closing of the file (after line 249):

```typescript
// ── NEW: defensive drawdown sign regression test ──────────────────────────────
describe('FactorModel.score — defensive factor: shallower MDD scores higher', () => {
  // Custom periods: volWindow=2 (only last 2 returns) keeps vol window
  // out of the mid-series trough; mddWindow=5 captures the trough.
  // momLong=5, momMid=3 → needs n > 5, so we use n=8.
  const DEF_PERIODS: FactorPeriods = {
    momSkip: 1,
    momLong: 5,
    momMid: 3,
    volWindow: 2,
    mddWindow: 5,
  };

  // Both series share identical prices[5..7] → last 2 returns are EQUAL → same vol.
  // DEEP has a sharp trough at prices[4]=60, captured by mddWindow=5 (prices[3..7]).
  // SHALLOW rises monotonically → mdd ≈ 0.
  const SHALLOW_PRICES = [100, 105, 110, 115, 120, 121, 122, 123];
  const DEEP_PRICES    = [100, 105, 110, 115,  60, 121, 122, 123];

  const shallowEntry: UniverseEntry = { symbol: 'SHALLOW', sector: 'TEST', prices: SHALLOW_PRICES };
  const deepEntry: UniverseEntry    = { symbol: 'DEEP',    sector: 'TEST', prices: DEEP_PRICES    };

  it('shallower-drawdown symbol has a higher defensive score than deeper-drawdown symbol', () => {
    const model = new FactorModel(DEFAULT_WEIGHTS, DEF_PERIODS);
    const results = model.score([shallowEntry, deepEntry]);

    const shallow = results.find((r) => r.symbol === 'SHALLOW');
    const deep    = results.find((r) => r.symbol === 'DEEP');

    expect(shallow).toBeDefined();
    expect(deep).toBeDefined();
    expect(shallow!.factors.defensive).toBeDefined();
    expect(deep!.factors.defensive).toBeDefined();

    // Shallower MDD (≈ 0) must score strictly higher than deeper MDD (≈ -48%).
    // FAILS before fix (bug ties them at 0); PASSES after fix.
    expect(shallow!.factors.defensive).toBeGreaterThan(deep!.factors.defensive!);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorModel.test.ts 2>&1 | tail -20
```

Expected: 1 test FAILS with something like "expected 0 to be greater than 0" or similar.

- [ ] **Step 3: Apply the fix**

In `src/factor/FactorModel.ts`, change line 136:

```typescript
// BEFORE (buggy):
      return (-zv + -zm) / 2;
// AFTER (fixed):
      return (-zv + zm) / 2;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorModel.test.ts 2>&1 | tail -10
```

Expected: All tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -5
```

Expected: no errors.

---

### Task 2a: In-flight dedup for FactorRankingService

**Files:**
- Test: `src/factor/FactorRankingService.test.ts` (add new `describe` block)
- Fix: `src/factor/FactorRankingService.ts` (add `inflight` field, refactor `rank`)

**Background:** Two concurrent cold-cache calls both bypass the cache check and both run the full sequential fetch, doubling the cost. Fix: store the in-progress Promise in `this.inflight`; concurrent misses await the same Promise; clear it in `try/finally` regardless of success/failure.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `src/factor/FactorRankingService.test.ts` (after the existing `describe('TTL / cache invalidation'` block, before the final `});`):

```typescript
  describe('in-flight dedup (thundering herd)', () => {
    it('two concurrent cold-cache rank() calls fetch each symbol exactly once', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let fetchCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        fetchCount++;
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => 0,
        ttlMs: 60_000,
      });

      // Fire two concurrent cold-cache calls.
      const [r1, r2] = await Promise.all([service.rank(), service.rank()]);

      // 3 symbols — without dedup, both calls would fetch 3 each = 6 total.
      // With dedup, the second call awaits the first's in-flight promise: total = 3.
      expect(fetchCount).toBe(UNIVERSE.length);
      expect(r1.scored).toHaveLength(3);
      expect(r2.scored).toHaveLength(3);
    });

    it('a call after the in-flight settles still serves from TTL cache', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let fetchCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        fetchCount++;
        const data = CLOSES_BY_SYMBOL[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      let now = 0;
      const service = new FactorRankingService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => now,
        ttlMs: 60_000,
      });

      // Prime with concurrent calls (should only fetch 3 total).
      await Promise.all([service.rank(), service.rank()]);
      expect(fetchCount).toBe(UNIVERSE.length);

      // A subsequent call within TTL must NOT trigger new fetches.
      fetchCount = 0;
      now = 1_000; // still fresh
      await service.rank();
      expect(fetchCount).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorRankingService.test.ts 2>&1 | tail -20
```

Expected: the two new tests FAIL (fetchCount is 6 not 3).

- [ ] **Step 3: Apply the fix to FactorRankingService.ts**

Add `private inflight: Promise<RankingResult> | undefined;` field after `private cache`. Extract the rebuild into `private buildRanking(now: number): Promise<RankingResult>`. Rewrite `rank()` to check and set `inflight`.

Full replacement for the class body (fields + methods):

```typescript
  private cache: RankingResult | undefined;
  private inflight: Promise<RankingResult> | undefined;

  // ...constructor unchanged...

  async rank(limit?: number): Promise<RankingResult> {
    const now = this.now();

    // Cache hit: age strictly less than ttlMs
    if (this.cache !== undefined && now - this.cache.asOf < this.ttlMs) {
      return this.slice(this.cache, limit);
    }

    // In-flight dedup: join the pending rebuild instead of starting a new one.
    if (this.inflight !== undefined) {
      const result = await this.inflight;
      return this.slice(result, limit);
    }

    // Start rebuild; store the promise synchronously so concurrent callers join it.
    this.inflight = this.buildRanking(now);
    try {
      const result = await this.inflight;
      this.cache = result;
      return this.slice(result, limit);
    } finally {
      this.inflight = undefined;
    }
  }

  private async buildRanking(now: number): Promise<RankingResult> {
    const stocks = await this.universe();
    const universeSize = stocks.length;

    let fetched = 0;
    let skipped = 0;
    const entries: Array<{ symbol: string; sector: string; prices: number[] }> = [];

    for (const stock of stocks) {
      try {
        const candles = await this.getCandles(stock.symbol, '1d', this.candleCount);
        if (candles.length === 0) { skipped++; continue; }

        const sorted = [...candles].sort((a, b) => {
          const ta = Date.parse(a.timestamp);
          const tb = Date.parse(b.timestamp);
          if (ta !== tb) return ta - tb;
          return Number(a.closePrice) - Number(b.closePrice);
        });

        const prices = sorted
          .map((c) => Number(c.closePrice))
          .filter((p) => !Number.isNaN(p));

        if (prices.length === 0) { skipped++; continue; }

        entries.push({ symbol: stock.symbol, sector: stock.market || 'KR', prices });
        fetched++;
      } catch {
        skipped++;
      }
    }

    const scored = this.model.score(entries);
    return { asOf: now, scored, universeSize, fetched, skipped };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorRankingService.test.ts 2>&1 | tail -10
```

Expected: All tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -5
```

---

### Task 2b: In-flight dedup for FactorBacktestService

**Files:**
- Test: `src/factor/FactorBacktestService.test.ts` (add new `describe` block)
- Fix: `src/factor/FactorBacktestService.ts` (add `inflight` field, refactor `getMatrix`)

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `src/factor/FactorBacktestService.test.ts` (after the existing `describe('per-symbol failure isolation'` block, before the final `});`):

```typescript
  describe('in-flight dedup (thundering herd)', () => {
    it('two concurrent cold-cache run() calls fetch each symbol exactly once', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let fetchCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        fetchCount++;
        const data = CLOSES[symbol];
        if (data === undefined) throw new Error(`unknown: ${symbol}`);
        return makeCandles(data);
      };

      const svc = new FactorBacktestService({
        universe: () => UNIVERSE,
        getCandles,
        model,
        now: () => 0,
        ttlMs: 60_000,
      });

      // Fire two concurrent cold-cache calls.
      const [r1, r2] = await Promise.all([svc.run(), svc.run()]);

      // 4 symbols — without dedup both calls fetch 4 each = 8 total.
      // With dedup the second call awaits the first: total = 4.
      expect(fetchCount).toBe(UNIVERSE.length);
      expect(Array.isArray(r1.result.equityCurve)).toBe(true);
      expect(Array.isArray(r2.result.equityCurve)).toBe(true);
    });

    it('a call after the in-flight settles still serves from TTL cache', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);
      let fetchCount = 0;
      const getCandles = async (
        symbol: string,
        _interval: '1d',
        _count: number,
      ): Promise<TossCandle[]> => {
        fetchCount++;
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

      // Prime with concurrent calls.
      await Promise.all([svc.run(), svc.run()]);
      expect(fetchCount).toBe(UNIVERSE.length);

      // A subsequent call within TTL must NOT trigger new fetches.
      fetchCount = 0;
      now = 1_000;
      await svc.run();
      expect(fetchCount).toBe(0);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorBacktestService.test.ts 2>&1 | tail -20
```

Expected: the two new tests FAIL (fetchCount is 8 not 4).

- [ ] **Step 3: Apply the fix to FactorBacktestService.ts**

Add `private inflight: Promise<MatrixCache> | undefined;` after `private cache`. Extract the rebuild logic from `getMatrix` into `private buildMatrix(now: number): Promise<MatrixCache>`. Rewrite `getMatrix()` with inflight dedup:

```typescript
  private cache: MatrixCache | undefined;
  private inflight: Promise<MatrixCache> | undefined;

  private async getMatrix(): Promise<MatrixCache> {
    const now = this.now();

    if (this.cache !== undefined && now - this.cache.asOf < this.ttlMs) {
      return this.cache;
    }

    if (this.inflight !== undefined) {
      return this.inflight;
    }

    this.inflight = this.buildMatrix(now);
    try {
      const entry = await this.inflight;
      this.cache = entry;
      return entry;
    } finally {
      this.inflight = undefined;
    }
  }

  private async buildMatrix(now: number): Promise<MatrixCache> {
    const stocks = await this.universe();
    const universeSize = stocks.length;
    let fetched = 0;
    let skipped = 0;
    const matrix: BacktestSymbol[] = [];

    for (const stock of stocks) {
      try {
        const candles = await this.getCandles(stock.symbol, '1d', this.historyBars);
        if (candles.length === 0) { skipped++; continue; }

        const sorted = [...candles].sort(
          (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
        );

        const series = sorted
          .map((c) => ({ date: Date.parse(c.timestamp), close: Number(c.closePrice) }))
          .filter((pt) => !Number.isNaN(pt.close) && pt.close > 0);

        if (series.length === 0) { skipped++; continue; }

        matrix.push({ symbol: stock.symbol, sector: stock.market || 'KR', series });
        fetched++;
      } catch {
        skipped++;
      }
    }

    return { matrix, asOf: now, universeSize, fetched, skipped };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorBacktestService.test.ts 2>&1 | tail -10
```

Expected: All tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -5
```

---

### Task 3: Retry-After clamping + NaN guard in TossApiClient

**Files:**
- Test: `src/toss/TossApiClient.test.ts` (add two new `it` blocks inside the existing `describe('TossApiClient 429 retry'` block)
- Fix: `src/toss/TossApiClient.ts` (add `RETRY_DELAY_CAP_MS`, fix delay computation in `request`)

**Background:** (a) `Retry-After: 3600` causes a 1-hour sleep stalling the universe build. (b) An HTTP-date `Retry-After` (e.g. `Wed, 01 Jan 2026 00:00:00 GMT`) makes `Number(ra)` → NaN → `retryAfterSec` = NaN; the current guard `!== undefined` is true for NaN, so `NaN * 1000 = NaN` and `sleep(NaN)` is immediate (tight retry, no backoff). Fix: use `Number.isFinite(ra)` guard + `Math.min(base, RETRY_DELAY_CAP_MS)`.

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside `describe('TossApiClient 429 retry', () => {` in `src/toss/TossApiClient.test.ts`, after the existing four `it` blocks (before the closing `});`):

```typescript
  it('clamps large Retry-After (e.g. 3600 s) to RETRY_DELAY_CAP_MS (≤ 30 000 ms)', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    const client = new TossApiClient(fakeTokens, { sleep, maxRetries: 4 });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponse(429, undefined, { 'retry-after': '3600' });
      }
      return makeResponse(200, { result: successPage });
    });

    await client.getCandles('005930', '1d', 1);

    expect(callCount).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Without cap this would be 3_600_000; with cap it must be ≤ 30_000.
    expect(delays[0]).toBeLessThanOrEqual(30_000);
    expect(delays[0]).toBeGreaterThan(0);
  });

  it('falls back to finite exponential backoff when Retry-After is a non-numeric HTTP date', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    const client = new TossApiClient(fakeTokens, { sleep, maxRetries: 4 });

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount++;
      if (callCount === 1) {
        // HTTP-date string → Number(...) = NaN
        return makeResponse(429, undefined, {
          'retry-after': 'Wed, 01 Jan 2026 00:00:00 GMT',
        });
      }
      return makeResponse(200, { result: successPage });
    });

    await client.getCandles('005930', '1d', 1);

    expect(callCount).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // Before fix: sleep(NaN) is called (immediate tight retry — bad).
    // After fix: finite exponential backoff > 0.
    const delay = delays[0]!;
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/toss/TossApiClient.test.ts 2>&1 | tail -20
```

Expected: the two new tests FAIL (first: delay is 3_600_000, not ≤ 30_000; second: delay is NaN, isFinite=false).

- [ ] **Step 3: Apply the fix to TossApiClient.ts**

Add constant after `BACKOFF_BASE_MS`:
```typescript
const RETRY_DELAY_CAP_MS = 30_000;
```

Replace the delay computation in `request()`:
```typescript
// BEFORE:
        const delayMs = lastRateLimitError?.retryAfterSec !== undefined
          ? lastRateLimitError.retryAfterSec * 1000
          : BACKOFF_BASE_MS * Math.pow(2, attempt - 1);

// AFTER:
        const ra = lastRateLimitError?.retryAfterSec;
        const base = (ra !== undefined && Number.isFinite(ra))
          ? ra * 1000
          : BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        const delayMs = Math.min(base, RETRY_DELAY_CAP_MS);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/toss/TossApiClient.test.ts 2>&1 | tail -10
```

Expected: All 10 tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -5
```

---

### Task 4: Full suite + live run + commit

- [ ] **Step 1: Full vitest run**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run 2>&1 | tail -10
```

Expected: all 268 tests pass (262 original + 6 new).

- [ ] **Step 2: Final typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1
```

Expected: no output (exit 0).

- [ ] **Step 3: Live run**

```bash
cd /Users/im-yoseb/auto-trading && npx tsx src/index.ts &
sleep 5
curl -s "http://127.0.0.1:3000/api/factors/ranking?limit=5"
curl -s -X POST http://127.0.0.1:3000/api/factors/backtest \
  -H 'content-type: application/json' \
  -d '{"topN":5,"rebalanceEvery":21}' --max-time 240
kill %1
```

- [ ] **Step 4: Write report**

Write findings to `/Users/im-yoseb/auto-trading/.superpowers/sdd/review-fixes-report.md`.

- [ ] **Step 5: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/factor/FactorModel.ts src/factor/FactorModel.test.ts \
  src/factor/FactorRankingService.ts src/factor/FactorRankingService.test.ts \
  src/factor/FactorBacktestService.ts src/factor/FactorBacktestService.test.ts \
  src/toss/TossApiClient.ts src/toss/TossApiClient.test.ts \
  docs/superpowers/plans/2026-07-02-review-fixes.md
git commit -m "fix(factor): defensive drawdown sign + cache in-flight dedup + bounded 429 retry"
```
