# AQR 팩터 백테스트 UI Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "팩터 백테스트" tab panel to the bottom tabbed area of the TradingView-dark dashboard in `src/api/server.ts`, wired to the already-live `POST /api/factors/backtest` endpoint, rendering an equity curve chart (via lightweight-charts), metrics strip, rebalances list, and a permanent survivorship-bias caveat box.

**Architecture:** All changes are confined to `DASHBOARD_HTML` (the inline HTML/CSS/JS constant inside `src/api/server.ts`) — no new files, no backend changes. A second lightweight-charts chart instance is created lazily (on first backtest run) and reused on subsequent runs. The panel fetch is completely independent of the 3-second auto-refresh loop and the main candlestick chart.

**Tech Stack:** TypeScript (strict), Fastify, lightweight-charts@4.2.3 (embedded CDN), ES5-style inline JS (no backticks, no arrow functions inside the template literal), Vitest for tests.

## Global Constraints

- **Single file change:** only `src/api/server.ts` DASHBOARD_HTML constant (+ test assertions in `src/api/server.test.ts`)
- **ES5 JS inside template literal:** no `const`/`let`/`=>` inside the HTML JS block; use `var`, `function`, `forEach`, concatenated strings
- **No backticks inside the template literal:** all inner strings use single quotes; concatenation for multi-part strings
- **`esc()` on every API-derived interpolated value** inserted via innerHTML
- **lightweight-charts version pin:** `lightweight-charts@4.2.3` must remain intact
- **Token pattern:** send `localStorage.getItem('apiToken')||''` as `x-api-token` on POST (matches existing mutations)
- **No auto-poll:** backtest runs only on button click, never in `refreshAll()` or `setInterval`
- **Exact caveat text:** `⚠️ 생존편향: 유니버스가 현재 상장 종목이라 과거 성과가 과대평가됨. MDD는 리밸런싱 경계에서만 샘플링되어 실제보다 작게 나옴. 참고용.`
- **Gate: 262 tests green** — `npx vitest run`; `npm run typecheck` clean
- **Commit message:** `feat(ui): AQR factor backtest panel (equity curve + metrics + survivorship caveat)`
- **Report file:** `/Users/im-yoseb/auto-trading/.superpowers/sdd/factor-backtest-ui-report.md`

---

## Files

- **Modify:** `src/api/server.ts` — add CSS, tab button, tab pane HTML, and JS logic inside `DASHBOARD_HTML`
- **Modify:** `src/api/server.test.ts` — add `'팩터 백테스트'` assertion to the dashboard smoke test

---

### Task 1: Add CSS, HTML tab button + pane, and JS — all in DASHBOARD_HTML

**Files:**
- Modify: `src/api/server.ts` (DASHBOARD_HTML constant, lines ~238–991)

**Interfaces:**
- Consumes: `POST /api/factors/backtest` → `{result:{equityCurve,rebalances,metrics},universeSize,fetched,skipped,asOf}`
- Consumes: `esc()`, `LightweightCharts` (already in scope in the template)
- Produces: DOM elements `#tab-fbt`, `#btn-fbt-run`, `#fbt-chart`, `#fbt-status`, `#fbt-metrics`, `#fbt-rebalances`, `#fbt-caption`

---

- [ ] **Step 1: Locate insertion points in server.ts**

  The file has four distinct insertion points inside `DASHBOARD_HTML`:
  1. **CSS block** — end of `<style>` section, before `</style>` (around line 350)
  2. **Tab bar** — after the `팩터 랭킹` tab button (around line 455)
  3. **Tab pane** — after `</div>` closing `tab-ranking` pane (around line 483)
  4. **JS block** — before `<\/script>` (around line 989)

