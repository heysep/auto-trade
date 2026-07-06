# KRX Day-Trading Strategy Research — ₩100,000 Account (Toss API data)

**Date:** 2026-07-06 · **Branch:** `feat/trading-ui` · **Author:** quant research pass
**Verdict:** ## 🔴 NO-GO — nothing survives honest out-of-sample + realism scrutiny. Recommend staying on paper.

> Scope: research only. No production code, no server actions, no orders. All data pulls were
> read-only via `TossApiClient` directly. The LIVE-armed server was not touched.

---

## 1. Data

- **Source:** `TossApiClient.getCandles(symbol, '1d', 500)` for all 42 names in `KRX_SYMBOLS`.
- **Universe:** 42 KRX large/mid-caps (`src/market/krxSymbols.ts`).
- **Daily bars:** 500 per symbol, **2024-06-14 → 2026-07-06**, `{open,high,low,close,volume}` all present
  (volume confirmed on the raw client). Cached to
  `scratchpad/research/cache/<symbol>.json` so reruns don't refetch.
- **Incomplete-bar guard:** 2026-07-06 was still an open session at fetch time (1m data ran to 14:05),
  so that bar is **dropped**. Effective series = **499 complete bars** per symbol, last = **2026-07-03**.
  All 42 symbols share an identical date index (verified — no misalignment/halts).
- **Intraday depth probe:** `'1m'` history returns **only ~4 trading days** (2000 bars = 4 days).
  → **ORB (family 4) is INFEASIBLE** — cannot get ≥30 days of intraday data. Dropped.

### Budget reality (₩100,000)

The budget filter `floor(100000/price) ≥ 1` (price ≤ ₩100k) removes a large slice of the universe:

- **Avg affordable names/day:** 16.1 of 42.
- **Ever affordable in window:** 24 of 42.
- **NEVER affordable (price > ₩100k the whole window, 18 names):** 삼성전자 (₩312k), SK하이닉스,
  LG에너지솔루션, 삼성바이오로직스, 현대차, 셀트리온, NAVER, POSCO홀딩스, LG화학, 삼성SDI, 현대모비스,
  삼성물산, SK, 삼성에스디에스, 삼성전기, 고려아연, 삼성화재, NC소프트, 하이브.

The tradeable set therefore skews to cheaper, higher-volatility names (HMM, 카카오, 위메이드,
카카오게임즈, 에코프로, 넷마블, SM…). This is the correct universe to measure the edge on, but note it
is small and volatility-heavy — which is exactly where extreme gap events (below) live.

**Additional real-world drag not modelled:** with a ₩100k slot and share quantization, a ₩90k stock buys
1 share and leaves ₩10k idle; per-trade % returns overstate account returns. This can only *reduce*
realized returns, so it reinforces (never reverses) the verdict below.

## 2. Protocol

- **Split by date:** train = first 60% (indices 20–298, **2024-07-12 → 2025-09-04**, 279 signal-days
  after 20-bar warmup); test = last 40% (indices 299–498, **2025-09-05 → 2026-07-03**, 200 days).
- **Tuning** on train only; frozen config scored **once** on test.
- **Costs:** breakout (entry at intraday target) **0.23%** round trip; open-entry strategies
  (gap-down, momentum) **0.28%** round trip.
- **Fills:** breakout entry = `max(target, open)` (can't fill below the open — removes free-money
  optimism) when `high ≥ target`, exit at close. Open strategies enter at the day's open, exit at close.
- **One slot/day** across the whole universe. Multiple signals → deterministic tie-break, tested for
  sensitivity: `best` (strongest signal), `worst` (weakest), `alpha` (alphabetical symbol).
- **Metrics:** trades, win%, avg/trade, total return (compounded, full-slot), MDD, profit factor,
  t-stat = mean/std·√n of per-trade returns.

Scripts: `scripts/research/{engine,strategies,train,test,realism,verify-bars}.ts`.

## 3. Train results (compact)

### Family 1 — Filtered volatility breakout (target = open + K·prevRange)

Swept K ∈ {0.3, 0.5, 0.7, adaptive-noise} × minRange ∈ {0,1,2,3,5,8%} × {trendMA20, MA5>MA20,
gapGuard, volConfirm} and combos. **Essentially everything loses after costs.** Representative rows:

| config | n | win | avg/trade | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|
| K=0.5 minR=0 (bare) | 279 | 39% | −0.23% | −56% | −70% | 0.81 | −0.99 |
| K=0.5 minR=5% trendMA20 | 81 | 49% | +0.04% | −2.5% | −18% | 1.03 | 0.10 |
| K=adaptive minR=2% MA5>MA20 | 250 | 37% | −0.48% | −73% | −75% | 0.65 | −2.40 |
| K=0.7 minR=8% (only positive) | 10 | 40% | +0.27% | +2.3% | −6% | 1.27 | 0.30 |

