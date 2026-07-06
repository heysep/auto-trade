# KRX INTRADAY Day-Trading Strategy Research — ₩100,000 Account (Toss 1m bars)

**Date:** 2026-07-06 · **Branch:** `feat/trading-ui` · **Author:** quant research pass (intraday follow-up)
**Verdict:** ## 🔴 NO-GO — no intraday family produces a positive out-of-sample edge after costs. Stay on paper.

> Scope: research only, read-only. All data pulled via `TossApiClient` directly with scratch scripts
> (candle/trades reads only — never the order path). The LIVE-armed server on :3000 was **not touched**
> (no kill/restart, no order/rebalance endpoints). Follows up the daily-bar NO-GO in
> `2026-07-06-krx-daytrade-research.md` at 1-minute resolution.

---

## 1. Data

### 1.1 Order-flow / `/trades` availability (probed first)
`GET /api/v1/trades` is **recent-only**, confirmed by live probe:
- `?symbol=005930` → returns exactly the **50 most-recent** trades `{price, volume, timestamp, currency}`.
- `&count=200` / `&count=1000` → **HTTP 400** (count not supported).
- `&from=…&to=…` and `&startTime=…&endTime=…` → **ignored** (returns the identical 50 latest ticks).

→ **Historical ticks / 체결강도 (real order-flow) are NOT obtainable.** Order-flow signals were therefore
derived from 1m bars: (a) **거래대금** = volume×close and its surge vs a trailing 20-bar mean; (b) intrabar
**buy-pressure** = (close−low)/(high−low); (c) **up/down volume** via buy-pressure×volume runs;
(d) intraday **VWAP** = cumsum(vol×typical)/cumsum(vol). This is the honest ceiling of what Toss exposes.

### 1.2 1m candle depth (the enabling finding)
`getCandles(sym,'1m',40000)` paginates deep: **40,000 bars/symbol** in ~50s.
- Bars span **08:00–20:00 KST** = KRX regular **+ NXT (Nextrade) extended/overnight** sessions.
- Filtered to the **regular continuous session 09:00–15:19** (the 15:20–15:30 closing auction is excluded;
  15:19 is the forced EOD-exit bar). ≈ **380 regular bars/day ≈ complete** (379 possible minutes). Volume present.
- Per-symbol depth: 10 names reach **56 trading days (2026-04-14 → 2026-07-06)**; 카카오 and 카카오게임즈
  reach 103 days (fewer extended-hours bars per day). **Common window used = 56 trading days, all 12 symbols.**

### 1.3 Universe (budget + liquidity filtered)
The ₩100,000 budget filter (`floor(100000/price) ≥ 1`, i.e. price ≤ ₩100k) removes ~18 of the 42
`KRX_SYMBOLS`. I pulled the **12 most-liquid affordable names deep** rather than all 42 shallow (fetch cost
~50s/symbol; caching makes reruns free). Turnover-ranked:

| symbol | name | ~price | shares/₩100k | 20-bar turnover |
|---|---|---|---|---|
| 086520 | 에코프로 | 84,700 | 1 | highest |
| 017670 | SK텔레콤 | 84,400 | 1 | |
| 316140 | 우리금융지주 | 30,950 | 3 | |
| 035720 | 카카오 | 35,650 | 2 | |
| 096770 | SK이노베이션 | 96,500 | 1 | |
| 011200 | HMM | 19,260 | 5 | |
| 047050 | 포스코인터내셔널 | 49,650 | 2 | |
| 030200 | KT | 54,400 | 1 | |
| 112040 | 위메이드 | 19,890 | 5 | |
| 041510 | SM엔터 | 77,500 | 1 | |
| 251270 | 넷마블 | 38,200 | 2 | |
| 293490 | 카카오게임즈 | 7,680 | 13 | lowest |

**Share-quantization drag (not modelled, can only hurt):** several names buy exactly **1 share** for ₩100k,
leaving large idle cash and coarse fills; per-trade % returns overstate account returns.

### 1.4 Sample-size honesty ⚠️
**56 trading days ≈ 2.6 months is a SMALL sample.** Split 60/40 → **train 33d, test 23d**. Any single
config's test trade count is modest; conclusions are provisional and flagged as small-sample throughout.

