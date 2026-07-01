# Task 11.5 Report — Reconcile market-data code with live Toss API

**Date:** 2026-07-01  
**Branch:** `feat/trading-ui`

---

## Summary

Reconciled `/api/v1/stocks` and `/api/v1/candles` with the confirmed Toss OpenAPI spec. Replaced guessed field names/params with real ones; added a static KRX symbol catalog; normalised candles to a UI-ready `ChartCandle` type with epoch-second timestamps and numeric OHLC.

---

## Files Changed

| File | Change |
|------|--------|
| `src/toss/types.ts` | Replaced `TossStock` (added `englishName?`, `currency?`); replaced `TossCandle` (real fields: `timestamp`, `openPrice`, `highPrice`, `lowPrice`, `closePrice`, `volume?`); added `TossCandlePage`; added `ChartCandle` |
| `src/toss/TossApiClient.ts` | `getStocks(symbols: string[])` — requires explicit `symbols` param; `getCandles(symbol, interval: '1m'|'1d', count=200)` — unwraps `TossCandlePage.candles`; removed ⚠️ comments; added confirmed-2026-07 notes |
| `src/toss/TossApiClient.test.ts` | Updated for new signatures and `TossCandlePage` response shape; added URL-check test for `getStocks` |
| `src/market/krxSymbols.ts` | **New** — static list of 40 well-known KRX stocks (6-digit symbol, Korean name, market `KR`) |
| `src/app/TradingSystem.ts` | `getCandles` dep narrowed to `'1m'|'1d'`; `candles()` now returns `Promise<ChartCandle[]>` by mapping `TossCandle`→`ChartCandle`; `backtest()` uses `ChartCandle[]`, sorts ascending, deduplicates timestamps; removed `parseNum` import |
| `src/api/server.ts` | Candle route: validates `interval ∈ {'1m','1d'}` → 400; defaults to `'1d'`; dashboard HTML: candle fetch adds `&interval=1d`; `setData` mapping uses numeric `ChartCandle` fields (no string coercion) |
| `src/index.ts` | `SymbolCatalog` now backed by `async () => KRX_SYMBOLS` (static list); `getCandles` dep properly typed |
| `src/api/server.test.ts` | Updated `TossCandle` fixtures to new shape; candle response assertions check `ChartCandle` (numeric close); added interval validation test (`5m` → 400); added `interval=1m` acceptance test |
| `docs/toss-api-spec.md` | Added §9 marking `/stocks` (needs `symbols`) and `/candles` (`interval` 1m/1d, real response shape) as ✅ CONFIRMED (openapi.json 2026-07) |

---

## Test Results

```
Test Files  28 passed (28)
     Tests  168 passed (168)
```

Typecheck: `tsc --noEmit` — clean (0 errors).

---

## Live Verification (server run: `npx tsx src/index.ts`)

### `curl 'http://127.0.0.1:3000/api/market/symbols?q=삼성'`

**Result: SUCCESS**

Returned 6 matching entries from the static KRX catalog including:
```json
[
  {"symbol":"005930","name":"삼성전자","market":"KR","englishName":"Samsung Electronics"},
  {"symbol":"207940","name":"삼성바이오로직스","market":"KR","englishName":"Samsung Biologics"},
  ...
]
```

### `curl 'http://127.0.0.1:3000/api/market/candles?symbol=005930&interval=1d'`

**Result: SUCCESS — non-empty `ChartCandle[]` from live Toss API**

Sample:
```json
[
  {"time":1782831600,"open":336000,"high":340000,"low":311500,"close":314500},
  {"time":1782745200,"open":325500,"high":343000,"low":321000,"close":333000},
  ...
]
```

`time` values are epoch seconds (e.g. `1782831600`); OHLC are numbers. Toss returned 200+ candles.

### `curl 'http://127.0.0.1:3000/api/market/candles?symbol=005930&interval=5m'`

**Result: Correct 400 rejection**

```json
{"error":"interval must be '1m' or '1d'"}
```

HTTP 400.

---

## Key Design Decisions

1. **No Toss-backed symbol search**: `GET /api/v1/stocks` requires explicit `symbols` — there is no list-all/search endpoint. Curated static KRX list of 40 stocks ships as `src/market/krxSymbols.ts`; `SymbolCatalog` caches and searches it locally.

2. **Candle normalisation at the system boundary**: Raw `TossCandle` (string fields, ISO timestamp) is kept in the Toss layer; `TradingSystem.candles()` maps to `ChartCandle` (numeric, epoch seconds). The HTTP API surface and backtest engine both receive pre-normalised values.

3. **Sort + dedup in backtest**: Toss candles may arrive newest-first; `TradingSystem.backtest()` sorts ascending and deduplicates by `time` before feeding `BacktestEngine.validateBars()` (which requires strictly increasing `ts`).
