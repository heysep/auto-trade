# US Low-Frequency Momentum — Validation Research (Toss daily data)

**Date:** 2026-07-06
**Branch:** `feat/trading-ui`
**Mode:** Research only, read-only. No orders, no rebalance endpoints, live server on :3000 untouched. Data pulled with scratch scripts (`us_fetch.ts`, `us_fetch_deep.ts`) calling `TossApiClient.getCandles` directly.
**Question (sharpened):** Does any published, low-frequency, retail-implementable US strategy beat **buy & hold SPY** out-of-sample on a risk-adjusted basis, after 0.20% round-trip costs, and survive the short-sample noise band? Not "is it profitable" — "does it beat just owning SPY."

## Verdict: **NO-GO**

No strategy delivers genuine, credible out-of-sample alpha over buy & hold SPY.
- **Dual Momentum (GEM)** and **Absolute Momentum (TSMOM)** *significantly underperform* SPY OOS (excess-return t = -2.8 and -2.5).
- **Trend-following (Faber GTAA)** underperforms SPY on return and Sharpe OOS; its only virtue is a genuine, large drawdown reduction (-6.5% vs -23.7%), but it gives up ~half the return — fails the "comparable return, lower MDD" bar.
- **Cross-sectional 12-1 (Jegadeesh-Titman)** *appears* to beat SPY (CAGR 23.7% vs 16.9%) but the entire edge is a **survivorship-biased universe** (27 hand-picked 2026 mega-cap winners). Equal-weight holding the same basket with **no timing** beats the momentum strategy on Sharpe (1.03 vs 1.00), and even the *loser* decile beats SPY. Excess t-stat = 1.48 (not significant). Not a validated anomaly; not tradeable without a point-in-time broad universe we cannot reconstruct here.

**Honest recommendation: just buy and hold SPY.** These momentum/trend strategies are crisis *insurance* — they demonstrably protected in 2008 (in-sample), but the 2014-2026 out-of-sample window had only mild, fast-recovering drawdowns, so the insurance premium (lag + whipsaw) dominated. Costs are *not* the reason (only ~0.4-0.5%/yr); the lag is in the gross signal for this regime.

---

## 1. Data depth obtained (Toss `getCandles(sym,'1d',N)`)

Toss served **far deeper history than expected** — not ~2.4yr but 15-32 years for most symbols. Candles are **split-adjusted** (verified: AAPL 4:1 2020-08, NVDA 10:1 2024-06, TSLA 3:1 2022-08 all continuous) but **NOT dividend-adjusted / price-return only** (verified: BIL price CAGR ≈ 0.00%/yr over 19y, AGG ≈ -0.17%/yr — their yields are paid out and stripped from price).

| Sleeve / core (deep pull N=8000) | First month-end | Years | | Stock universe (N=4000) | First | Years |
|---|---|---|---|---|---|---|
| SPY | 1994-09 | 31.8 | | AAPL,MSFT,NVDA,AMZN,GOOGL | 2010-08 | 15.9 |
| QQQ | 1999-03 | 27.3 | | TSLA,JPM,V,UNH,JNJ,XOM,PG | 2010-08 | 15.9 |
| EFA | 2001-08 | 24.9 | | HD,MA,COST,MRK,AVGO,PEP | 2010-08 | 15.9 |
| TLT, IEF | 2002-07 | 24.0 | | KO,WMT,BAC,ADBE,CRM,LLY,SPGI | 2010-08 | 15.9 |
| AGG | 2003-09 | 22.8 | | META | 2012-05 | 14.1 |
| VNQ | 2004-09 | 21.8 | | ABBV | 2012-12 | 13.6 |
| GLD | 2004-11 | 21.6 | | **GPIQ** (user holding) | 2023-10 | 2.7 |
| DBC | 2006-02 | 20.4 | | | | |
| VEU | 2007-03 | 19.3 | | | | |
| SHV, BIL | 2007-01/05 | 19.5 | | | | |
| BND | 2007-04 | 19.1 | | | | |
| ACWX | 2008-03 | 18.3 | | | | |

