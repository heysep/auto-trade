# Trading UI + Strategy Composer — Design

Date: 2026-07-01
Branch: `feat/trading-ui` (builds on the `feat/trading-platform` core)

## Goal

Replace the minimal read-only dashboard with a TradingView-style interface where the
operator can: (1) search and pick any Toss symbol, (2) view its candlestick chart with
strategy signals overlaid, (3) compose two strategies with AND/OR into a single symbol,
(4) backtest the composite and preview signals/metrics on the chart, then (5) deploy it to
run in the live paper pipeline.

Non-goals (YAGNI): new indicator types beyond the existing two (RSI/Bollinger later),
multi-symbol composites, capital-weighted portfolios, real (non-paper) trading from the UI.

## 1. Strategy signal model (core refactor)

Composition requires a **position-independent signal**, so strategies stop returning
position-aware order intents directly and instead emit a per-tick signal.

```ts
type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
interface SignalStrategy { id; symbols; currency; mode; signal(quote): Signal; serialize?/deserialize?; }
```

- `ThresholdStrategy.signal`: `last <= buyBelow → BULLISH`, `last >= sellAbove → BEARISH`, else `NEUTRAL`.
- `MovingAverageCrossStrategy.signal`: `fast > slow → BULLISH`, `fast < slow → BEARISH`, else `NEUTRAL`
  (keeps the internal price window; NEUTRAL until warm).
- `CompositeStrategy(a, b, combine: 'AND' | 'OR')`:
  - AND: `BULLISH` iff both BULLISH; `BEARISH` if either BEARISH; else `NEUTRAL`.
  - OR: `BULLISH` if either BULLISH; `BEARISH` iff both BEARISH; else `NEUTRAL`.

A shared **SignalToIntent adapter** turns `(signal, currentPosition)` into an `OrderIntent | null`
(the existing state-targeting rule): BULLISH + flat → BUY sized from `orderNotional`; BEARISH +
long → SELL held; else null. `StrategyEngine`/`BacktestEngine` call the adapter, so the
"want-long iff signal is BULLISH" behavior and all order sizing/retry logic are reused unchanged.

Backward compatibility: the current `Strategy.evaluate(ctx)` becomes a thin wrapper
`adapter(this.signal(ctx.quote), ctx.position)`, so existing engine/backtest wiring and tests
keep working while composition reuses `signal()`.

### StrategySpec + factory (dynamic creation / persistence)

```ts
type StrategySpec =
  | { type: 'threshold'; params: { buyBelow; sellAbove; orderNotional } }
  | { type: 'sma'; params: { fastPeriod; slowPeriod; orderNotional } }
  | { type: 'composite'; combine: 'AND' | 'OR'; a: StrategySpec; b: StrategySpec; orderNotional };
```

`buildStrategy(id, symbol, currency, mode, spec): SignalStrategy` — a factory the API uses to
create strategies from JSON. Specs are serializable, so deployed strategies persist via the
existing `FileStatePersistence` (add specs to the snapshot; rebuild on boot via the factory).

Sizing: the order is sized from the TOP-LEVEL spec's `orderNotional` only. A nested sub-spec's
`orderNotional` is used only when that sub-strategy runs standalone; inside a composite it is
ignored (the composite drives a single combined position sized by `composite.orderNotional`).

## 2. Backend (new Fastify endpoints over TossApiClient)

- `GET /api/market/symbols?q=<query>` — searches the Toss stock master (`GET /api/v1/stocks`,
  cached in-memory with a TTL). Returns `{symbol, name, market}` matches.
- `GET /api/market/candles?symbol=&interval=` — proxies `GET /api/v1/candles`; normalizes to
  `{time, open, high, low, close}[]` for lightweight-charts.
- `POST /api/backtest` — body `{symbol, spec, interval, capital}`. Fetches candles, builds the
  strategy via the factory, runs `BacktestEngine` → `{metrics, equityCurve, markers}` where
  markers are `{time, side, price}` for chart overlay.
