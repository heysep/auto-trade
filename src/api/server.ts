import Fastify, { type FastifyInstance } from 'fastify';
import type { TradingSystem } from '../app/TradingSystem.js';
import type { StrategyStatus, TradingMode } from '../domain/types.js';
import type { StrategySpec } from '../strategy/strategySpec.js';

const STATUSES: readonly StrategyStatus[] = [
  'DRAFT', 'BACKTESTING', 'PAPER_TESTING', 'APPROVED', 'LIVE', 'PAUSED', 'REJECTED',
];
const MODES: readonly TradingMode[] = ['PAPER', 'LIVE'];

export interface ServerOptions {
  /** When set, mutating routes (POST/PATCH) require header `x-api-token` to match. */
  authToken?: string;
}

/** Build the HTTP API over a TradingSystem. Test with app.inject(); start with app.listen(). */
export function buildServer(system: TradingSystem, opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Tolerate empty JSON bodies (e.g. POST /emergency-stop with no payload).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); }
    catch (err) { done(err as Error, undefined); }
  });

  // Auth on the control plane (mutations). Reads stay open.
  if (opts.authToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
        if (req.headers['x-api-token'] !== opts.authToken) {
          return reply.code(401).send({ error: 'unauthorized' });
        }
      }
    });
  }

  // Log + generic 500 so internal messages never leak and failures aren't silent.
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    console.error(`[api] ${req.method} ${req.url} failed:`, e.message);
    reply.code(status).send({ error: status < 500 ? (e.message ?? 'error') : 'internal error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // --- dashboard (PLAN §10) ---
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(DASHBOARD_HTML));

  // --- strategies ---
  app.get('/api/strategies', async () => system.registry.list());

  app.get('/api/strategies/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const s = Number.isInteger(id) ? system.registry.get(id) : undefined;
    return s ?? reply.code(404).send({ error: 'strategy not found' });
  });

  app.post('/api/strategies', async (req, reply) => {
    const body = (req.body ?? {}) as { symbol?: string; spec?: StrategySpec; name?: string };
    if (!body.symbol) return reply.code(400).send({ error: 'symbol is required' });
    if (!body.spec) return reply.code(400).send({ error: 'spec is required' });
    if (!body.name) return reply.code(400).send({ error: 'name is required' });
    const result = system.deploy({ symbol: body.symbol, spec: body.spec, name: body.name });
    if (!result.ok) return reply.code(result.code).send({ error: result.error });
    return reply.code(201).send(result.view);
  });

  app.delete('/api/strategies/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid strategy id' });
    const ok = system.undeploy(id);
    if (!ok) return reply.code(404).send({ error: 'strategy not found' });
    return { ok: true };
  });

  app.patch('/api/strategies/:id/status', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid strategy id' });
    const body = (req.body ?? {}) as { status?: string; approved?: boolean };
    if (!body.status || !STATUSES.includes(body.status as StrategyStatus)) {
      return reply.code(400).send({ error: `status must be one of ${STATUSES.join(', ')}` });
    }
    const result = system.changeStatus(id, body.status as StrategyStatus, { approved: body.approved === true });
    if (!result.ok) {
      return reply.code(result.code).send({ error: result.error, ...(result.failures ? { failures: result.failures } : {}) });
    }
    return result.view;
  });

  // --- positions & orders ---
  app.get('/api/positions', async (req, reply) => {
    const q = req.query as { mode?: string; strategyId?: string };
    const mode = parseModeOr(q.mode, reply); if (mode === BAD) return reply;
    let strategyId: number | undefined;
    if (q.strategyId !== undefined) {
      strategyId = Number(q.strategyId);
      if (!Number.isInteger(strategyId)) return reply.code(400).send({ error: 'invalid strategyId' });
    }
    return system.listPositions(mode, strategyId);
  });

  app.get('/api/orders', async (req, reply) => {
    const q = req.query as { mode?: string };
    const mode = parseModeOr(q.mode, reply); if (mode === BAD) return reply;
    return system.listOrders(mode);
  });

  // --- market data ---
  app.get('/api/market/price/:symbol', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const quote = system.quote(symbol);
    return quote ?? reply.code(404).send({ error: 'no quote for symbol' });
  });

  app.get('/api/market/prices', async (req) => {
    const q = req.query as { symbols?: string };
    const symbols = (q.symbols ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return system.quotes(symbols);
  });

  // --- symbol catalog ---
  app.get('/api/market/symbols', async (req) => {
    const q = req.query as { q?: string; limit?: string };
    const query = q.q ?? '';
    const rawLimit = q.limit !== undefined ? Number(q.limit) : undefined;
    const limit = rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
    if (limit !== undefined) {
      return system.searchSymbols(query, limit);
    }
    return system.searchSymbols(query);
  });

  // --- candles ---
  app.get('/api/market/candles', async (req, reply) => {
    const q = req.query as { symbol?: string; interval?: string };
    if (!q.symbol) return reply.code(400).send({ error: 'symbol is required' });
    const interval = q.interval ?? '1d';
    if (interval !== '1m' && interval !== '1d') {
      return reply.code(400).send({ error: "interval must be '1m' or '1d'" });
    }
    return system.candles(q.symbol, interval);
  });

  // --- logs ---
  app.get('/api/logs', async (req) => {
    const q = req.query as { limit?: string };
    const n = q.limit !== undefined ? Number(q.limit) : undefined;
    return system.logs(Number.isFinite(n) && (n as number) > 0 ? n : undefined);
  });

  // --- safety ---
  app.get('/api/halt', async () => system.haltStatus());

  app.post('/api/emergency-stop', async (req) => {
    const reason = ((req.body ?? {}) as { reason?: string }).reason ?? 'manual emergency stop';
    system.emergencyStop(reason);
    return system.haltStatus();
  });

  app.post('/api/resume', async () => {
    system.resume();
    return system.haltStatus();
  });

  // --- backtest ---
  app.post('/api/backtest', async (req, reply) => {
    const body = (req.body ?? {}) as { symbol?: string; spec?: StrategySpec; interval?: string; capital?: number };
    if (!body.symbol) return reply.code(400).send({ error: 'symbol is required' });
    if (!body.spec) return reply.code(400).send({ error: 'spec is required' });
    return system.backtest({
      symbol: body.symbol,
      spec: body.spec,
      ...(body.interval !== undefined ? { interval: body.interval } : {}),
      ...(body.capital !== undefined ? { capital: body.capital } : {}),
    });
  });

  return app;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>auto-trading</title>
<script src="https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js"><\/script>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0e14;color:#c8d3e0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;flex-direction:column;height:100vh;overflow:hidden}
/* ---- top bar ---- */
header{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid #1c2230;flex-shrink:0;min-height:44px}
header h1{font-size:14px;letter-spacing:.05em;color:#e6edf6;font-weight:700}
#halt-pill{margin-left:auto;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;white-space:nowrap}
.halt-ok{background:#10331f;color:#5ad17f}.halt-stopped{background:#3a1418;color:#ff6b78}
#stop-btn{padding:5px 13px;border-radius:5px;border:0;cursor:pointer;font:inherit;font-size:12px;font-weight:600;white-space:nowrap;background:#7a1622;color:#fff}
#stop-btn.resume{background:#143a22;color:#5ad17f}
/* ---- layout ---- */
.layout{display:flex;flex:1;overflow:hidden;min-height:0}
/* ---- left panel ---- */
.left-panel{width:270px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid #1c2230}
.phdr{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#7d8aa0;padding:8px 12px 5px}
#sym-search{background:#0f1520;color:#c8d3e0;border:1px solid #1c2230;border-radius:5px;padding:6px 10px;font:inherit;font-size:12px;margin:0 10px 6px;outline:none}
#sym-search:focus{border-color:#4a7fe8}
#sym-list{flex:1;overflow-y:auto}
.sym-item{padding:7px 12px;cursor:pointer;border-bottom:1px solid #0f1520}
.sym-item:hover{background:#131926}
.sym-item.active{background:#1a2440;border-left:2px solid #4a7fe8}
.sym-name{color:#e6edf6;font-size:12px}.sym-code{color:#7d8aa0;font-size:11px}
/* ---- center panel ---- */
.center-panel{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
#chart-container{flex:1;min-height:0;position:relative}
#chart{width:100%;height:100%}
.chart-hint{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#2a3550;font-size:14px;pointer-events:none;white-space:nowrap}
/* ---- builder ---- */
.builder{border-top:1px solid #1c2230;padding:10px 14px;flex-shrink:0;background:#0d1119}
.brow{display:flex;align-items:center;gap:7px;margin-bottom:6px;flex-wrap:nowrap}
.blabel{color:#7d8aa0;font-size:11px;min-width:16px;flex-shrink:0}
select,input[type="number"]{background:#0f1520;color:#c8d3e0;border:1px solid #1c2230;border-radius:4px;padding:4px 7px;font:inherit;font-size:12px;outline:none}
select:focus,input[type="number"]:focus{border-color:#4a7fe8}
.params-wrap{display:flex;gap:5px;align-items:center}
.params-wrap label{color:#7d8aa0;font-size:11px;white-space:nowrap}
.params-wrap input{width:76px}
.and-or{display:flex;border:1px solid #1c2230;border-radius:4px;overflow:hidden;flex-shrink:0}
.and-or button{background:#0f1520;color:#7d8aa0;border:0;padding:3px 11px;cursor:pointer;font:inherit;font-size:11px}
.and-or button.ao-active{background:#1a2440;color:#4a7fe8}
.bactions{display:flex;align-items:center;gap:8px;margin-top:7px;flex-wrap:nowrap}
.notional-w{display:flex;align-items:center;gap:5px}
.notional-w label{color:#7d8aa0;font-size:11px;white-space:nowrap}
.notional-w input{width:110px}
.btn-bt{background:#162840;color:#4a9eff;border:1px solid #1c3a6e;border-radius:5px;padding:5px 14px;cursor:pointer;font:inherit;font-size:12px;font-weight:600}
.btn-bt:hover:not(:disabled){background:#1c3a6e}
.btn-dp{background:#143a22;color:#5ad17f;border:1px solid #1a4d2a;border-radius:5px;padding:5px 14px;cursor:pointer;font:inherit;font-size:12px;font-weight:600}
.btn-dp:hover:not(:disabled){background:#1a4d2a}
.btn-bt:disabled,.btn-dp:disabled{opacity:.35;cursor:not-allowed}
/* ---- metrics strip ---- */
#metrics-strip{display:none;gap:18px;margin-top:8px;padding-top:8px;border-top:1px solid #1c2230;flex-wrap:wrap}
.metric{display:flex;flex-direction:column}
.mlabel{font-size:10px;color:#7d8aa0;text-transform:uppercase;letter-spacing:.05em}
.mval{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.pos{color:#5ad17f}.neg{color:#ff6b78}.neu{color:#c8d3e0}
/* ---- right panel ---- */
.right-panel{width:295px;flex-shrink:0;display:flex;flex-direction:column;border-left:1px solid #1c2230;overflow:hidden}
.rpanel-sec{display:flex;flex-direction:column;min-height:0}
.rpanel-sec+.rpanel-sec{border-top:1px solid #1c2230}
.rpanel-sec.rp-grow{flex:1;overflow:hidden}
.rpanel-body{overflow-y:auto;flex:1}
/* ---- tables ---- */
table{width:100%;border-collapse:collapse;font-size:11px}
th,td{text-align:left;padding:5px 9px;border-bottom:1px solid #0f1520}
th{color:#7d8aa0;font-weight:500;position:sticky;top:0;background:#0b0e14;z-index:1}
td.num{text-align:right;font-variant-numeric:tabular-nums}
/* ---- strategy items ---- */
.sitem{display:flex;align-items:center;padding:7px 10px;border-bottom:1px solid #0f1520;gap:7px}
.sitem-info{flex:1;min-width:0}
.sitem-name{color:#e6edf6;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sitem-meta{color:#7d8aa0;font-size:11px}
.sitem-del{background:none;color:#ff6b78;border:1px solid #3a1418;border-radius:3px;padding:2px 6px;cursor:pointer;font-size:11px;flex-shrink:0}
.sitem-del:hover{background:#3a1418}
/* ---- scrollbar ---- */
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:#0b0e14}
::-webkit-scrollbar-thumb{background:#1c2230;border-radius:2px}
</style>
</head>
<body>

<header>
  <h1>auto-trading</h1>
  <span id="halt-pill" class="halt-ok">정상</span>
  <button id="stop-btn">긴급 정지</button>
</header>

<div class="layout">

  <!-- LEFT: symbol picker -->
  <div class="left-panel">
    <div class="phdr">종목 검색</div>
    <input id="sym-search" type="text" placeholder="종목명 또는 코드…" autocomplete="off" spellcheck="false">
    <div id="sym-list"><div style="padding:10px 12px;color:#2a3550;font-size:11px">검색 중…</div></div>
  </div>

  <!-- CENTER: chart + builder -->
  <div class="center-panel">
    <div id="chart-container">
      <div id="chart"></div>
      <div class="chart-hint" id="chart-hint">종목을 선택하면 차트가 표시됩니다</div>
    </div>

    <div class="builder">
      <!-- Strategy row A -->
      <div class="brow">
        <span class="blabel">A</span>
        <select id="type-a">
          <option value="">전략 없음</option>
          <option value="threshold">임계값 Threshold</option>
          <option value="sma">이동평균 SMA</option>
        </select>
        <div id="params-a" class="params-wrap" style="display:none"></div>
      </div>

      <!-- AND / OR -->
      <div class="brow">
        <span class="blabel"></span>
        <div class="and-or">
          <button id="btn-and" class="ao-active" data-v="AND">AND</button>
          <button id="btn-or" data-v="OR">OR</button>
        </div>
      </div>

      <!-- Strategy row B -->
      <div class="brow">
        <span class="blabel">B</span>
        <select id="type-b">
          <option value="">전략 없음</option>
          <option value="threshold">임계값 Threshold</option>
          <option value="sma">이동평균 SMA</option>
        </select>
        <div id="params-b" class="params-wrap" style="display:none"></div>
      </div>

      <!-- Actions -->
      <div class="bactions">
        <div class="notional-w">
          <label for="notional">주문금액</label>
          <input type="number" id="notional" value="1000000" min="1" step="100000">
        </div>
        <button class="btn-bt" id="btn-backtest" disabled>백테스트</button>
        <button class="btn-dp" id="btn-deploy" disabled>페이퍼 배포</button>
      </div>

      <!-- Metrics strip -->
      <div id="metrics-strip" style="display:none">
        <div class="metric"><span class="mlabel">수익률</span><span class="mval" id="m-ret"></span></div>
        <div class="metric"><span class="mlabel">MDD</span><span class="mval" id="m-mdd"></span></div>
        <div class="metric"><span class="mlabel">승률</span><span class="mval" id="m-wr"></span></div>
        <div class="metric"><span class="mlabel">PF</span><span class="mval" id="m-pf"></span></div>
        <div class="metric"><span class="mlabel">거래수</span><span class="mval" id="m-tc"></span></div>
      </div>
    </div>
  </div>

  <!-- RIGHT: strategies / positions / logs -->
  <div class="right-panel">
    <div class="rpanel-sec" style="max-height:190px">
      <div class="phdr">전략 목록</div>
      <div id="strat-list" class="rpanel-body"></div>
    </div>
    <div class="rpanel-sec" style="max-height:160px">
      <div class="phdr">포지션</div>
      <div class="rpanel-body">
        <table>
          <thead><tr><th>종목</th><th class="num">수량</th><th class="num">실현손익</th></tr></thead>
          <tbody id="pos-body"></tbody>
        </table>
      </div>
    </div>
    <div class="rpanel-sec rp-grow">
      <div class="phdr">최근 로그</div>
      <div class="rpanel-body">
        <table>
          <thead><tr><th>시각</th><th>유형</th><th>메시지</th></tr></thead>
          <tbody id="log-body"></tbody>
        </table>
      </div>
    </div>
  </div>

</div><!-- /.layout -->

<script>
/* ---- Utilities ---- */
var $ = function(s) { return document.querySelector(s); };
var jfetch = function(u) { return fetch(u).then(function(r) { return r.json(); }); };
// Escape ALL interpolated values — feed-derived strings (symbols, names, log messages) would
// otherwise be a stored-XSS sink when inserted via innerHTML.
var esc = function(s) { return String(s).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
var cell = function(v, cls) { return '<td' + (cls ? ' class="' + esc(cls) + '"' : '') + '>' + esc(v == null ? '' : v) + '</td>'; };
var numCls = function(n) { return Number(n) > 0 ? 'num pos' : Number(n) < 0 ? 'num neg' : 'num'; };
var pct = function(v) { return (Number(v) * 100).toFixed(2) + '%'; };

/* ---- State ---- */
var activeSymbol = null;
var combine = 'AND';

/* ---- Chart init ---- */
var chart = LightweightCharts.createChart($('#chart'), {
  layout: { background: { color: '#0b0e14' }, textColor: '#c8d3e0' },
  grid: { vertLines: { color: '#131926' }, horzLines: { color: '#131926' } },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#1c2230' },
  timeScale: { borderColor: '#1c2230', timeVisible: true },
  width: $('#chart').offsetWidth || 800,
  height: $('#chart').offsetHeight || 400,
});
var series = chart.addCandlestickSeries({
  upColor: '#26a69a', downColor: '#ef5350',
  borderVisible: false,
  wickUpColor: '#26a69a', wickDownColor: '#ef5350',
});
new ResizeObserver(function() {
  var el = $('#chart');
  chart.applyOptions({ width: el.offsetWidth, height: el.offsetHeight });
}).observe($('#chart'));

function normTime(t) {
  var n = Number(t);
  return n > 1e10 ? Math.floor(n / 1000) : n;
}

/* ---- Symbol search (debounced) ---- */
var searchTimer = null;
$('#sym-search').addEventListener('input', function() {
  clearTimeout(searchTimer);
  var q = this.value.trim();
  searchTimer = setTimeout(function() { searchSymbols(q); }, 300);
});

function searchSymbols(q) {
  jfetch('/api/market/symbols?q=' + encodeURIComponent(q) + '&limit=40').then(function(list) {
    var el = $('#sym-list');
    if (!Array.isArray(list) || !list.length) {
      el.innerHTML = '<div style="padding:10px 12px;color:#2a3550;font-size:11px;">결과 없음</div>';
      return;
    }
    el.innerHTML = list.map(function(s) {
      var active = activeSymbol === s.symbol ? ' active' : '';
      return '<div class="sym-item' + active + '" data-sym="' + esc(s.symbol) + '">' +
        '<div class="sym-name">' + esc(s.name) + '</div>' +
        '<div class="sym-code">' + esc(s.symbol) + ' \xb7 ' + esc(s.market) + '</div>' +
        '</div>';
    }).join('');
    el.querySelectorAll('.sym-item').forEach(function(item) {
      item.addEventListener('click', function() { selectSymbol(this.dataset.sym); });
    });
  }).catch(function() {});
}

function selectSymbol(sym) {
  activeSymbol = sym;
  document.querySelectorAll('.sym-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.sym === sym);
  });
  $('#chart-hint').style.display = 'none';
  updateButtons();
  // Server returns ChartCandle[] with numeric OHLC and time in epoch seconds — no coercion needed.
  jfetch('/api/market/candles?symbol=' + encodeURIComponent(sym) + '&interval=1d').then(function(candles) {
    if (!Array.isArray(candles)) return;
    // Sort ascending; dedup by time — lightweight-charts throws on duplicate timestamps
    var seen = {};
    var data = candles.slice().sort(function(a, b) { return a.time - b.time; }).filter(function(c) {
      if (seen[c.time]) return false;
      seen[c.time] = true;
      return true;
    }).map(function(c) {
      return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
    });
    series.setData(data);
    series.setMarkers([]);
    chart.timeScale().fitContent();
  }).catch(function() {});
}

// Load initial list
searchSymbols('');

/* ---- Strategy builder ---- */
function paramFields(type, prefix) {
  if (type === 'threshold') {
    return '<label>매수↓</label><input type="number" id="' + prefix + '-buy" value="70000" step="1000">' +
           '<label>매도↑</label><input type="number" id="' + prefix + '-sell" value="80000" step="1000">';
  }
  if (type === 'sma') {
    return '<label>단기</label><input type="number" id="' + prefix + '-fast" value="5" min="1" step="1">' +
           '<label>장기</label><input type="number" id="' + prefix + '-slow" value="20" min="1" step="1">';
  }
  return '';
}

function onTypeChange(prefix) {
  var sel = $('#type-' + prefix);
  var pEl = $('#params-' + prefix);
  var type = sel.value;
  if (type) {
    pEl.innerHTML = paramFields(type, prefix);
    pEl.style.display = 'flex';
  } else {
    pEl.innerHTML = '';
    pEl.style.display = 'none';
  }
  updateButtons();
}

$('#type-a').addEventListener('change', function() { onTypeChange('a'); });
$('#type-b').addEventListener('change', function() { onTypeChange('b'); });

/* AND / OR toggle */
document.querySelectorAll('.and-or button').forEach(function(btn) {
  btn.addEventListener('click', function() {
    combine = this.dataset.v;
    document.querySelectorAll('.and-or button').forEach(function(b) {
      b.classList.toggle('ao-active', b.dataset.v === combine);
    });
  });
});

function updateButtons() {
  var hasA = !!$('#type-a').value;
  var hasB = !!$('#type-b').value;
  var ok = (hasA || hasB) && !!activeSymbol;
  $('#btn-backtest').disabled = !ok;
  $('#btn-deploy').disabled = !ok;
}

function getNum(id, fallback) {
  var v = Number($(id).value);
  return isFinite(v) && v > 0 ? v : fallback;
}

function buildSingleSpec(type, prefix, notional) {
  if (type === 'threshold') {
    return { type: 'threshold', params: { buyBelow: getNum('#' + prefix + '-buy', 70000), sellAbove: getNum('#' + prefix + '-sell', 80000), orderNotional: notional } };
  }
  if (type === 'sma') {
    return { type: 'sma', params: { fastPeriod: getNum('#' + prefix + '-fast', 5), slowPeriod: getNum('#' + prefix + '-slow', 20), orderNotional: notional } };
  }
  return null;
}

function buildSpec() {
  var notional = getNum('#notional', 1000000);
  var typeA = $('#type-a').value;
  var typeB = $('#type-b').value;
  if (typeA && typeB) {
    return { type: 'composite', combine: combine, a: buildSingleSpec(typeA, 'a', notional), b: buildSingleSpec(typeB, 'b', notional), orderNotional: notional };
  }
  if (typeA) return buildSingleSpec(typeA, 'a', notional);
  if (typeB) return buildSingleSpec(typeB, 'b', notional);
  return null;
}

/* ---- 백테스트 ---- */
$('#btn-backtest').addEventListener('click', function() {
  if (!activeSymbol) { alert('종목을 먼저 선택하세요.'); return; }
  var spec = buildSpec();
  if (!spec) { alert('전략을 하나 이상 설정하세요.'); return; }
  fetch('/api/backtest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: activeSymbol, spec: spec }),
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(rd) {
    if (!rd.ok) { alert(esc(rd.d.error || '오류')); return; }
    var data = rd.d;
    // Draw BUY / SELL markers
    var markers = (data.markers || []).map(function(m) {
      return {
        time: normTime(m.time),
        position: m.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: m.side === 'BUY' ? '#26a69a' : '#ef5350',
        shape: m.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: m.side,
      };
    }).sort(function(a, b) { return a.time - b.time; });
    series.setMarkers(markers);
    // Show metrics
    var m = data.metrics || {};
    var ret = Number(m.totalReturn) || 0;
    var mdd = Number(m.maxDrawdown) || 0;
    var wr = Number(m.winRate) || 0;
    var pf = Number(m.profitFactor) || 0;
    var tc = Number(m.tradeCount) || 0;
    $('#m-ret').textContent = pct(ret);
    $('#m-ret').className = 'mval ' + (ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neu');
    $('#m-mdd').textContent = pct(mdd);
    $('#m-mdd').className = 'mval neg';
    $('#m-wr').textContent = pct(wr);
    $('#m-wr').className = 'mval ' + (wr >= 0.5 ? 'pos' : 'neg');
    $('#m-pf').textContent = pf.toFixed(2);
    $('#m-pf').className = 'mval ' + (pf >= 1 ? 'pos' : 'neg');
    $('#m-tc').textContent = String(tc);
    $('#m-tc').className = 'mval neu';
    var strip = $('#metrics-strip');
    strip.style.display = 'flex';
  }).catch(function() {});
});

/* ---- 페이퍼 배포 ---- */
$('#btn-deploy').addEventListener('click', function() {
  if (!activeSymbol) { alert('종목을 먼저 선택하세요.'); return; }
  var spec = buildSpec();
  if (!spec) { alert('전략을 하나 이상 설정하세요.'); return; }
  var typeA = $('#type-a').value;
  var typeB = $('#type-b').value;
  var suffix = typeA && typeB ? combine.toLowerCase() : (typeA || typeB);
  var name = activeSymbol + '-' + suffix;
  var token = localStorage.getItem('apiToken') || '';
  fetch('/api/strategies', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': token },
    body: JSON.stringify({ symbol: activeSymbol, spec: spec, name: name }),
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(rd) {
    if (!rd.ok) { alert(esc(rd.d.error || '배포 실패')); return; }
    refreshStrategies();
  }).catch(function() {});
});

/* ---- 긴급 정지 / 재개 ---- */
$('#stop-btn').addEventListener('click', function() {
  var halted = $('#halt-pill').classList.contains('halt-stopped');
  if (!halted && !confirm('모든 신규 주문을 즉시 차단합니다. 계속?')) return;
  var token = localStorage.getItem('apiToken') || '';
  fetch(halted ? '/api/resume' : '/api/emergency-stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-token': token },
    body: JSON.stringify(halted ? {} : { reason: 'dashboard' }),
  }).then(function() { refreshAll(); }).catch(function() {});
});

/* ---- Right-panel refresh ---- */
function refreshStrategies() {
  jfetch('/api/strategies').then(function(strats) {
    var el = $('#strat-list');
    if (!Array.isArray(strats) || !strats.length) {
      el.innerHTML = '<div style="padding:9px 12px;color:#2a3550;font-size:11px;">배포된 전략 없음</div>';
      return;
    }
    el.innerHTML = strats.map(function(s) {
      return '<div class="sitem">' +
        '<div class="sitem-info">' +
          '<div class="sitem-name">' + esc(s.name) + '</div>' +
          '<div class="sitem-meta">' + esc(s.status) + ' \xb7 ' + esc((s.symbols || []).join(', ')) + '</div>' +
        '</div>' +
        '<button class="sitem-del" data-id="' + esc(s.id) + '">✕</button>' +
      '</div>';
    }).join('');
    el.querySelectorAll('.sitem-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = encodeURIComponent(this.dataset.id);
        var tok = localStorage.getItem('apiToken') || '';
        fetch('/api/strategies/' + id, { method: 'DELETE', headers: { 'x-api-token': tok } })
          .then(function() { refreshStrategies(); }).catch(function() {});
      });
    });
  }).catch(function() {});
}

function refreshPositions() {
  jfetch('/api/positions').then(function(pos) {
    if (!Array.isArray(pos)) return;
    $('#pos-body').innerHTML = pos.map(function(p) {
      return '<tr>' + cell(p.symbol) + cell(p.quantity, 'num') + cell(p.realizedPnl, numCls(p.realizedPnl)) + '</tr>';
    }).join('');
  }).catch(function() {});
}

function refreshLogs() {
  jfetch('/api/logs?limit=20').then(function(logs) {
    if (!Array.isArray(logs)) return;
    $('#log-body').innerHTML = logs.slice().reverse().map(function(l) {
      return '<tr>' + cell(new Date(l.at).toLocaleTimeString()) + cell(l.type) + cell(l.message || '') + '</tr>';
    }).join('');
  }).catch(function() {});
}

function refreshHalt() {
  jfetch('/api/halt').then(function(halt) {
    var pill = $('#halt-pill');
    pill.textContent = halt.halted ? ('정지됨: ' + (halt.reason || '')) : '정상';
    pill.className = halt.halted ? 'halt-stopped' : 'halt-ok';
    var btn = $('#stop-btn');
    btn.textContent = halt.halted ? '재개' : '긴급 정지';
    btn.className = halt.halted ? 'resume' : '';
  }).catch(function() {});
}

function refreshAll() {
  refreshHalt();
  refreshStrategies();
  refreshPositions();
  refreshLogs();
}

refreshAll();
setInterval(refreshAll, 3000);
<\/script>
</body>
</html>`;

const BAD = Symbol('bad-mode');

// Returns a TradingMode (default PAPER), or sends 400 and returns BAD for an unknown mode.
function parseModeOr(v: string | undefined, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): TradingMode | typeof BAD {
  if (v === undefined) return 'PAPER';
  if (MODES.includes(v as TradingMode)) return v as TradingMode;
  reply.code(400).send({ error: `mode must be one of ${MODES.join(', ')}` });
  return BAD;
}
