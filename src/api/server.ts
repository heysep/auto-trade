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

  // --- factor ranking ---
  app.get('/api/factors/ranking', async (req, reply) => {
    const q = req.query as { limit?: string };
    let limit: number | undefined;
    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (Number.isInteger(n) && n > 0) limit = n;
    }
    const result = limit !== undefined
      ? await system.factorRanking(limit)
      : await system.factorRanking();
    if ('error' in result) {
      return reply.code(result.code).send({ error: result.error });
    }
    return result;
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
:root{color-scheme:dark;--lw:240px;--rw:320px;--bh:200px;--bd:#1c2230;--bg:#0b0e14;--pn:#131722;--tx:#d1d4dc;--mu:#7d8aa0;--ac:#26a69a;--dn:#ef5350}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;flex-direction:column;height:100vh;overflow:hidden}
/* ---- top bar ---- */
#topbar{display:flex;align-items:center;gap:10px;padding:0 16px;height:44px;border-bottom:1px solid var(--bd);flex-shrink:0;background:var(--pn)}
.brand{font-size:13px;font-weight:700;letter-spacing:.06em;color:#e6edf6;white-space:nowrap}
.tb-div{width:1px;height:18px;background:var(--bd);flex-shrink:0}
#active-sym-display{font-size:13px;font-weight:700;color:var(--mu);font-variant-numeric:tabular-nums;letter-spacing:.02em}
#active-price-display{font-size:12px;color:var(--mu);font-variant-numeric:tabular-nums}
#halt-pill{margin-left:auto;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;white-space:nowrap}
.halt-ok{background:#10331f;color:#26a69a}
.halt-stopped{background:#3a1418;color:#ef5350}
#stop-btn{padding:4px 12px;border-radius:4px;border:1px solid #5a1622;cursor:pointer;font:inherit;font-size:11px;font-weight:600;background:#7a1622;color:#fff;white-space:nowrap}
#stop-btn.resume{background:#0e3020;border-color:#1a5040;color:#26a69a}
/* ---- main body ---- */
#app-body{display:grid;grid-template-columns:var(--lw) 4px 1fr 4px var(--rw);flex:1;overflow:hidden;min-height:0}
/* ---- splitters ---- */
.spv{background:var(--bd);cursor:col-resize;transition:background .15s;user-select:none}
.spv:hover,.spv.drag{background:#2d3d58}
#sp-bottom{height:4px;background:var(--bd);cursor:row-resize;flex-shrink:0;transition:background .15s;user-select:none}
#sp-bottom:hover,#sp-bottom.drag{background:#2d3d58}
/* ---- panels ---- */
.panel{background:var(--pn);display:flex;flex-direction:column;overflow:hidden;min-height:0}
.phdr{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--mu);padding:8px 12px 6px;border-bottom:1px solid var(--bd);flex-shrink:0}
/* ---- left panel ---- */
#panel-left{border-right:1px solid var(--bd)}
#sym-search{display:block;background:#0f1520;color:var(--tx);border:1px solid var(--bd);border-radius:4px;padding:6px 10px;font:inherit;font-size:12px;margin:8px 10px 6px;outline:none;width:calc(100% - 20px)}
#sym-search:focus{border-color:#3d5a8a}
#sym-list{flex:1;overflow-y:auto}
.sym-item{padding:7px 12px;cursor:pointer;border-bottom:1px solid #0d1219;transition:background .1s}
.sym-item:hover{background:#0d1421}
.sym-item.active{background:#111d35;border-left:2px solid var(--ac)}
.sym-name{color:#e6edf6;font-size:12px;line-height:1.3}
.sym-code{color:var(--mu);font-size:10px;margin-top:2px}
.sym-tag{display:inline-block;font-size:9px;padding:1px 4px;border-radius:3px;background:#1c2230;color:var(--mu);margin-left:4px;vertical-align:middle}
/* ---- center panel ---- */
#panel-center{display:flex;flex-direction:column;overflow:hidden;min-width:0;background:var(--bg)}
.chart-bar{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:1px solid var(--bd);flex-shrink:0;background:var(--pn)}
#chart-sym-label{font-size:12px;color:var(--mu);font-weight:600}
.int-tabs{display:flex;gap:2px;margin-left:6px}
.int-btn{background:none;border:1px solid transparent;color:var(--mu);border-radius:3px;padding:2px 8px;cursor:pointer;font:inherit;font-size:11px}
.int-btn:hover{color:var(--tx);border-color:var(--bd)}
.int-btn.active{background:#1a2440;color:#5a9eff;border-color:#1c3060}
#chart-container{flex:1;position:relative;min-height:0}
#chart{width:100%;height:100%}
#chart-hint{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#2a3550;font-size:13px;pointer-events:none;white-space:nowrap;text-align:center}
/* ---- right panel ---- */
#panel-right{border-left:1px solid var(--bd);overflow-y:auto}
.bsec{padding:10px 12px;border-bottom:1px solid var(--bd)}
.bsec-title{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--mu);margin-bottom:8px}
.brow{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.blabel{color:var(--mu);font-size:11px;min-width:14px;flex-shrink:0;font-weight:600}
select,input[type="number"]{background:#0f1520;color:var(--tx);border:1px solid var(--bd);border-radius:4px;padding:4px 7px;font:inherit;font-size:11px;outline:none;min-width:0}
select{flex:1}
select:focus,input[type="number"]:focus{border-color:#3d5a8a}
.params-wrap{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-bottom:4px;padding-left:20px}
.params-wrap label{color:var(--mu);font-size:10px;white-space:nowrap}
.params-wrap input{width:70px}
.and-or-row{display:flex;justify-content:center;margin:6px 0}
.and-or{display:flex;border:1px solid var(--bd);border-radius:4px;overflow:hidden}
.and-or button{background:#0f1520;color:var(--mu);border:0;padding:3px 14px;cursor:pointer;font:inherit;font-size:11px}
.and-or button.ao-active{background:#1a2440;color:#5a9eff}
.notional-row{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.notional-row label{color:var(--mu);font-size:11px;white-space:nowrap}
.notional-row input{flex:1}
.action-row{display:flex;gap:6px}
.btn-bt{flex:1;background:#0e2040;color:#5a9eff;border:1px solid #1c3d7a;border-radius:4px;padding:6px 8px;cursor:pointer;font:inherit;font-size:11px;font-weight:600}
.btn-bt:hover:not(:disabled){background:#142a5a}
.btn-dp{flex:1;background:#0e3020;color:#26a69a;border:1px solid #1a5040;border-radius:4px;padding:6px 8px;cursor:pointer;font:inherit;font-size:11px;font-weight:600}
.btn-dp:hover:not(:disabled){background:#143d2a}
.btn-bt:disabled,.btn-dp:disabled{opacity:.35;cursor:not-allowed}
/* ---- metrics ---- */
#metrics-strip{display:none;flex-wrap:wrap;gap:8px;padding:8px 12px;border-bottom:1px solid var(--bd)}
.metric{display:flex;flex-direction:column;min-width:52px}
.mlabel{font-size:9px;color:var(--mu);text-transform:uppercase;letter-spacing:.05em}
.mval{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.pos{color:#26a69a}.neg{color:#ef5350}.neu{color:var(--tx)}
/* ---- bottom panel ---- */
#panel-bottom{height:var(--bh);flex-shrink:0;background:var(--pn);display:flex;flex-direction:column}
.tab-bar{display:flex;border-bottom:1px solid var(--bd);flex-shrink:0;background:var(--bg);padding:0 8px}
.tab-btn{background:none;border:0;border-bottom:2px solid transparent;color:var(--mu);padding:7px 12px;cursor:pointer;font:inherit;font-size:11px;margin-bottom:-1px}
.tab-btn:hover{color:var(--tx)}
.tab-btn.active{color:#5a9eff;border-bottom-color:#5a9eff}
.tab-content{flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.tab-pane{flex:1;overflow-y:auto;min-height:0}
/* ---- tables ---- */
table{width:100%;border-collapse:collapse;font-size:11px}
th,td{text-align:left;padding:5px 10px;border-bottom:1px solid #0d1219}
th{color:var(--mu);font-weight:500;position:sticky;top:0;background:var(--pn);z-index:1;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
td.num{text-align:right;font-variant-numeric:tabular-nums}
/* ---- strategy items ---- */
.sitem{display:flex;align-items:center;padding:7px 10px;border-bottom:1px solid #0d1219;gap:8px}
.sitem-info{flex:1;min-width:0}
.sitem-name{color:#e6edf6;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sitem-meta{color:var(--mu);font-size:10px;margin-top:1px}
.sitem-del{background:none;color:#ef5350;border:1px solid #3a1418;border-radius:3px;padding:2px 6px;cursor:pointer;font:inherit;font-size:10px;flex-shrink:0}
.sitem-del:hover{background:#3a1418}
/* ---- misc ---- */
.empty{padding:12px 14px;color:#2a3550;font-size:11px}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#1c2230;border-radius:2px}
::-webkit-scrollbar-thumb:hover{background:#2d3d58}
</style>
</head>
<body>

<div id="topbar">
  <span class="brand">auto-trading</span>
  <span class="tb-div"></span>
  <span id="active-sym-display">&#x2014;</span>
  <span id="active-price-display"></span>
  <span id="halt-pill" class="halt-ok">정상</span>
  <button id="stop-btn">긴급 정지</button>
</div>

<div id="app-body">

  <!-- LEFT: symbol search -->
  <div class="panel" id="panel-left">
    <div class="phdr">종목 검색</div>
    <input id="sym-search" type="text" placeholder="종목명 또는 코드…" autocomplete="off" spellcheck="false">
    <div id="sym-list"><div class="empty">검색 중…</div></div>
  </div>

  <div class="spv" id="sp-left"></div>

  <!-- CENTER: chart -->
  <div id="panel-center">
    <div class="chart-bar">
      <span id="chart-sym-label">종목 미선택</span>
      <div class="int-tabs">
        <button class="int-btn active" data-iv="1d" id="int-1d">일봉</button>
        <button class="int-btn" data-iv="1m" id="int-1m">1분</button>
      </div>
    </div>
    <div id="chart-container">
      <div id="chart"></div>
      <div id="chart-hint">종목을 선택하면 차트가 표시됩니다</div>
    </div>
  </div>

  <div class="spv" id="sp-right"></div>

  <!-- RIGHT: strategy builder -->
  <div class="panel" id="panel-right">
    <div class="phdr">전략 빌더</div>

    <div class="bsec">
      <div class="bsec-title">인디케이터</div>

      <div class="brow">
        <span class="blabel">A</span>
        <select id="type-a">
          <option value="">전략 없음</option>
          <option value="tsmom">시계열 모멘텀(TSMOM)</option>
        </select>
      </div>
      <div id="params-a" class="params-wrap" style="display:none"></div>

      <div class="and-or-row">
        <div class="and-or">
          <button id="btn-and" class="ao-active" data-v="AND">AND</button>
          <button id="btn-or" data-v="OR">OR</button>
        </div>
      </div>

      <div class="brow">
        <span class="blabel">B</span>
        <select id="type-b">
          <option value="">전략 없음</option>
          <option value="tsmom">시계열 모멘텀(TSMOM)</option>
        </select>
      </div>
      <div id="params-b" class="params-wrap" style="display:none"></div>
    </div>

    <div class="bsec">
      <div class="notional-row">
        <label for="notional">주문금액</label>
        <input type="number" id="notional" value="1000000" min="1" step="100000">
      </div>
      <div class="action-row">
        <button class="btn-bt" id="btn-backtest" disabled>백테스트</button>
        <button class="btn-dp" id="btn-deploy" disabled>페이퍼 배포</button>
      </div>
    </div>

    <div id="metrics-strip" style="display:none">
      <div class="metric"><span class="mlabel">수익률</span><span class="mval" id="m-ret"></span></div>
      <div class="metric"><span class="mlabel">MDD</span><span class="mval" id="m-mdd"></span></div>
      <div class="metric"><span class="mlabel">승률</span><span class="mval" id="m-wr"></span></div>
      <div class="metric"><span class="mlabel">PF</span><span class="mval" id="m-pf"></span></div>
      <div class="metric"><span class="mlabel">거래수</span><span class="mval" id="m-tc"></span></div>
    </div>
  </div>

</div><!-- /#app-body -->

<div id="sp-bottom"></div>

<!-- BOTTOM: tabbed panel -->
<div id="panel-bottom">
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="positions">포지션</button>
    <button class="tab-btn" data-tab="strategies">전략목록</button>
    <button class="tab-btn" data-tab="logs">로그</button>
  </div>
  <div class="tab-content">
    <div id="tab-positions" class="tab-pane">
      <table>
        <thead><tr><th>종목</th><th class="num">수량</th><th class="num">실현손익</th></tr></thead>
        <tbody id="pos-body"></tbody>
      </table>
    </div>
    <div id="tab-strategies" class="tab-pane" style="display:none">
      <div id="strat-list"></div>
    </div>
    <div id="tab-logs" class="tab-pane" style="display:none">
      <table>
        <thead><tr><th>시각</th><th>유형</th><th>메시지</th></tr></thead>
        <tbody id="log-body"></tbody>
      </table>
    </div>
  </div>
</div>

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

/* ---- Panel sizes (localStorage persistence) ---- */
var LW_KEY = 'tv_lw', RW_KEY = 'tv_rw', BH_KEY = 'tv_bh';
var panelLW = parseInt(localStorage.getItem(LW_KEY) || '240', 10) || 240;
var panelRW = parseInt(localStorage.getItem(RW_KEY) || '320', 10) || 320;
var panelBH = parseInt(localStorage.getItem(BH_KEY) || '200', 10) || 200;
if (panelLW < 120) panelLW = 240;
if (panelRW < 160) panelRW = 320;
if (panelBH < 60) panelBH = 200;
function applyPanelSizes() {
  document.documentElement.style.setProperty('--lw', panelLW + 'px');
  document.documentElement.style.setProperty('--rw', panelRW + 'px');
  document.documentElement.style.setProperty('--bh', panelBH + 'px');
}
applyPanelSizes();

/* ---- Splitter drag ---- */
function makeSplitter(id, onDelta) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mousedown', function(e) {
    e.preventDefault();
    el.classList.add('drag');
    var lx = e.clientX, ly = e.clientY;
    function onMove(ev) {
      var dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      onDelta(dx, dy);
    }
    function onUp() {
      el.classList.remove('drag');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
makeSplitter('sp-left', function(dx) {
  panelLW = Math.max(120, Math.min(500, panelLW + dx));
  localStorage.setItem(LW_KEY, String(panelLW));
  document.documentElement.style.setProperty('--lw', panelLW + 'px');
  if (chart) chart.applyOptions({ width: document.getElementById('chart').offsetWidth });
});
makeSplitter('sp-right', function(dx) {
  panelRW = Math.max(160, Math.min(600, panelRW - dx));
  localStorage.setItem(RW_KEY, String(panelRW));
  document.documentElement.style.setProperty('--rw', panelRW + 'px');
  if (chart) chart.applyOptions({ width: document.getElementById('chart').offsetWidth });
});
makeSplitter('sp-bottom', function(dx, dy) {
  panelBH = Math.max(60, Math.min(500, panelBH - dy));
  localStorage.setItem(BH_KEY, String(panelBH));
  document.documentElement.style.setProperty('--bh', panelBH + 'px');
});

/* ---- Tab switching ---- */
document.querySelectorAll('.tab-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var tab = this.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-pane').forEach(function(p) { p.style.display = 'none'; });
    this.classList.add('active');
    var pane = document.getElementById('tab-' + tab);
    if (pane) pane.style.display = '';
  });
});

/* ---- State ---- */
var activeSymbol = null;
var activeInterval = '1d';
var combine = 'AND';

/* ---- Chart init (hardened: errors are isolated — rest of the page must still work) ---- */
var chart = null;
var series = null;
var chartEl = document.getElementById('chart');
try {
  chart = LightweightCharts.createChart(chartEl, {
    layout: { background: { color: '#0b0e14' }, textColor: '#d1d4dc' },
    grid: { vertLines: { color: '#131722' }, horzLines: { color: '#131722' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1c2230' },
    timeScale: { borderColor: '#1c2230', timeVisible: true },
    width: chartEl.offsetWidth || 800,
    height: chartEl.offsetHeight || 400,
  });
  series = chart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  });
  new ResizeObserver(function() {
    if (!chart) return;
    chart.applyOptions({ width: chartEl.offsetWidth, height: chartEl.offsetHeight });
  }).observe(chartEl);
} catch (chartErr) {
  console.error('[chart] init failed:', chartErr);
  var hintEl = document.getElementById('chart-hint');
  if (hintEl) { hintEl.textContent = 'chart unavailable'; hintEl.style.color = '#ef5350'; }
}

function normTime(t) {
  var n = Number(t);
  return n > 1e10 ? Math.floor(n / 1000) : n;
}

/* ---- Interval toggle ---- */
document.querySelectorAll('.int-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    activeInterval = this.dataset.iv;
    document.querySelectorAll('.int-btn').forEach(function(b) { b.classList.remove('active'); });
    this.classList.add('active');
    if (activeSymbol) loadCandles(activeSymbol);
  });
});

/* ---- Symbol search (debounced) ---- */
var searchTimer = null;
document.getElementById('sym-search').addEventListener('input', function() {
  clearTimeout(searchTimer);
  var q = this.value.trim();
  searchTimer = setTimeout(function() { searchSymbols(q); }, 300);
});

function searchSymbols(q) {
  jfetch('/api/market/symbols?q=' + encodeURIComponent(q) + '&limit=40').then(function(list) {
    var el = document.getElementById('sym-list');
    if (!Array.isArray(list) || !list.length) {
      el.innerHTML = '<div class="empty">' + (q ? '결과 없음' : '검색 중…') + '</div>';
      return;
    }
    el.innerHTML = list.map(function(s) {
      var active = activeSymbol === s.symbol ? ' active' : '';
      return '<div class="sym-item' + active + '" data-sym="' + esc(s.symbol) + '">' +
        '<div class="sym-name">' + esc(s.name) + '</div>' +
        '<div class="sym-code">' + esc(s.symbol) + '<span class="sym-tag">' + esc(s.market) + '</span></div>' +
      '</div>';
    }).join('');
    el.querySelectorAll('.sym-item').forEach(function(item) {
      item.addEventListener('click', function() { selectSymbol(this.dataset.sym); });
    });
  }).catch(function() {});
}

function loadCandles(sym) {
  document.getElementById('chart-hint').style.display = 'none';
  jfetch('/api/market/candles?symbol=' + encodeURIComponent(sym) + '&interval=' + activeInterval).then(function(candles) {
    if (!series || !Array.isArray(candles)) return;
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
    if (series.setMarkers) series.setMarkers([]);
    if (chart) chart.timeScale().fitContent();
  }).catch(function() {});
}

function selectSymbol(sym) {
  activeSymbol = sym;
  document.querySelectorAll('.sym-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.sym === sym);
  });
  var dispEl = document.getElementById('active-sym-display');
  dispEl.textContent = sym;
  dispEl.style.color = '#e6edf6';
  var lblEl = document.getElementById('chart-sym-label');
  lblEl.textContent = sym;
  lblEl.style.color = '#e6edf6';
  updateButtons();
  loadCandles(sym);
}

// Load initial list
searchSymbols('');

/* ---- Strategy builder ---- */
function paramFields(type, prefix) {
  if (type === 'tsmom') {
    return '<label>룩백</label><input type="number" id="' + prefix + '-lookback" value="20" min="1" step="1">' +
           '<label>임계%</label><input type="number" id="' + prefix + '-thresh" value="0" min="0" step="0.1">';
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
  if (type === 'tsmom') {
    var lookback = Math.max(1, Math.round(getNum('#' + prefix + '-lookback', 20)));
    var threshPct = Number($('#' + prefix + '-thresh').value);
    var thresh = isFinite(threshPct) && threshPct >= 0 ? threshPct / 100 : 0;
    return { type: 'tsmom', params: { lookback: lookback, threshold: thresh, orderNotional: notional } };
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
    if (series) {
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
    }
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
    $('#metrics-strip').style.display = 'flex';
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

/* ---- Data refresh ---- */
function refreshStrategies() {
  jfetch('/api/strategies').then(function(strats) {
    var el = document.getElementById('strat-list');
    if (!Array.isArray(strats) || !strats.length) {
      el.innerHTML = '<div class="empty">배포된 전략 없음</div>';
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
    document.getElementById('pos-body').innerHTML = pos.map(function(p) {
      return '<tr>' + cell(p.symbol) + cell(p.quantity, 'num') + cell(p.realizedPnl, numCls(p.realizedPnl)) + '</tr>';
    }).join('');
  }).catch(function() {});
}

function refreshLogs() {
  jfetch('/api/logs?limit=20').then(function(logs) {
    if (!Array.isArray(logs)) return;
    document.getElementById('log-body').innerHTML = logs.slice().reverse().map(function(l) {
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
