import Fastify, { type FastifyInstance } from 'fastify';
import type { TradingSystem } from '../app/TradingSystem.js';
import type { StrategyStatus, TradingMode } from '../domain/types.js';
import type { StrategySpec } from '../strategy/strategySpec.js';
import { DASHBOARD_HTML } from './dashboard.js';

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

  // --- factor backtest ---
  app.post('/api/factors/backtest', async (req, reply) => {
    const body = (req.body ?? {}) as { topN?: unknown; rebalanceEvery?: unknown; startCapital?: unknown };

    if (body.topN !== undefined) {
      const n = Number(body.topN);
      if (!Number.isInteger(n) || n <= 0) {
        return reply.code(400).send({ error: 'topN must be a positive integer' });
      }
      if (n > 50) {
        return reply.code(400).send({ error: 'topN must be ≤ 50' });
      }
    }
    if (body.rebalanceEvery !== undefined) {
      const n = Number(body.rebalanceEvery);
      if (!Number.isInteger(n) || n <= 0) {
        return reply.code(400).send({ error: 'rebalanceEvery must be a positive integer' });
      }
      if (n > 250) {
        return reply.code(400).send({ error: 'rebalanceEvery must be ≤ 250' });
      }
    }
    if (body.startCapital !== undefined) {
      const n = Number(body.startCapital);
      if (!Number.isFinite(n) || n <= 0) {
        return reply.code(400).send({ error: 'startCapital must be a positive number' });
      }
      if (n > 1e12) {
        return reply.code(400).send({ error: 'startCapital must be ≤ 1e12' });
      }
    }

    const params = {
      ...(body.topN !== undefined ? { topN: Number(body.topN) } : {}),
      ...(body.rebalanceEvery !== undefined ? { rebalanceEvery: Number(body.rebalanceEvery) } : {}),
      ...(body.startCapital !== undefined ? { startCapital: Number(body.startCapital) } : {}),
    };

    const result = Object.keys(params).length > 0
      ? await system.factorBacktest(params)
      : await system.factorBacktest();

    if ('error' in result) {
      return reply.code(result.code).send({ error: result.error });
    }
    return result;
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

  // --- factor portfolio rebalance ---
  app.post('/api/factors/rebalance', async (_req, reply) => {
    const result = await system.rebalanceFactorPortfolio();
    if ('error' in result) {
      return reply.code(result.code).send({ error: result.error });
    }
    return result;
  });

  // --- auto-rebalance scheduler control ---
  app.get('/api/factors/autorebalance', async (_req, reply) => {
    const result = system.autoRebalanceStatus();
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result;
  });

  app.post('/api/factors/autorebalance', async (req, reply) => {
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled (boolean) is required' });
    }
    const result = system.setAutoRebalance(body.enabled);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result;
  });

  // --- real account holdings (read-only, no auth) ---
  app.get('/api/account/holdings', async (_req, reply) => {
    const result = await system.accountHoldings();
    if ('error' in result) {
      return reply.code(result.code).send({ error: result.error });
    }
    return result;
  });

  app.get('/api/performance', async (req, reply) => {
    const q = (req.query as Record<string, string | undefined>);
    const rawId = q['strategyId'];
    const id = rawId !== undefined ? Number(rawId) : NaN;
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'strategyId must be a positive integer' });
    }
    const mode = parseModeOr(q['mode'], reply);
    if (mode === BAD) return;
    const result = system.performance(id, mode);
    if ('error' in result) return reply.code(result.code).send({ error: result.error });
    return result;
  });

  // --- DCA compare ---
  app.post('/api/dca/compare', async (req, reply) => {
    const body = (req.body ?? {}) as {
      symbol?: unknown;
      plans?: unknown;
      historyCount?: unknown;
      from?: unknown;
      to?: unknown;
    };
    const result = await system.dcaCompare({
      symbol: body.symbol,
      plans:  body.plans,
      ...(body.historyCount !== undefined ? { historyCount: body.historyCount } : {}),
      ...(body.from !== undefined ? { from: body.from } : {}),
      ...(body.to   !== undefined ? { to:   body.to   } : {}),
    });
    if ('error' in result) {
      return reply.code(result.code).send({ error: result.error });
    }
    return result;
  });

  // --- DCA symbol search (forwards to KRX catalog; US symbols like SPY return []) ---
  app.get('/api/dca/symbols', async (req) => {
    const q = req.query as { q?: string };
    return system.searchSymbols(q.q ?? '');
  });

  return app;
}


const BAD = Symbol('bad-mode');

// Returns a TradingMode (default PAPER), or sends 400 and returns BAD for an unknown mode.
function parseModeOr(v: string | undefined, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): TradingMode | typeof BAD {
  if (v === undefined) return 'PAPER';
  if (MODES.includes(v as TradingMode)) return v as TradingMode;
  reply.code(400).send({ error: `mode must be one of ${MODES.join(', ')}` });
  return BAD;
}