All 44 requested symbols returned candles (0 failures). SGOV (2020-05) and GPIQ (2023-10) are too short to matter and were not used as strategy inputs. **This is a legitimate multi-regime sample** — the 2008 GFC, 2011, 2015-16, 2018-Q4, 2020 COVID, and 2022 bear are all present. It removes the "handful of rebalances" fear from the brief.

### Total-return reconstruction (important)
Because the data is price-only, a live trader's actual results (they *receive* dividends) are modeled by adding a constant per-asset annual dividend yield to each month's price return, forming a synthetic total-return index used for both signals and P&L:

`SPY 1.8% · QQQ 0.6% · EFA/VEU/ACWX 3.0% · AGG/BND 3.0% · TLT 3.3% · IEF 2.8% · VNQ 3.8% · GLD/DBC 0% · BIL/SHV 1.5% · stocks 1.3% flat`. Cash/T-bill leg modeled at a constant **0.35%/mo (~4.2%/yr)** (BIL's own price series is useless for this). **Direction of this choice:** it *helps* the defensive strategies (their bond/cash legs would otherwise look ~3-4%/yr worse). They still lose to SPY OOS → the NO-GO is robust to the assumption.

## 2. Protocol

- **Split by date:** earliest 60% of each strategy's tradeable months = train (tune here only); latest 40% = test (frozen config scored once). Each strategy is compared to buy & hold SPY over its **identical** window.
- **Parameter selection:** per family, frozen config = **argmax of TRAIN Sharpe**, enforced in code (`us_backtest.ts`), so selection cannot peek at test. **25 configs** evaluated across 4 families (GEM 9, GTAA 4, TSMOM 6, XSMOM 6). Multiple-testing acknowledged.
- **Costs:** 0.20% round-trip applied on every rebalance as `0.10% × Σ|Δweight|` (a full A→B switch = 0.20%). Turnover × cost quantified below.
- **Metrics:** CAGR, total return, MDD, Sharpe (rf 4%/yr), % in market (non-defensive weight), one-way turnover/yr, switches/yr, cross-sectional win-rate. Plus **excess-return series vs SPY**: annualized mean, **t-stat**, and **information ratio**.

## 3. Per-strategy results — STRAT vs buy & hold SPY (identical window)

Excess = monthly (strategy − SPY). t = t-stat of mean monthly excess; IR = annualized info ratio.

### 1) Dual Momentum — Antonacci GEM  · frozen: 12m→6m lookback, foreign = EFA, bond = AGG
| Window | Strat CAGR | Strat MDD | Strat Sharpe | SPY CAGR | SPY MDD | SPY Sharpe | Excess ann | t | IR |
|---|---|---|---|---|---|---|---|---|---|
| TRAIN 2002-03→2016-09 (175mo) | 10.8% | -14.3% | 0.66 | 6.6% | -51.0% | 0.24 | +3.4pp | 1.08 | 0.28 |
| **TEST 2016-10→2026-07 (118mo)** | **7.4%** | **-23.7%** | **0.31** | **15.5%** | **-23.7%** | **0.75** | **-7.7pp** | **-2.81** | **-0.90** |

In-sample GEM shone (it dodged the -51% GFC). OOS it **significantly lost to SPY** (t=-2.81) with *no* MDD benefit — the absolute filter whipsawed on the 2018-Q4 / 2020 / 2022 V-recoveries. Robust: L=12 variant also loses (t=-2.45).

### 2) Trend-following — Faber GTAA  · frozen: N=8-month SMA, sleeve = SPY/EFA/AGG/GLD/VNQ equal-weight
| Window | Strat CAGR | Strat MDD | Strat Sharpe | SPY CAGR | SPY MDD | SPY Sharpe | Excess ann | t | IR |
|---|---|---|---|---|---|---|---|---|---|
| TRAIN 2005-07→2018-01 (151mo) | 8.2% | -6.4% | 0.63 | 9.0% | -51.0% | 0.41 | -1.5pp | -0.44 | -0.12 |
| **TEST 2018-02→2026-07 (102mo)** | **7.6%** | **-6.5%** | **0.50** | **14.2%** | **-23.7%** | **0.65** | **-7.1pp** | **-1.55** | **-0.53** |

The **one genuine, robust result**: GTAA cuts drawdown enormously (-6.5% vs -23.7% OOS; -6.4% vs -51% in-sample). But it captures only ~half of SPY's return and its Sharpe is *lower* (0.50 vs 0.65). It does **not** "match SPY return with much lower drawdown" — it halves the return — so under the sharpened bar it is **NO-GO** (legitimate drawdown insurance for the extremely risk-averse, not an alpha or Sharpe improver). Robust across N=6/10/12 (all Sharpe 0.43-0.48 < SPY).

### 3) Cross-sectional 12-1 — Jegadeesh-Titman  · frozen: top-10, 12-1 lookback, monthly (27-stock universe)
| Window | Strat CAGR | Strat MDD | Strat Sharpe | Win | SPY CAGR | SPY Sharpe | Excess ann | t | IR |
|---|---|---|---|---|---|---|---|---|---|
| TRAIN 2011-10→2020-07 (106mo) | 28.7% | -17.7% | 1.45 | 64% | 14.8% | 0.81 | +12.0pp | 3.66 | 1.23 |
| **TEST 2020-08→2026-07 (72mo)** | **23.7%** | **-18.1%** | **1.00** | 55% | **16.9%** | **0.82** | **+6.4pp** | **1.48** | **0.60** |

The *only* config that beats SPY on paper OOS — but it is a **survivorship-bias artifact**, not a validated anomaly (see §4). t=1.48 is not significant, and the "edge" vanishes against the fair benchmark.

### 4) Absolute Momentum (TSMOM) — SPY  · frozen: 12m→6m lookback, threshold = rf, else cash
| Window | Strat CAGR | Strat MDD | Strat Sharpe | SPY CAGR | SPY MDD | SPY Sharpe | Excess ann | t | IR |
|---|---|---|---|---|---|---|---|---|---|
| TRAIN 1995-04→2013-12 (225mo) | 12.3% | -15.0% | 0.80 | 9.1% | -51.0% | 0.39 | +2.2pp | 0.84 | 0.19 |
| **TEST 2014-01→2026-07 (151mo)** | **6.7%** | **-27.1%** | **0.28** | **13.8%** | **-23.7%** | **0.68** | **-6.8pp** | **-2.53** | **-0.71** |

In-sample TSMOM beat SPY (dodged 2000 + 2008). OOS it **significantly lost** (t=-2.53) and even had a *deeper* drawdown than buy & hold. Robust: L=12 variants Sharpe 0.45-0.48 vs SPY 0.69 (t≈-1.9). The tuned short lookback overfit the crisis-heavy train.

## 4. Survivorship-bias probe (why XSMOM's OOS "win" is not real)

If cross-sectional momentum has real timing edge, top-N must beat simply *owning the basket*. It does not. TEST window 2020-08→2026-07:

| Portfolio (no look-ahead in timing) | CAGR | MDD | Sharpe |
|---|---|---|---|
| XSMOM top-10 (momentum timing) | 23.7% | -18.1% | 1.00 |
| **EW-hold all 27 stocks (zero timing)** | **20.6%** | -21.0% | **1.03** |
| XSMOM **bottom-10 (losers)** | 18.4% | -24.1% | 0.77 |
| Buy & hold SPY | 16.9% | -23.7% | 0.82 |
| User holdings EW (AAPL,LLY,GPIQ,SPGI) | 23.8% | -14.0% | 1.01 |

The universe is 27 stocks known *in 2026* to be mega-cap winners. Consequences: (a) equal-weighting the whole basket with **no timing** beats the momentum strategy on Sharpe (1.03 > 1.00); (b) even the *worst-momentum* decile of this basket (18.4%) beats SPY; (c) the user's own current holdings (23.8%) also "beat" SPY. When *everything* beats SPY, the universe — not the signal — is doing the work. A faithful JT test needs the point-in-time S&P constituent set (including the losers and the delisted), which cannot be built from this data. **Cross-sectional momentum is therefore un-validated here → NO-GO.**

## 5. Turnover / cost analysis (costs are NOT the problem)

| Strategy | one-way turnover/yr | switches/yr | annual cost drag | OOS lag vs SPY |
|---|---|---|---|---|
| GEM | 2.44 | 2.4 | ~0.49%/yr | -8.1pp/yr |
| GTAA | 2.02 | 6.4 | ~0.40%/yr | -6.6pp/yr |
| TSMOM | 2.07 | 2.1 | ~0.41%/yr | -7.1pp/yr |
| XSMOM | 1.93 | 11.0 | ~0.39%/yr | +6.8pp (bias) |

Cost drag ≈ `0.20% × one-way-turnover`. All ~0.4-0.5%/yr — an order of magnitude smaller than the 6-8pp/yr OOS return gap. Unlike the KR intraday case (where 0.23-0.28% costs killed a 0.12% signal), **here costs are immaterial**; the defensive strategies simply lag SPY on the gross signal in this bull regime, and XSMOM's gross "edge" is universe selection.

## 6. Sample-size & honesty caveats

- Depth is good (test windows 72-151 months across 2013/2016/2018/2020 → 2026), so this is **not** the "handful of rebalances" case. But the OOS window contains **no 2008/2000-scale bear** — exactly the environment where trend/dual-momentum earn their keep. The strategies protected massively *in-sample* (GTAA MDD -6.4% vs SPY -51%). So a fairer statement than "they don't work" is: **they are crisis insurance whose premium dominated in a benign OOS decade.** They are *not* an alpha source over SPY.
- 25 configs tried (multiple testing); frozen by train-Sharpe only. None of the defensive picks survived OOS, and the survivor (XSMOM) is bias-explained.
- Excess t-stats: GEM -2.81, TSMOM -2.53 are significantly *negative*; GTAA -1.55 negative; XSMOM +1.48 not significant. Nothing crosses +2.
- Price-vs-total-return handled by a dividend-yield reconstruction that *favors* the defensive legs; conclusion unchanged.

## 7. If (and only if) the user's utility is extreme drawdown aversion

The single defensible non-SPY option is **Faber GTAA N=8** as *drawdown insurance*, stated honestly: OOS it delivered ~half of SPY's return (7.6% vs 14.2%) for roughly a quarter of the drawdown (-6.5% vs -23.7%) and a *lower* Sharpe. That is a risk-preference trade, not alpha. It is **not recommended as a GO** under the "beat SPY" bar.

## 8. Recommended frozen config

**None. NO-GO. Recommendation: buy & hold SPY.**

(For completeness, had a GO been warranted, the least-bad candidate rules would have been: universe SPY/EFA/AGG/GLD/VNQ equal-weight; monthly at month-end, hold each asset whose total-return index > its trailing 8-month SMA else that 20% sleeve → cash at ~4.2%/yr; ~0.4%/yr cost. But it fails the beat-SPY test OOS and is not adopted.)

---

### Reproducibility (read-only scratch scripts, repo root)
- `us_fetch.ts` / `us_fetch_deep.ts` — pull & cache daily candles via `TossApiClient` (cache: `…/scratchpad/research_us/cache`).
- `us_datacheck.ts` — split/dividend-adjustment verification.
- `us_engine.ts` — month-end resample, total-return reconstruction, metrics.
- `us_strats.ts` — GEM / GTAA / TSMOM / XSMOM / EW-hold factories, run/split/excess helpers.
- `us_backtest.ts` — train-only selection (argmax train Sharpe) + frozen test.
- `us_robust.ts` — STRAT-vs-SPY excess t-stat/IR, parameter perturbation, survivorship probe, holdings reference.