- [ ] **Step 2: Add CSS for the fbt panel (in `<style>` block, before `</style>`)**

  Add immediately before the `</style>` tag (after line 350 `::-webkit-scrollbar-thumb:hover` rule):

  ```css
  /* ---- factor backtest panel ---- */
  .fbt-controls{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--bd);flex-shrink:0;flex-wrap:wrap}
  .fbt-controls label{color:var(--mu);font-size:11px;white-space:nowrap}
  .fbt-controls input{width:88px}
  #btn-fbt-run{background:#0e2040;color:#5a9eff;border:1px solid #1c3d7a;border-radius:4px;padding:4px 12px;cursor:pointer;font:inherit;font-size:11px;font-weight:600;white-space:nowrap}
  #btn-fbt-run:hover:not(:disabled){background:#142a5a}
  #btn-fbt-run:disabled{opacity:.35;cursor:not-allowed}
  #fbt-status{padding:8px 12px;font-size:11px;color:var(--mu)}
  #fbt-chart-wrap{height:160px;flex-shrink:0;position:relative}
  #fbt-chart{width:100%;height:100%}
  .fbt-metrics{display:flex;flex-wrap:wrap;gap:8px;padding:6px 10px;border-bottom:1px solid var(--bd)}
  .fbt-caption{padding:4px 10px 2px;font-size:10px;color:var(--mu)}
  .fbt-caveat{margin:8px 10px;padding:7px 10px;background:#1c1a08;border:1px solid #5a4a10;border-radius:4px;color:#c8a820;font-size:10px;line-height:1.6}
  .fbt-rebalances{padding:0 10px 6px}
  .fbt-reb-row{font-size:10px;color:var(--mu);padding:2px 0;border-bottom:1px solid #0d1219}
  .fbt-reb-date{color:#5a9eff;display:inline-block;min-width:82px}
  ```

- [ ] **Step 3: Add the tab button to the tab bar**

  In the `.tab-bar` div (after the `팩터 랭킹` button, before `</div>`), add:

  ```html
  <button class="tab-btn" data-tab="fbt">팩터 백테스트</button>
  ```

- [ ] **Step 4: Add the tab pane HTML (after the ranking pane closing `</div>`)**

  The pane ordering within `.tab-content > .tab-pane` elements: positions, strategies, logs, ranking, **fbt** (new). Add after the `</div>` that closes `id="tab-ranking"`:

  ```html
  <div id="tab-fbt" class="tab-pane" style="display:none">
    <div class="fbt-controls">
      <label for="fbt-topn">상위N</label>
      <input type="number" id="fbt-topn" value="5" min="1" step="1">
      <label for="fbt-rebal">거래일</label>
      <input type="number" id="fbt-rebal" value="21" min="1" step="1">
      <label for="fbt-cap">초기자본</label>
      <input type="number" id="fbt-cap" value="10000000" min="1" step="1000000">
      <button id="btn-fbt-run">백테스트 실행</button>
    </div>
    <div id="fbt-status" style="display:none"></div>
    <div id="fbt-chart-wrap" style="display:none">
      <div id="fbt-chart"></div>
    </div>
    <div id="fbt-metrics" class="fbt-metrics" style="display:none">
      <div class="metric"><span class="mlabel">총수익률</span><span class="mval" id="fbt-m-ret"></span></div>
      <div class="metric"><span class="mlabel">MDD</span><span class="mval" id="fbt-m-mdd"></span></div>
      <div class="metric"><span class="mlabel">리밸런싱 횟수</span><span class="mval" id="fbt-m-rbc"></span></div>
      <div class="metric"><span class="mlabel">최종자산</span><span class="mval" id="fbt-m-nav"></span></div>
    </div>
    <div class="fbt-caveat">&#9888;&#65039; 생존편향: 유니버스가 현재 상장 종목이라 과거 성과가 과대평가됨. MDD는 리밸런싱 경계에서만 샘플링되어 실제보다 작게 나옴. 참고용.</div>
    <div id="fbt-rebalances" class="fbt-rebalances" style="display:none"></div>
    <div id="fbt-caption" class="fbt-caption" style="display:none"></div>
  </div>
  ```

  **NOTE on the caveat emoji:** The ⚠️ emoji is two Unicode code points (U+26A0 + U+FE0F). Inside the TypeScript template literal, write them as HTML entities `&#9888;&#65039;` OR as the literal UTF-8 characters. The test will `grep` for the Korean text "생존편향" which is the key distinguishing string. The curl verification checks for '생존편향'. Either approach works — the literal emoji characters are safest since they pass through the template literal unchanged:
  
  ```
  ⚠️ 생존편향: 유니버스가 현재 상장 종목이라 과거 성과가 과대평가됨. MDD는 리밸런싱 경계에서만 샘플링되어 실제보다 작게 나옴. 참고용.
  ```