---

## 2. Protocol

- **Date split (frozen):** train = earliest 60% = **2026-04-14 → 2026-06-02 (33d)**; test = latest 40% =
  **2026-06-04 → 2026-07-06 (23d)**. Tuned only on train; frozen configs scored **once** on test.
- **Costs:** entries are **market-at-next-bar-open** and stops are **market exits** → aggressive fills →
  **0.28% round trip primary** (0.03% commission + 0.15% tax + 0.10% slippage). 0.23% shown as sensitivity.
- **Fills (no look-ahead):** signal on bar *t* CLOSE → enter at bar *t+1* **OPEN**. Stop/target checked
  bar-by-bar on subsequent highs/lows (**stop priority** when both hit in one bar; gap-through fills at the
  bar open = conservative). Time-stop / VWAP-stop fill at bar close. **EOD exit at the last ≤15:19 bar.**
- **One position at a time** (budget = one slot). Cross-universe: when several names signal on the same
  minute, tie-break = **best** (highest 거래대금-surge), tested for sensitivity vs **worst** and **alpha**.
- **Metrics:** trades, win%, avg net/trade, total return (compounded full-slot), MDD, profit factor,
  t-stat = mean/std·√n of per-trade net returns, avg hold minutes.

Scripts (scratch, `scratchpad/research1m/`): `probe.ts, fetch.ts, engine.ts, strats.ts, sanity.ts,
train.ts, test.ts, gross.ts`. Engine sanity-checked (buy-09:05/hold-EOD reproduces cost = gross − 0.28%).

**Multiple-testing budget: 128 configs total** (ORB 72, 거래대금-surge 24, VWAP-reclaim 8, VWAP-reversion 12,
buy-pressure-continuation 12). Reported honestly; no config was retro-fitted after seeing test.

---

## 3. Train results (best-pick, cost 0.28%) — top rows per family

### Family 1 — Opening-Range Breakout (long break of ORB-high)
Swept R∈{15,30,60} × 거래대금-confirm k∈{–,2,3} × buy-pressure∈{–,0.6} × stop∈{ORB-low,1%} × target∈{EOD,2R}.

| config | n | win | avg | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|
| R60 k3 stopORBlo tgt2R (best) | 28 | 32% | 0.00% | −1% | −10% | 1.00 | 0.00 |
| R60 k3 stopORBlo tgtEOD | 27 | 33% | −0.03% | −2% | −11% | 0.96 | −0.07 |
| R60 k– stopORBlo tgt2R | 31 | 29% | −0.06% | −3% | −11% | 0.93 | −0.13 |

The **entire ORB grid sits at breakeven-to-negative** — the best config is dead flat (avg 0.00%, PF 1.00).

### Family 2 — 거래대금 / volume-surge momentum (surge + close top-of-range → enter)
Swept k∈{2,3,5} × buy-pressure∈{0.7,0.8} × exit∈{ts10, ts30, stop1%/tgt2%, stop0.5%/tgt1%}.

| config | n | win | avg | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|
| k5 bp0.7 stop1/tgt2 (best) | 83 | 31% | −0.32% | −24% | −29% | 0.54 | −2.55 |
| k3 bp0.7 stop1/tgt2 | 105 | 26% | −0.44% | −37% | −39% | 0.43 | −3.94 |
| k5 bp0.7 stop0.5/tgt1 | 160 | 31% | −0.30% | −38% | −39% | 0.39 | −5.83 |

**Robustly, significantly negative** across every config (t −2.5 to −6.6). Chasing 거래대금 surges *reverts*.

### Family 3a — VWAP reclaim / trend (reclaim VWAP from below + surge → long)
| config | n | win | avg | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|
| k2 EOD (best) | 33 | 33% | −0.42% | −14% | −17% | 0.65 | −0.91 |
| k– stop1/tgt2 | 101 | 31% | −0.40% | −33% | −37% | 0.48 | −3.43 |
| k– vwapStop | 735 | 5% | −0.38% | −94% | −94% | 0.12 | −24.4 |