The single positive config has **n=10, t=0.30** — noise. Filters shrink losses but never manufacture a
significant edge. **NO-GO — not carried to test.** (Confirms the prior K-breakout finding: costs kill it.)

### Family 3 — Momentum continuation (prior strong up-day → buy today's open)

Swept R ∈ {3,5,7,10%} × {nearHigh, volSpike, open-confirm}. **Every config negative.** Best was
R=0.07 nearHigh (n=44, −6.8%, pf 0.97, t=−0.08). **NO-GO — not carried to test.**

### Family 2 — Gap-down mean reversion (open gaps down ≥ G% → buy open, exit close)

This is the only family that lit up on train. Trend and volume filters **hurt** it (fewer trades, lower
return), so the promising branch is raw gap-down:

| config | n | win | avg/trade | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|
| G=2% noTrend | 65 | 57% | +1.27% | +96% | −30% | 2.18 | 1.38 |
| G=3% noTrend | 33 | 58% | +2.82% | +121% | −20% | 4.37 | 1.66 |
| G=4% noTrend | 12 | 75% | +8.66% | +148% | −1% | 44.9 | 2.15 |
| G=2% +trend | 42 | 45% | +0.74% | +27% | −22% | 1.58 | 0.78 |
| G=2% +trend+vol | 19 | 26% | −1.65% | −28% | −28% | 0.27 | −2.37 |

Note the tell: as G rises, n collapses and avg/trade explodes (+8.66% on n=12, +16% on n=5) — the
"edge" is concentrating into a few extreme days, not broadening. **Carried to test** as the sole survivor,
with a pre-specified frozen primary **G=2%, noTrend, no-vol** (max trade count → best chance of a
statistically evaluable test), plus G=2.5% / 3% as stricter variants.

## 4. Test results (frozen) + honesty checks — Family 2

### 4a. Headline (looks spectacular…)

| config | pick | n | win | avg | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|---|
| **G=2% (primary)** | best | 39 | 74% | +4.89% | **+399%** | −17% | 5.68 | **2.36** |
| G=2% | worst | 39 | 64% | +2.33% | +110% | −24% | 2.62 | 1.48 |
| G=2% | alpha | 39 | 59% | +2.60% | +122% | −23% | 2.59 | 1.42 |
| G=3% | best | 25 | 72% | +6.48% | +279% | −17% | 5.44 | 2.07 |

**Tie-break sensitivity already fires a warning:** t drops 2.36 → 1.42–1.48 and PF 5.68 → ~2.6 when you
pick a different symbol on multi-signal days. The edge is not tie-break-stable.

### 4b. …but it is a fat-tail / data-artifact mirage

**P&L concentration (primary, best):** top-3 trades = **71%** of total P&L, top-5 = **91%**.

| remove | n | total | MDD | PF | t |
|---|---|---|---|---|---|
| drop best 1 | 38 | +234% | **−34.5%** | 4.47 | 2.11 |
| drop best 3 | 36 | +62% | **−34.5%** | 2.34 | 1.60 |

Removing the luckiest trades pushes **MDD to −34.5%** (breaks the −25% bar) — the monster wins were
papering over the drawdown.

**Decomposition by gap magnitude (primary, best, test):**

| gap bucket | n | avg | total | PF | t |
|---|---|---|---|---|---|
| 2–5% | 34 | +0.57% | +17% | 1.43 | 0.73 |
| 5–8% | 9 | +0.97% | +8% | 1.73 | 0.59 |
| 8–12% | 1 | +21.8% | +22% | ∞ | — |
| **12–30%+** | **3** | **+45.4%** | **+207%** | ∞ | 27.59 |

**The entire edge is 3 trades in the 12–30% gap bucket** (t=27.59 on n=3 is meaningless — three
near-identical +43–49% outcomes). Inspecting the raw bars (`verify-bars.ts`):

- **위메이드 2025-12-29:** prev close 25,300 → open **17,650 (−30.2%, limit-down 하한가)** → close 25,350
  (**+43.6% open→close**). Real bar, but a locked −30% opening auction; a retail market-buy at ₩17,650 is
  not reliably fillable, and 0.28% slippage is fantasy for a limit-down auction.
- **위메이드 2026-01-13:** open **19,600 (−29.5%)** → close 29,350 (**+49.7%**). Same story, same stock,
  2 weeks later — one idiosyncratic name, not a statistical edge.