- [ ] **Step 5: Add JS for the fbt panel (before `<\/script>`)**

  Add after the last line of the existing `/* ---- Factor Ranking ---- */` JS block, before `<\/script>`:

  ```js
  /* ---- Factor Backtest (run on button click only — NOT in 3s loop) ---- */
  var fbtChart = null;
  var fbtSeries = null;

  function ensureFbtChart(el) {
    if (fbtChart) return true;
    try {
      fbtChart = LightweightCharts.createChart(el, {
        layout: { background: { color: '#0b0e14' }, textColor: '#d1d4dc' },
        grid: { vertLines: { color: '#131722' }, horzLines: { color: '#131722' } },
        rightPriceScale: { borderColor: '#1c2230' },
        timeScale: { borderColor: '#1c2230', timeVisible: true },
        width: el.offsetWidth || 600,
        height: el.offsetHeight || 160,
        handleScroll: false,
        handleScale: false,
      });
      fbtSeries = fbtChart.addAreaSeries({
        lineColor: '#26a69a',
        topColor: 'rgba(38,166,154,0.28)',
        bottomColor: 'rgba(38,166,154,0.02)',
        lineWidth: 2,
      });
      new ResizeObserver(function() {
        if (!fbtChart) return;
        fbtChart.applyOptions({ width: el.offsetWidth, height: el.offsetHeight });
      }).observe(el);
      return true;
    } catch (e) {
      console.error('[fbt-chart] init failed:', e);
      fbtChart = null;
      fbtSeries = null;
      return false;
    }
  }

  function renderFactorBacktest(data) {
    var result = data.result || {};
    var metrics = result.metrics || {};
    var equityCurve = result.equityCurve || [];
    var rebalances = result.rebalances || [];

    /* equity curve chart */
    var chartWrap = document.getElementById('fbt-chart-wrap');
    var fbtChartEl = document.getElementById('fbt-chart');
    try {
      if (equityCurve.length && fbtChartEl && ensureFbtChart(fbtChartEl)) {
        var seen2 = {};
        var curveData = equityCurve.map(function(p) {
          return { time: Math.floor(p.date / 1000), value: p.nav };
        }).sort(function(a, b) { return a.time - b.time; }).filter(function(p) {
          if (seen2[p.time]) return false;
          seen2[p.time] = true;
          return true;
        });
        if (fbtSeries) fbtSeries.setData(curveData);
        if (fbtChart) fbtChart.timeScale().fitContent();
        if (chartWrap) chartWrap.style.display = '';
      }
    } catch (chartErr) {
      console.error('[fbt-chart] render failed:', chartErr);
    }

    /* metrics */
    var ret = Number(metrics.totalReturn) || 0;
    var mdd = Number(metrics.maxDrawdown) || 0;
    var rbc = Number(metrics.rebalanceCount) || 0;
    var fnav = Number(metrics.finalNav) || 0;
    var mRetEl = document.getElementById('fbt-m-ret');
    var mMddEl = document.getElementById('fbt-m-mdd');
    var mRbcEl = document.getElementById('fbt-m-rbc');
    var mNavEl = document.getElementById('fbt-m-nav');
    var fbtMetrics = document.getElementById('fbt-metrics');
    if (mRetEl) { mRetEl.textContent = (ret * 100).toFixed(2) + '%'; mRetEl.className = 'mval ' + (ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neu'); }
    if (mMddEl) { mMddEl.textContent = (mdd * 100).toFixed(2) + '%'; mMddEl.className = 'mval neg'; }
    if (mRbcEl) { mRbcEl.textContent = String(rbc); mRbcEl.className = 'mval neu'; }
    if (mNavEl) { mNavEl.textContent = Math.round(fnav).toLocaleString(); mNavEl.className = 'mval neu'; }
    if (fbtMetrics) fbtMetrics.style.display = 'flex';

    /* rebalances (most recent 15) */
    var rebalEl = document.getElementById('fbt-rebalances');
    var recent = rebalances.slice(-15);
    if (rebalEl && recent.length) {
      rebalEl.innerHTML = recent.map(function(rb) {
        var d = new Date(rb.date);
        var mo = d.getMonth() + 1;
        var dy = d.getDate();
        var ds = d.getFullYear() + '-' + (mo < 10 ? '0' : '') + String(mo) + '-' + (dy < 10 ? '0' : '') + String(dy);
        var holdings = Array.isArray(rb.holdings) ? rb.holdings.join(', ') : '';
        return '<div class="fbt-reb-row"><span class="fbt-reb-date">' + esc(ds) + '</span> ' + esc(holdings) + '</div>';
      }).join('');
      rebalEl.style.display = '';
    }

    /* caption */
    var captionEl = document.getElementById('fbt-caption');
    if (captionEl) {
      var asOfD = new Date(data.asOf);
      captionEl.textContent = 'universe ' + esc(String(data.universeSize || 0)) + ' / fetched ' + esc(String(data.fetched || 0)) + ' / skipped ' + esc(String(data.skipped || 0)) + ' \xb7 asOf ' + asOfD.toLocaleString();
      captionEl.style.display = '';
    }
  }

  function runFactorBacktest() {
    var btn = document.getElementById('btn-fbt-run');
    var statusEl = document.getElementById('fbt-status');
    var chartWrapEl = document.getElementById('fbt-chart-wrap');
    var metricsEl = document.getElementById('fbt-metrics');
    var rebalEl2 = document.getElementById('fbt-rebalances');
    var captionEl2 = document.getElementById('fbt-caption');

    var topNRaw = parseInt(document.getElementById('fbt-topn').value, 10);
    var rebalRaw = parseInt(document.getElementById('fbt-rebal').value, 10);
    var capRaw = parseFloat(document.getElementById('fbt-cap').value);
    var topN = isFinite(topNRaw) && topNRaw > 0 ? topNRaw : 5;
    var rebal = isFinite(rebalRaw) && rebalRaw > 0 ? rebalRaw : 21;
    var cap = isFinite(capRaw) && capRaw > 0 ? capRaw : 10000000;

    if (btn) { btn.disabled = true; btn.textContent = '백테스트 실행 중… (최초 최대 60초)'; }
    if (statusEl) statusEl.style.display = 'none';
    if (chartWrapEl) chartWrapEl.style.display = 'none';
    if (metricsEl) metricsEl.style.display = 'none';
    if (rebalEl2) rebalEl2.style.display = 'none';
    if (captionEl2) captionEl2.style.display = 'none';

    var token = localStorage.getItem('apiToken') || '';
    fetch('/api/factors/backtest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-token': token },
      body: JSON.stringify({ topN: topN, rebalanceEvery: rebal, startCapital: cap }),
    }).then(function(r) {
      if (r.status === 503) {
        return r.json().then(function() {
          if (statusEl) { statusEl.textContent = '팩터 백테스트 비활성'; statusEl.style.display = ''; }
          if (btn) { btn.disabled = false; btn.textContent = '백테스트 실행'; }
        });
      }
      if (!r.ok) {
        return r.json().then(function(d) {
          if (statusEl) { statusEl.textContent = '오류: ' + esc(d.error || '알 수 없음'); statusEl.style.display = ''; }
          if (btn) { btn.disabled = false; btn.textContent = '백테스트 실행'; }
        });
      }
      return r.json().then(function(data) {
        if (btn) { btn.disabled = false; btn.textContent = '백테스트 실행'; }
        renderFactorBacktest(data);
      });
    }).catch(function() {
      var s2 = document.getElementById('fbt-status');
      var b2 = document.getElementById('btn-fbt-run');
      if (s2) { s2.textContent = '네트워크 오류'; s2.style.display = ''; }
      if (b2) { b2.disabled = false; b2.textContent = '백테스트 실행'; }
    });
  }

  var fbtBtn = document.getElementById('btn-fbt-run');
  if (fbtBtn) {
    fbtBtn.addEventListener('click', function() { runFactorBacktest(); });
  }
  ```

  **NOTE on Korean strings in JS:** Korean characters are valid inside a TypeScript template literal. Use literal Korean text for readability — Unicode escapes (`\uXXXX`) are only needed if the source file encoding causes issues. Since the existing JS already uses literal Korean (`'랭킹 계산 중… (최초 최대 40초)'`), do the same here. The `\uXXXX` escapes above are shown for clarity but you should use literal Korean in the actual file.