- `POST /api/strategies` — body `{symbol, spec, name}`. Builds the strategy, assigns the next id,
  registers it in `StrategyEngine` + `StrategyRegistry` (status `PAPER_TESTING`), adds its symbol
  to the watch list, and persists the spec. It then runs in the paper pipeline like the seeded
  strategies. `DELETE /api/strategies/:id` unregisters + removes.

`TossApiClient` gains `getStocks()` and `getCandles(symbol, interval)` (paths per
`docs/toss-api-spec.md` §3; confirm exact params against the live probe before wiring).

## 3. Frontend (single page, vanilla + TradingView lightweight-charts via CDN)

Fastify serves one HTML page (extending the current dashboard route). No build step.

```
┌ symbols ────────┬──────────── candlestick chart ─────────────────────┐
│ search box      │   lightweight-charts: candles + SMA lines +         │
│ result list     │   BUY/SELL markers (from backtest or live)          │
│ (Toss stocks)   │                                                     │
├─────────────────┼── strategy builder ─────────────────────────────────┤
│ positions / P&L │  [strategy A ▾ params] [AND|OR] [strategy B ▾ params]│
│ logs            │  [Backtest] → metrics panel + markers                │
│ halt + E-STOP   │  [Deploy to paper]                                   │
└─────────────────┴──────────────────────────────────────────────────────┘
```

Interactions:
1. Search → pick symbol → `GET /candles` → render chart.
2. Configure builder → `POST /backtest` → overlay markers + show metrics (return, MDD, win%, PF).
3. `Deploy` → `POST /strategies` → strategy joins the paper pipeline; poll `/positions`,`/logs`
   and (during market hours) `/market/prices` to update the chart's last price + position marker.

All API values are HTML-escaped before DOM insertion (existing XSS guard extended).

## 4. Data flow

```
symbol pick ─▶ /candles ─▶ chart
builder ─▶ /backtest ─▶ markers + metrics
deploy ─▶ /strategies ─▶ engine registers ─▶ paper fills ─▶ /positions,/logs poll ─▶ chart
```

## 5. Components & boundaries

- `strategy/signal.ts` — `Signal`, `SignalToIntent` adapter.
- `strategy/CompositeStrategy.ts` — AND/OR combiner.
- `strategy/strategySpec.ts` — `StrategySpec` + `buildStrategy` factory.
- Refactored `ThresholdStrategy`/`MovingAverageCrossStrategy` — add `signal()`, keep `evaluate()`
  as adapter wrapper.
- `market/SymbolCatalog.ts` — cached Toss stock master + search.
- `api/server.ts` — new routes; dashboard HTML expands into the composer UI.
- `app/StrategyDeployer` (or `TradingSystem` methods) — register/unregister a spec-built strategy
  into the running engine + registry + watch list + persistence.

## 6. Testing

- `signal()` per strategy (tri-state boundaries incl. equality).
- `CompositeStrategy` AND/OR truth tables.
- `SignalToIntent` adapter (flat+BULLISH→BUY, long+BEARISH→SELL, integer qty).
- `buildStrategy` factory (each spec type, nested composite, invalid spec rejected).
- API: `/symbols` search (mock catalog), `/candles` shape, `/backtest` returns markers/metrics,
  `/strategies` deploy registers + appears in `/strategies`, `DELETE` removes.
- Persistence: a deployed composite spec survives restart (round-trips through the snapshot).
- Existing 101 tests stay green (evaluate-wrapper keeps behavior).

## 7. Phased implementation

1. **Signal refactor + composite + spec/factory** (pure, fully unit-tested; no UI).
2. **Backend endpoints** (symbols, candles, backtest) + `TossApiClient` methods.
3. **Frontend**: symbol picker + chart + backtest preview (read-only value first).
4. **Deploy**: dynamic strategy registration + persistence + live overlay.

## 8. Constraints / notes

- Toss `/candles` + `/stocks` exact params/shape are ⚠️ in `docs/toss-api-spec.md` — confirm via
  the live probe before wiring; the endpoints degrade to empty results if unavailable.
- Backtest uses historical candles (works when market closed); live overlay only updates during
  market hours (session gate).
- Deploy is PAPER only. LIVE remains behind the promotion gate + manual approval.
