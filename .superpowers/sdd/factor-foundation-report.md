# AQR Factor-Scoring Foundation — Implementation Report

## Status
COMPLETE — all gates passed.

## Files Created
- `src/factor/standardize.ts` — cross-sectional standardization (winsorize, zscore, sectorNeutralize)
- `src/factor/priceFactors.ts` — price-based raw factors (momentum12_1, realizedVol, maxDrawdown)
- `src/factor/standardize.test.ts` — 11 tests
- `src/factor/priceFactors.test.ts` — 11 tests

## Test Results
- `npx vitest run src/factor`: **22/22 passed** (2 new test files)
- `npx vitest run` (full suite): **187/187 passed** (165 pre-existing + 22 new)
- `npm run typecheck`: **clean** (zero errors/warnings under strict mode with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`)

## TDD Sequence
1. Wrote both test files first — confirmed RED (module-not-found errors, both test suites failed)
2. Wrote `standardize.ts` then `priceFactors.ts` — all 22 tests turned GREEN
3. Full suite and typecheck verified clean before commit

## Key Implementation Decisions

### standardize.ts
- `winsorize`: sorts a copy, picks bounds via `Math.floor((n-1)*pct)` index, clamps with `Math.min/Math.max`. Uses `!` assertion on sorted-array access — provably safe because n≥2 is checked and indices are within `[0, n-1]`.
- `zscore`: population std (`sqrt(mean((x-mean)²))`); returns `Array(n).fill(0)` for n<2 or std===0.
- `sectorNeutralize`: two-pass Map accumulation (sums/counts → means). Uses `undefined` guards instead of `!` for `noUncheckedIndexedAccess` compliance on the index loop.

### priceFactors.ts
- `momentum12_1`: single-line formula after length and denominator guards. Accepts any `recentSkip < longLookback` combination; returns null for zero/negative denominator.
- `realizedVol`: slices the last `window` returns via `t = n-window … n-1`; population std of those returns. Returns null for zero/negative prev price.
- `maxDrawdown`: `prices.slice(n-window)` + running-peak loop; returns null for slice < 2 prices. Implemented **independently** of `src/performance/PerformanceAnalyzer.ts` — same algorithm but takes raw price series (not NAV), applies a `window` parameter, and returns `null` instead of `0` on insufficient data.

## Concerns
- None critical. One design note: `realizedVol` returns `null` if any price in the window is ≤ 0 (zero/negative price mid-series). This is a conservative guard; callers with guaranteed-positive price data can rely on non-null output when n > window.
- `momentum12_1` does not guard `prices[n-1-recentSkip]` being undefined when `recentSkip >= n`. This edge case cannot occur with default `recentSkip=21` < `longLookback=252` and the `n > longLookback` guard, but callers passing a larger `recentSkip` than `n-1` could hit a null return (the undefined check handles this gracefully — returns null rather than crashing).