---

- [ ] **Step 6: Update the dashboard smoke test in `server.test.ts`**

  In the `'composer page: ...'` test (around line 97), add one assertion after the existing `팩터 랭킹` check:

  ```ts
  expect(res.body).toContain('팩터 백테스트');
  ```

  The block should look like:
  ```ts
  it('composer page: lightweight-charts CDN, backtest UI, deploy button, anti-XSS helper', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-type']).toMatch(/charset=utf-8/);
    expect(res.body).toContain('lightweight-charts');
    expect(res.body).toContain('백테스트');
    expect(res.body).toContain('페이퍼 배포');
    expect(res.body).toContain('esc(');
    expect(res.body).toContain('팩터 랭킹');
    expect(res.body).toContain('팩터 백테스트');   // ← NEW
  });
  ```

- [ ] **Step 7: Run typecheck and tests**

  ```bash
  cd /Users/im-yoseb/auto-trading && npm run typecheck
  ```
  Expected: no errors.

  ```bash
  cd /Users/im-yoseb/auto-trading && npx vitest run
  ```
  Expected: 262 tests pass (or 263 if a new test was added — depends on whether the existing test count includes the new assertion or not; the new assertion is in an existing test case, so count stays 262).

- [ ] **Step 8: Smoke test with the live server**

  ```bash
  cd /Users/im-yoseb/auto-trading && npx tsx src/index.ts &
  sleep 3
  curl -s http://127.0.0.1:3000/ | grep -c '팩터 백테스트'
  # expected: ≥1
  curl -s http://127.0.0.1:3000/ | grep -c 'lightweight-charts@4.2.3'
  # expected: 1
  curl -s http://127.0.0.1:3000/ | grep -c '생존편향'
  # expected: 1
  curl -s http://127.0.0.1:3000/ | grep -c 'esc('
  # expected: ≥1
  curl -s http://127.0.0.1:3000/ | grep -c '백테스트 실행'
  # expected: ≥1
  kill %1
  ```

