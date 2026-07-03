# Review Fixes Report

**Status:** COMPLETE  
**Branch:** feat/trading-ui  
**Date:** 2026-07-02

---

## Summary

Three code-review findings fixed with TDD regression tests. All tests written first (red), fix applied (green). Full suite passes; typecheck clean; live run completed.

---

## Fix 1 — Defensive factor drawdown sign (CRITICAL)

**File:** `src/factor/FactorModel.ts` line 136  
**Change:** `(-zv + -zm)` → `(-zv + zm)`

`maxDrawdown` returns a NON-POSITIVE value where closer-to-0 means safer. The negation `−zm` was inverting the MDD z-score, rewarding deep drawdowns and penalising shallow ones. The volatility term `−zv` is correct and unchanged.

**Regression test:** `src/factor/FactorModel.test.ts` — "shallower-drawdown symbol has a higher defensive score than deeper-drawdown symbol". Three symbols share identical realized-vol (same last-2 returns in volWindow=2), with different mid-series troughs at prices[4]: SHALLOW≈0%, NEUTRAL≈−22%, DEEP≈−48% (mddWindow=5). Before fix: SHALLOW.defensive=−0.354, DEEP.defensive=+0.707 (wrong). After fix: SHALLOW.defensive=+0.354, DEEP.defensive=−0.707 (correct).

---

## Fix 2 — In-flight cache dedup, thundering-herd (IMPORTANT)

**Files:**  
- `src/factor/FactorRankingService.ts`  
- `src/factor/FactorBacktestService.ts`

Both services now store the in-progress rebuild promise in `this.inflight`. Concurrent cold-cache misses await the same promise (set synchronously before the first `await` in the rebuild), so the sequential symbol fetch runs exactly once. The promise is cleared in a `try/finally` block on both success and failure, so a failed rebuild allows the next call to retry. Existing TTL-cache behavior is unchanged.

**Regression tests:**
- `src/factor/FactorRankingService.test.ts` — two concurrent `rank()` calls on cold cache: fetchCount=3 (not 6); subsequent call within TTL fetchCount=0.
- `src/factor/FactorBacktestService.test.ts` — two concurrent `run()` calls on cold cache: fetchCount=4 (not 8); subsequent call within TTL fetchCount=0.

---

## Fix 3 — Retry-After unbounded + NaN (IMPORTANT)

**File:** `src/toss/TossApiClient.ts`  
**Added constant:** `RETRY_DELAY_CAP_MS = 30_000`

Two bugs in the delay computation:
1. A large `Retry-After: 3600` produced a 1-hour sleep stalling the universe build.
2. An HTTP-date `Retry-After` (e.g. `Wed, 01 Jan 2026 00:00:00 GMT`) produced `Number(ra)=NaN` → `retryAfterSec=NaN` → `NaN !== undefined` was `true` → `sleep(NaN)` → immediate tight retry with no backoff.

Fix: guard with `Number.isFinite(ra)` (handles both `undefined` and `NaN`) then cap with `Math.min(base, RETRY_DELAY_CAP_MS)`. `http.ts` left unchanged — NaN is an acceptable input; the client now handles it correctly.

**Regression tests (`src/toss/TossApiClient.test.ts`):**
- `Retry-After: 3600` → delay clamped to ≤30,000 ms (not 3,600,000).
- `Retry-After: Wed, 01 Jan 2026 00:00:00 GMT` → delay finite >0 (exponential backoff, not NaN).

---

## Test Summary

| Before | After |
|--------|-------|
| 262 tests, 33 files | **269 tests, 33 files** |

New tests: +1 (FactorModel), +2 (FactorRankingService), +2 (FactorBacktestService), +2 (TossApiClient) = **+7**

`npx vitest run` → **269 passed (0 failed)**  
`npm run typecheck` → **clean (exit 0)**

---

## Live Ranking — New Top-5 (post defensive-sign fix)

| Rank | Symbol | Composite | Momentum | Defensive |
|------|--------|-----------|----------|-----------|
| 1 | 009150 | 1.946 | 3.057 | −0.277 |
| 2 | 000660 | 1.882 | 3.019 | −0.392 |
| 3 | 005930 | 1.318 | 1.887 | +0.180 |
| 4 | 066570 | 0.932 | 2.056 | −1.315 |
| 5 | 032830 | 0.813 | 1.038 | +0.361 |

*Universe: 40 symbols, 0 skipped.*

Note: The corrected defensive scores now show the expected spread — symbols with shallower drawdowns (e.g., 005930, 032830) have **positive** defensive scores while high-vol/deep-drawdown names score negative, consistent with the fix.

---

## Backtest Metrics (topN=5, rebalanceEvery=21)

| Metric | Value |
|--------|-------|
| Total Return | **+243.5%** |
| Max Drawdown | −2.23% |
| Rebalance Count | 12 |
| Final NAV | ₩34,346,583 |
| Universe | 40 symbols, 40 fetched, 0 skipped |
| Equity Curve Points | 12 |

---

## Commit

```
fix(factor): defensive drawdown sign + cache in-flight dedup + bounded 429 retry
```