Negative; VWAP-stop churns (735 trades, 5% win — whipsaw). Reclaiming VWAP is not a tradeable long.

### Family 3b — VWAP reversion (stretch ≥ d below VWAP + up bar → long, target = VWAP)
| config | n | win | avg | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|
| **d3% toVwap ts30 (best)** | 47 | 49% | **+0.07%** | +3% | −13% | **1.12** | 0.28 |
| d3% toVwap stop1% | 34 | 32% | −0.10% | −4% | −12% | 0.86 | −0.36 |
| d2% toVwap ts30 | 117 | 33% | −0.20% | −22% | −30% | 0.61 | −1.78 |

The **only positive-expectancy config in the entire 128** — but PF 1.12 (< 1.3), **t = 0.28 = noise**.

### Family 4 — Buy-pressure continuation (M strong bars + rising volume → long)
| config | n | win | avg | total | MDD | PF | t |
|---|---|---|---|---|---|---|---|
| m2 bp0.6 stop1/tgt2 (best) | 124 | 27% | −0.43% | −42% | −44% | 0.46 | −4.09 |
| m2 bp0.6 ts30 | 398 | 25% | −0.30% | −70% | −70% | 0.31 | −7.46 |

**Robustly, significantly negative** (t −4 to −9). Buy-pressure continuation reverts, same as surge.

### Survivor selection (pre-specified: n≥25, avg>0, PF≥1.3 on train)
→ **ZERO survivors.** Only VWAP-reversion cleared avg>0, and it fails PF and t. Per protocol I still froze
the **top-1-by-train-t per family** and scored each **once** on test, to document the OOS step honestly.

---

## 4. Test results (frozen top-1 per family, scored ONCE, cost 0.28%)

| family | frozen config | pick | n | win | avg | total | MDD | PF | t | hold |
|---|---|---|---|---|---|---|---|---|---|---|
| ORB | R60 k3 ORBlo 2R | best | 18 | 33% | −0.39% | −8% | −11% | 0.73 | −0.44 | 248m |
| SURGE | k5 bp0.7 s1t2 | best | 85 | 33% | −0.36% | −27% | −30% | 0.53 | −2.73 | 76m |
| VWAP-reclaim | k2 EOD | best | 23 | 17% | −2.27% | −43% | −43% | 0.16 | −2.17 | 357m |
| **VWAP-reversion** | d3% toVwap ts30 | best | 66 | 36% | **−0.40%** | −24% | −27% | 0.54 | **−1.82** | 29m |
| BP-cont | m2 bp0.6 s1t2 | best | 129 | 30% | −0.35% | −37% | −39% | 0.56 | −3.11 | 65m |

**Every family is negative out-of-sample.** The one train-positive config (VWAP-reversion) **flips from
+0.07% train to −0.40% test** — it was noise.

### 4a. Tie-break sensitivity (best vs worst vs alpha)
Results are **near-identical across all three picks** (e.g. SURGE test t = −2.73 / −2.64 / −2.64;
VWAP-reversion −1.82 / −1.86 / −1.86). Unlike the daily gap-down study, there is **no best-pick mirage** —
the negative edge is pervasive, not concentrated in a lucky tie-break, so sensitivity is a non-issue here.

### 4b. Cost sensitivity (0.23% instead of 0.28%)
Everything remains negative on test. The best case, VWAP-reversion, improves only to test t = −1.59
(train PF 1.23 / t 0.49) — still no positive OOS return. The verdict is **robust to the cost assumption.**

### 4c. The decisive check — GROSS forward drift vs cost (test, cost = 0)
| family | n | **gross** avg/trade | > 0.28%? | fade/short-side net (=−gross−0.28%) |
|---|---|---|---|---|
| ORB | 18 | −0.109% | no | −0.171% |
| SURGE | 85 | −0.083% | no | −0.197% |
| VWAP-reclaim | 23 | −1.993% | no | +1.713%* |
| VWAP-reversion | 66 | −0.118% | no | −0.162% |
| BP-cont | 129 | −0.069% | no | −0.211% |