- [ ] **Step 9: Write the report file**

  Write to `/Users/im-yoseb/auto-trading/.superpowers/sdd/factor-backtest-ui-report.md`:

  ```markdown
  # Factor Backtest UI Report

  **Status:** DONE
  **Commit:** <hash>
  **Test summary:** 262/262 passing
  **Concerns:** None. Chart instance is guarded against duplicate creation via `fbtChart` guard variable. The 3s refresh loop is unaffected. Backend routes unchanged.
  ```

- [ ] **Step 10: Commit**

  ```bash
  cd /Users/im-yoseb/auto-trading && git add src/api/server.ts src/api/server.test.ts
  git commit -m "feat(ui): AQR factor backtest panel (equity curve + metrics + survivorship caveat)"
  ```

---

## Self-Review Checklist

1. **Spec coverage:**
   - [x] Tab button added to bottom panel tab bar
   - [x] topN / rebalanceEvery / startCapital inputs with defaults 5/21/10000000
   - [x] "백테스트 실행" button with loading state text "백테스트 실행 중… (최초 최대 60초)"
   - [x] Equity curve via second lightweight-charts chart instance (area series)
   - [x] `setData(equityCurve.map(p => ({ time: Math.floor(p.date/1000), value: p.nav })))`
   - [x] Chart creation wrapped in try/catch, isolated from main chart
   - [x] Guard against duplicate chart instances (lazy `ensureFbtChart`, reuses if exists)
   - [x] Metrics strip: totalReturn×100%, maxDrawdown×100%, rebalanceCount, finalNav (comma-formatted via toLocaleString)
   - [x] Rebalances list: date→YYYY-MM-DD (local), holdings joined, last 15 rows
   - [x] Caption: universeSize/fetched/skipped + asOf as local time
   - [x] Survivorship bias caveat box with exact required text
   - [x] 503 → "팩터 백테스트 비활성" (graceful)
   - [x] No auto-poll — button click only
   - [x] `x-api-token` header sent on POST
   - [x] `esc()` on all innerHTML-interpolated strings
   - [x] Failure does not break main page (try/catch, independent fetch)
   - [x] Test assertion for '팩터 백테스트' added
   - [x] Report written to `.superpowers/sdd/factor-backtest-ui-report.md`

2. **Placeholder scan:** No TBD/TODO placeholders. All code shown.

3. **Type consistency:** No new TypeScript types introduced — the HTML is a string constant.