- **KT 2026-02-06:** open **39,300 (−30.1%)** lone outlier between prev close 56,200 and same-day close
  56,500 (H=56,900), volume only ~1.4× normal. A blue-chip telecom does **not** gap −30% and fully recover
  intraday on modest volume. **Almost certainly a phantom/erroneous opening print** — the strategy "buys"
  a price that never truly traded.

### 4c. Realistically-tradeable band (exclude gaps > maxG = limit-down / phantom)

Restricting to gaps that can actually be filled (2–10%) removes the mirage — and the edge with it:

| config | window | n | win | avg | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|---|
| G=2%, maxG=10% | **TRAIN** | 63 | 56% | +0.07% | **+1.6%** | −30% | **1.06** | **0.19** |
| G=2%, maxG=10% | TEST best | 38 | 71% | +1.03% | +42% | −20% | 1.94 | 1.42 |
| G=2%, maxG=10% | TEST worst | 38 | 63% | +1.09% | +40% | −24% | 1.74 | **1.07** |
| G=3%, maxG=10% | TRAIN | 31 | 55% | +0.48% | +14% | −20% | 1.54 | 0.87 |
| G=3%, maxG=10% | TEST best | 22 | 68% | +0.42% | +7% | −21% | 1.25 | 0.40 |

The tradeable band has **essentially zero in-sample edge** (train pf 1.06, t=0.19). Its test "edge"
(t=1.42) is (a) below the 1.5 threshold, (b) tie-break-fragile (t→1.07 on worst-pick), and (c) built with
no train support — i.e. indistinguishable from luck in the 40% test window.

## 5. Verdict

**NO-GO — all families. Recommend staying on paper.**

| family | outcome | why |
|---|---|---|
| 1. Filtered volatility breakout | **NO-GO** | Every train config loses after 0.23% costs; only positive is n=10/t=0.30. Confirms prior finding. |
| 2. Gap-down mean reversion | **NO-GO** | Raw version's +399% test = 3 extreme-gap trades (2 unfillable −30% limit-down recoveries + 1 KT phantom-open artifact); 71% of P&L in top-3; MDD → −34.5% without them. Tradeable band (gaps 2–10%): train pf 1.06 / t 0.19, test t 1.42→1.07 (fails t≥1.5 and tie-break check). |
| 3. Momentum continuation | **NO-GO** | Every train config negative. |
| 4. ORB (intraday) | **INFEASIBLE** | Toss `'1m'` history only ~4 trading days; cannot build ≥30-day sample. |

**Verdict-rule scorecard for the best gap-down candidate** (raw G=2%, the one that looks like a GO):

| rule | threshold | result | pass? |
|---|---|---|---|
| positive test return | > 0 | +399% | ✅ (but see below) |
| ≥30 test trades | ≥ 30 | 39 | ✅ |
| profit factor | ≥ 1.3 | 5.68 | ✅ |
| t-stat | ≥ ~1.5 | 2.36 best / **1.42 alpha** | ❌ fragile |
| MDD bearable | ≥ −25% | −17% (raw) / **−34.5%** (ex-top-3) | ❌ |
| tie-break survives | best≈worst | 2.36 → 1.42–1.48 | ❌ |
| realistic & non-artifact | — | edge = 3 limit-down/phantom trades | ❌ |

It fails the moment you require the edge to be tie-break-stable, drawdown-bearable without its luckiest
trades, and built from *fillable, non-artifact* prices. The honest read: **no daily-bar intraday edge on
this universe survives 0.23–0.28% round-trip costs.** The gap-down family is worth remembering only as a
"panic-day reversion" *observation*, not a deployable ₩100k strategy — and even that observation rests on
prices you cannot actually transact.

## 6. Recommendation & implementation notes

- **Do not deploy.** Keep the daytrade path in paper mode. There is no frozen config to hand off.
- **Do not chase the gap-down mirage** by loosening `maxG` — that just re-admits the unfillable
  limit-down/phantom trades that create the illusion.
- **Data hygiene for any future work:** add an opening-print sanity filter (reject bars where
  `open` deviates > ~20% from both prev close and same-day high/close with only modest volume — the KT
  2026-02-06 pattern) before any gap logic touches live orders.
- **If revisiting gap-down seriously:** it needs (a) true intraday fill data (the auction/limit-order-book,
  not daily O/H/L/C) to know whether a −5%+ gap-down open is actually buyable, (b) a much longer history so
  the 30-day 1m limit isn't binding, and (c) realistic auction slippage (≫0.28%) on gap opens. None of
  that is available from the Toss daily API today.
- **Cost math to internalize:** at 0.23–0.28% round trip, a strategy trading ~1×/day needs a per-trade
  edge > ~0.28% just to break even. Breakout/momentum here average −0.2 to −0.5%/trade — structurally
  underwater. Frequent daily-bar day-trading on this ₩100k universe is a negative-expectation game.