For the momentum families the **gross** forward drift after a signal is **within ±0.12%** — an order of
magnitude **below the 0.28% round-trip cost**. So neither side is tradeable: the **long loses**, and the
**fade/short mirror** (+0.07–0.12% gross) still nets **−0.16 to −0.21% after costs**. There is simply not
enough exploitable forward information in any 1m signal here to pay the toll.

\* VWAP-reclaim's +1.71% fade-side is **not a real edge**: it is a directional artifact — these names
drifted down over the 23-day test window, so "short anything at midday" looked good — with n=23, no stable
mechanism, and it would require **shorting individual KRX stocks**, which a ₩100k long-only cash account
**cannot do**. Non-actionable.

---

## 5. Verdict

### 🔴 NO-GO — all five intraday families.

| family | outcome | why |
|---|---|---|
| 1. Opening-Range Breakout | **NO-GO** | Entire grid breakeven-to-negative; best config avg 0.00% / PF 1.00 (train), test −0.39% / PF 0.73 / t −0.44. |
| 2. 거래대금-surge momentum | **NO-GO** | Significantly negative train & test (t −2.7). Surges revert; gross drift −0.08% ≪ cost. |
| 3a. VWAP reclaim (trend) | **NO-GO** | Negative everywhere; test −2.27%/trade in a down window. |
| 3b. VWAP reversion | **NO-GO** | Only train-positive config (PF 1.12, t 0.28 = noise); flips to −0.40% / t −1.82 OOS. |
| 4. Buy-pressure continuation | **NO-GO** | Significantly negative train & test (t −3 to −9). |

**Verdict-rule scorecard (best OOS candidate = VWAP-reversion d3% toVwap ts30, 0.28%):**

| rule | threshold | result | pass? |
|---|---|---|---|
| positive test return | > 0 | −24% total, −0.40%/trade | ❌ |
| ≥30 test trades | ≥ 30 | 66 (small-sample flagged) | ✅ (count only) |
| profit factor | ≥ 1.3 | 0.54 | ❌ |
| t-stat | ≥ ~1.5 | −1.82 | ❌ |
| MDD | ≥ −25% | −27% | ❌ |
| tie-break stable | best ≈ worst | −1.82 ≈ −1.86 (stably negative) | n/a |

No config passes. **There is no frozen config to hand off.**

### Why (3-line read)
1. At 1m resolution these liquid affordable KRX names show **|forward drift| ≲ 0.12% gross** after any
   거래대금/buy-pressure/VWAP/ORB signal — roughly noise relative to the **0.28% round-trip cost**.
2. Momentum/continuation **reverts** (robustly, significantly negative, t −3 to −9); but the reversion
   mirror is too weak to clear costs **and** would require shorting (infeasible for ₩100k long-only cash).
3. This confirms the daily-bar NO-GO at higher resolution: **costs dominate**; frequent day-trading on this
   ₩100k universe is negative-expectation. The 56-day sample is also small — but the failure is uniform and
   structural (cost > edge), not a small-sample coin-flip that better luck would rescue.

---

## 6. Recommendation & notes
- **Do not deploy.** Keep the daytrade path in paper mode. No config qualifies.
- **Cost math to internalize:** a strategy trading ~1–3×/day at 0.28% round trip needs a per-trade gross
  edge > ~0.28%. The best 1m signal here delivers < 0.12% gross. Structurally underwater.
- **What genuinely IS present in the data (not tradeable):** intraday **mean-reversion** — surges and
  buy-pressure runs fade. To monetise it you would need (a) the short side (unavailable to ₩100k cash),
  and/or (b) round-trip costs well under ~0.1% (unavailable). Worth remembering as an *observation*, not a
  strategy.
- **Data ceiling:** without historical tick/호가 data (Toss `/trades` is recent-only), true 체결강도 / order-book
  imbalance — the signals most likely to carry sub-minute edge — cannot be backtested here at all.
- **If revisited:** needs (a) a real historical tick or L2/호가 feed, (b) a longer 1m history than ~2–3 months,
  (c) a lower-cost execution path (the tax+slippage floor is the binding constraint), and (d) likely the
  ability to short. None are available from the Toss API + ₩100k cash account today.
