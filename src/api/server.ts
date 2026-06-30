import Fastify, { type FastifyInstance } from 'fastify';
import type { TradingSystem } from '../app/TradingSystem.js';
import type { StrategyStatus, TradingMode } from '../domain/types.js';

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
      if (req.method === 'POST' || req.method === 'PATCH') {
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

  return app;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>auto-trading</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0e14; color:#c8d3e0; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid #1c2230; }
  header h1 { font-size:15px; margin:0; letter-spacing:.04em; color:#e6edf6; }
  #halt { margin-left:auto; padding:4px 10px; border-radius:6px; font-weight:600; }
  .ok { background:#10331f; color:#5ad17f; } .stopped { background:#3a1418; color:#ff6b78; }
  button { background:#7a1622; color:#fff; border:0; padding:7px 14px; border-radius:6px; cursor:pointer; font:inherit; font-weight:600; }
  button.resume { background:#143a22; color:#5ad17f; }
  main { padding:20px; display:grid; gap:22px; max-width:1100px; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:#7d8aa0; margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid #161b27; }
  th { color:#7d8aa0; font-weight:500; } td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .pos { color:#5ad17f; } .neg { color:#ff6b78; }
</style></head>
<body>
<header><h1>auto-trading</h1><span id="halt" class="ok">…</span>
  <button id="stop">긴급 정지</button></header>
<main>
  <section><h2>전략</h2><table id="strategies"><thead><tr><th>ID</th><th>이름</th><th>상태</th><th>모드</th><th>종목</th></tr></thead><tbody></tbody></table></section>
  <section><h2>포지션 (paper)</h2><table id="positions"><thead><tr><th>전략</th><th>종목</th><th class="num">수량</th><th class="num">평균가</th><th class="num">실현손익</th></tr></thead><tbody></tbody></table></section>
  <section><h2>최근 로그</h2><table id="logs"><thead><tr><th>시각</th><th>유형</th><th>메시지</th></tr></thead><tbody></tbody></table></section>
</main>
<script>
const $ = (s) => document.querySelector(s);
const j = (u) => fetch(u).then(r => r.json());
// Escape ALL interpolated values — feed-derived strings (symbols, error messages) reach
// these cells and would otherwise be a stored-XSS sink via innerHTML.
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cell = (v, cls='') => '<td class="' + cls + '">' + esc(v ?? '') + '</td>';
const numCls = (n) => Number(n) > 0 ? 'num pos' : Number(n) < 0 ? 'num neg' : 'num';
async function refresh() {
  try {
    const [halt, strats, pos, logs] = await Promise.all([
      j('/api/halt'), j('/api/strategies'), j('/api/positions'), j('/api/logs?limit=20')]);
    const h = $('#halt');
    h.textContent = halt.halted ? ('정지됨: ' + (halt.reason||'')) : '정상';
    h.className = halt.halted ? 'stopped' : 'ok';
    $('#stop').textContent = halt.halted ? '재개' : '긴급 정지';
    $('#stop').className = halt.halted ? 'resume' : '';
    $('#strategies tbody').innerHTML = strats.map(s =>
      '<tr>'+cell(s.id)+cell(s.name)+cell(s.status)+cell(s.mode)+cell((s.symbols||[]).join(', '))+'</tr>').join('');
    $('#positions tbody').innerHTML = pos.map(p =>
      '<tr>'+cell(p.strategyId)+cell(p.symbol)+cell(p.quantity,'num')+cell(p.avgPrice,'num')+cell(p.realizedPnl,numCls(p.realizedPnl))+'</tr>').join('');
    $('#logs tbody').innerHTML = logs.slice().reverse().map(l =>
      '<tr>'+cell(new Date(l.at).toLocaleTimeString())+cell(l.type)+cell(l.message||'')+'</tr>').join('');
  } catch (e) { /* transient */ }
}
$('#stop').onclick = async () => {
  const halted = $('#halt').className === 'stopped';
  if (!halted && !confirm('모든 신규 주문을 즉시 차단합니다. 계속?')) return;
  const token = localStorage.getItem('apiToken') || '';
  await fetch(halted ? '/api/resume' : '/api/emergency-stop', {
    method:'POST', headers:{'content-type':'application/json','x-api-token':token},
    body: JSON.stringify(halted ? {} : {reason:'dashboard'}) });
  refresh();
};
refresh(); setInterval(refresh, 3000);
</script></body></html>`;

const BAD = Symbol('bad-mode');

// Returns a TradingMode (default PAPER), or sends 400 and returns BAD for an unknown mode.
function parseModeOr(v: string | undefined, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): TradingMode | typeof BAD {
  if (v === undefined) return 'PAPER';
  if (MODES.includes(v as TradingMode)) return v as TradingMode;
  reply.code(400).send({ error: `mode must be one of ${MODES.join(', ')}` });
  return BAD;
}
