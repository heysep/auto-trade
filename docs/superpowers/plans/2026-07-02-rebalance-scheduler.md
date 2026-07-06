# Auto-Rebalance Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, halt-gated, trading-day-aware periodic scheduler that calls `TradingSystem.rebalanceFactorPortfolio()` on KR trading days (PAPER only), controllable via env flag and REST API.

**Architecture:** `RebalanceScheduler` (injectable interval/clock, overlap guard, halt+trading-day gates) is wired in `bootstrap()` only when the factor portfolio is present; `TradingSystem` delegates to it via `autoRebalanceStatus()` / `setAutoRebalance()`; two new API routes expose the control plane. `MarketCalendar` gains a sync `isTradingDaySync(market)` helper that uses the already-populated cache.

**Tech Stack:** TypeScript (strict, ESM `.js` imports), Vitest, Fastify, injectable `setInterval`/`clearInterval` for tests.

## Global Constraints

- `exactOptionalPropertyTypes: true` — never add a property that might be `undefined`; use a union type instead.
- `noUncheckedIndexedAccess: true` — all array/map access must be guarded.
- ESM `.js` imports everywhere (even when importing `.ts` source files).
- PAPER only — no LIVE trading or promotion gates.
- Halt-aware: when `isHalted()` is true, do NOT call `rebalance`.
- Trading-day gated: skip on weekends/holidays.
- Timer failures must never crash the process.
- Injectable `setIntervalFn` / `clearIntervalFn` / `now` for deterministic tests.
- Never log secrets (env key names ok; values never).
- No scratch files committed.

---

## File Map

| Path | Action | Responsibility |
|---|---|---|
| `src/factor/RebalanceScheduler.ts` | CREATE | Core scheduler class |
| `src/factor/RebalanceScheduler.test.ts` | CREATE | TDD tests |
| `src/market/MarketCalendar.ts` | MODIFY | Add `isTradingDaySync(market)` |
| `src/market/MarketCalendar.test.ts` | MODIFY | Tests for new method |
| `src/app/TradingSystem.ts` | MODIFY | Add `rebalanceScheduler` dep + 2 methods |
| `src/api/server.ts` | MODIFY | 2 new routes (`GET/POST /api/factors/autorebalance`) |
| `src/api/server.test.ts` | MODIFY | Tests for 2 new routes |
| `src/index.ts` | MODIFY | Wire scheduler in bootstrap |

---

### Task 1: RebalanceScheduler — tests first (TDD red phase)

**Files:**
- Create: `src/factor/RebalanceScheduler.test.ts`

**Interfaces (consumed by tests):**
```typescript
export interface RebalanceSchedulerDeps {
  rebalance: () => Promise<unknown>;
  isHalted: () => boolean;
  isTradingDay: () => boolean;
  intervalMs: number;
  logger?: { log: (e: unknown) => void };
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
}
export class RebalanceScheduler {
  constructor(deps: RebalanceSchedulerDeps);
  start(): void;
  stop(): void;
  async tick(): Promise<void>;
  get enabled(): boolean;
  get intervalMs(): number;
  lastRun(): { at: number; ok: boolean; note?: string } | undefined;
}
```

- [ ] **Step 1: Write the test file**

```typescript
// src/factor/RebalanceScheduler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { RebalanceScheduler } from './RebalanceScheduler.js';

describe('RebalanceScheduler', () => {
  describe('tick()', () => {
    it('calls rebalance and records ok when trading day and not halted', async () => {
      let called = false;
      const s = new RebalanceScheduler({
        rebalance: async () => { called = true; },
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
        now: () => 9000,
      });
      await s.tick();
      expect(called).toBe(true);
      expect(s.lastRun()).toEqual({ at: 9000, ok: true });
    });

    it('skips rebalance and records halted note when halted', async () => {
      let called = false;
      const s = new RebalanceScheduler({
        rebalance: async () => { called = true; },
        isHalted: () => true,
        isTradingDay: () => true,
        intervalMs: 1000,
      });
      await s.tick();
      expect(called).toBe(false);
      expect(s.lastRun()).toMatchObject({ ok: false, note: 'halted' });
    });

    it('skips rebalance on non-trading day', async () => {
      let called = false;
      const s = new RebalanceScheduler({
        rebalance: async () => { called = true; },
        isHalted: () => false,
        isTradingDay: () => false,
        intervalMs: 1000,
      });
      await s.tick();
      expect(called).toBe(false);
      expect(s.lastRun()).toMatchObject({ ok: false, note: 'not a trading day' });
    });

    it('catches rebalance errors, records ok:false with message, does not throw', async () => {
      const s = new RebalanceScheduler({
        rebalance: async () => { throw new Error('fetch failed'); },
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
        now: () => 5000,
      });
      await expect(s.tick()).resolves.toBeUndefined();
      expect(s.lastRun()).toMatchObject({ ok: false, note: 'fetch failed' });
    });

    it('logs the error via logger when rebalance throws', async () => {
      const logged: unknown[] = [];
      const s = new RebalanceScheduler({
        rebalance: async () => { throw new Error('boom'); },
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
        logger: { log: (e) => logged.push(e) },
      });
      await s.tick();
      expect(logged).toHaveLength(1);
    });

    it('overlap guard: second tick() during in-flight rebalance does not call rebalance again', async () => {
      let callCount = 0;
      let resolveRebalance!: () => void;
      const s = new RebalanceScheduler({
        rebalance: () => new Promise<void>((res) => { callCount++; resolveRebalance = res; }),
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
      });
      const t1 = s.tick();   // starts, hangs
      const t2 = s.tick();   // should skip silently (in-flight)
      await t2;               // resolves immediately
      resolveRebalance();     // let t1 finish
      await t1;
      expect(callCount).toBe(1);
    });
  });

  describe('start() / stop() / enabled', () => {
    it('start() arms the injected setInterval; stop() clears it; enabled reflects state', () => {
      const intervalCalls: number[] = [];
      const clearCalls: unknown[] = [];
      const handles: object[] = [];
      const setIntervalFn = (_fn: () => void, ms: number) => {
        const h = {};
        handles.push(h);
        intervalCalls.push(ms);
        return h as ReturnType<typeof setInterval>;
      };
      const clearIntervalFn = (h: ReturnType<typeof setInterval>) => clearCalls.push(h);

      const s = new RebalanceScheduler({
        rebalance: async () => {},
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 86_400_000,
        setIntervalFn,
        clearIntervalFn,
      });

      expect(s.enabled).toBe(false);
      s.start();
      expect(s.enabled).toBe(true);
      expect(intervalCalls).toHaveLength(1);
      expect(intervalCalls[0]).toBe(86_400_000);

      s.start(); // idempotent — must not arm a second interval
      expect(intervalCalls).toHaveLength(1);

      s.stop();
      expect(s.enabled).toBe(false);
      expect(clearCalls).toHaveLength(1);
      expect(clearCalls[0]).toBe(handles[0]);
    });

    it('stop() is safe when not started', () => {
      const s = new RebalanceScheduler({
        rebalance: async () => {},
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 1000,
      });
      expect(() => s.stop()).not.toThrow();
    });
  });

  describe('intervalMs getter', () => {
    it('exposes the configured intervalMs', () => {
      const s = new RebalanceScheduler({
        rebalance: async () => {},
        isHalted: () => false,
        isTradingDay: () => true,
        intervalMs: 7200_000,
      });
      expect(s.intervalMs).toBe(7200_000);
    });
  });
});
```

- [ ] **Step 2: Verify tests fail (file not yet created)**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/RebalanceScheduler.test.ts 2>&1 | tail -10
```
Expected: error — `Cannot find module './RebalanceScheduler.js'`

---

### Task 2: RebalanceScheduler — implementation (TDD green phase)

**Files:**
- Create: `src/factor/RebalanceScheduler.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// src/factor/RebalanceScheduler.ts

export interface RebalanceSchedulerDeps {
  rebalance: () => Promise<unknown>;
  isHalted: () => boolean;
  isTradingDay: () => boolean;
  intervalMs: number;
  logger?: { log: (e: unknown) => void };
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
}

type LastRunRecord =
  | { at: number; ok: true }
  | { at: number; ok: false; note: string };

export class RebalanceScheduler {
  private readonly _now: () => number;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (h: ReturnType<typeof setInterval>) => void;
  private _handle: ReturnType<typeof setInterval> | undefined = undefined;
  private _inFlight = false;
  private _lastRun: LastRunRecord | undefined = undefined;

  constructor(private readonly deps: RebalanceSchedulerDeps) {
    this._now = deps.now ?? Date.now;
    this._setInterval = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = deps.clearIntervalFn ?? clearInterval;
  }

  get enabled(): boolean {
    return this._handle !== undefined;
  }

  get intervalMs(): number {
    return this.deps.intervalMs;
  }

  lastRun(): LastRunRecord | undefined {
    return this._lastRun;
  }

  start(): void {
    if (this._handle !== undefined) return;  // idempotent
    this._handle = this._setInterval(() => { void this.tick(); }, this.deps.intervalMs);
  }

  stop(): void {
    if (this._handle === undefined) return;
    this._clearInterval(this._handle);
    this._handle = undefined;
  }

  async tick(): Promise<void> {
    if (this.deps.isHalted()) {
      this._lastRun = { at: this._now(), ok: false, note: 'halted' };
      return;
    }
    if (!this.deps.isTradingDay()) {
      this._lastRun = { at: this._now(), ok: false, note: 'not a trading day' };
      return;
    }
    if (this._inFlight) return;  // overlap guard — no lastRun update

    this._inFlight = true;
    try {
      await this.deps.rebalance();
      this._lastRun = { at: this._now(), ok: true };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      this._lastRun = { at: this._now(), ok: false, note };
      this.deps.logger?.log(err);
    } finally {
      this._inFlight = false;
    }
  }
}
```

- [ ] **Step 2: Run tests — expect PASS**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/RebalanceScheduler.test.ts 2>&1 | tail -15
```
Expected: all tests pass.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -10
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/factor/RebalanceScheduler.ts src/factor/RebalanceScheduler.test.ts && git commit -m "feat(factor): RebalanceScheduler — halt+trading-day gated interval scheduler (TDD)"
```

---

### Task 3: MarketCalendar sync accessor

**Files:**
- Modify: `src/market/MarketCalendar.ts` (add `isTradingDaySync`)
- Modify: `src/market/MarketCalendar.test.ts` (add tests)

**Why:** The scheduler's `isTradingDay: () => boolean` must be sync; `isMarketOpen` is async. The cached calendar already holds today's session data — expose it synchronously.

- [ ] **Step 1: Add tests to `src/market/MarketCalendar.test.ts`**

Append after the existing `'caches the calendar within cacheMs'` test:

```typescript
  describe('isTradingDaySync', () => {
    it('returns true when cached calendar has a regularMarket session', async () => {
      const fetchCalendar = vi.fn(async () => OPEN);
      const svc = new MarketCalendarService({ fetchCalendar, now: () => at('2026-06-30T03:00:00Z') });
      await svc.isMarketOpen('KR');  // warm the cache
      expect(svc.isTradingDaySync('KR')).toBe(true);
    });

    it('returns false when cached calendar has no regularMarket session (holiday)', async () => {
      const holiday = cal();  // no session
      const fetchCalendar = vi.fn(async () => holiday);
      const svc = new MarketCalendarService({ fetchCalendar, now: () => at('2026-06-30T03:00:00Z') });
      await svc.isMarketOpen('KR');  // warm the cache
      expect(svc.isTradingDaySync('KR')).toBe(false);
    });

    it('returns false on Sunday when cache is empty', () => {
      // Sunday = getDay() === 0; use a Sunday epoch to avoid cache
      // 2026-06-28 is a Sunday
      const svc = new MarketCalendarService({
        fetchCalendar: vi.fn(async () => OPEN),
        now: () => at('2026-06-28T12:00:00Z'),
      });
      // No cache warmed — fallback to weekend check
      expect(svc.isTradingDaySync('KR')).toBe(false);
    });

    it('returns true on a weekday when cache is empty', () => {
      // 2026-06-30 is a Tuesday
      const svc = new MarketCalendarService({
        fetchCalendar: vi.fn(async () => OPEN),
        now: () => at('2026-06-30T12:00:00Z'),
      });
      expect(svc.isTradingDaySync('KR')).toBe(true);
    });
  });
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/market/MarketCalendar.test.ts 2>&1 | tail -10
```
Expected: `isTradingDaySync is not a function`

- [ ] **Step 3: Add `isTradingDaySync` to `MarketCalendarService`**

In `src/market/MarketCalendar.ts`, add after the `isMarketOpen` method:

```typescript
  /** Synchronous trading-day check using the last-fetched calendar cache.
   *  Returns false for weekends; returns true on uncached weekdays (cache miss → best-effort).
   *  Call isMarketOpen() first in the data worker to warm the cache. */
  isTradingDaySync(market: Market): boolean {
    const hit = this.cache.get(market);
    if (hit !== undefined) {
      return parseSession(hit.cal.today?.integrated?.regularMarket) !== null;
    }
    // Cache miss: weekend check only (holidays not detectable without network)
    const day = new Date(this.now()).getDay();
    return day !== 0 && day !== 6;
  }
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/market/MarketCalendar.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/market/MarketCalendar.ts src/market/MarketCalendar.test.ts && git commit -m "feat(market): add MarketCalendarService.isTradingDaySync for sync KR trading-day check"
```

---

### Task 4: TradingSystem passthrough

**Files:**
- Modify: `src/app/TradingSystem.ts`

**Interfaces produced (consumed by Tasks 5 and 6):**
```typescript
// new methods on TradingSystem:
autoRebalanceStatus(): { enabled: boolean; intervalMs: number; lastRun: ReturnType<RebalanceScheduler['lastRun']> } | { error: string; code: 503 }
setAutoRebalance(enabled: boolean): { enabled: boolean; intervalMs: number; lastRun: ReturnType<RebalanceScheduler['lastRun']> } | { error: string; code: 503 }
```

- [ ] **Step 1: Add `rebalanceScheduler` to `TradingSystemDeps` and implement the two methods**

In `src/app/TradingSystem.ts`:

At the top, add import:
```typescript
import type { RebalanceScheduler } from '../factor/RebalanceScheduler.js';
```

In `TradingSystemDeps`, add:
```typescript
  /** Auto-rebalance scheduler. Omitted => autoRebalanceStatus()/setAutoRebalance() return 503. */
  rebalanceScheduler?: RebalanceScheduler;
```

After `rebalanceFactorPortfolio()`, add:
```typescript
  autoRebalanceStatus(): { enabled: boolean; intervalMs: number; lastRun: ReturnType<RebalanceScheduler['lastRun']> } | { error: string; code: number } {
    const sched = this.deps.rebalanceScheduler;
    if (sched === undefined) return { error: 'auto-rebalance scheduler not wired', code: 503 };
    return { enabled: sched.enabled, intervalMs: sched.intervalMs, lastRun: sched.lastRun() };
  }

  setAutoRebalance(enabled: boolean): { enabled: boolean; intervalMs: number; lastRun: ReturnType<RebalanceScheduler['lastRun']> } | { error: string; code: number } {
    const sched = this.deps.rebalanceScheduler;
    if (sched === undefined) return { error: 'auto-rebalance scheduler not wired', code: 503 };
    if (enabled) { sched.start(); } else { sched.stop(); }
    return { enabled: sched.enabled, intervalMs: sched.intervalMs, lastRun: sched.lastRun() };
  }
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -10
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/app/TradingSystem.ts && git commit -m "feat(app): TradingSystem passthrough for auto-rebalance scheduler (503 when absent)"
```

---

### Task 5: API routes + tests

**Files:**
- Modify: `src/api/server.ts` (add 2 routes)
- Modify: `src/api/server.test.ts` (add tests)

**Routes:**
- `GET /api/factors/autorebalance` → `{ enabled, intervalMs, lastRun }`
- `POST /api/factors/autorebalance` body `{ enabled: boolean }` → start/stop, return status

**Auth:** POST requires the auth hook (already wired via `x-api-token`).

- [ ] **Step 1: Add tests to `src/api/server.test.ts`**

At the end, before the closing `}`, add:

```typescript
describe('GET /api/factors/autorebalance', () => {
  it('returns 503 when rebalanceScheduler is absent', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'GET', url: '/api/factors/autorebalance' });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/scheduler not wired/);
  });

  it('returns status when scheduler is present', async () => {
    const scheduler = new RebalanceScheduler({
      rebalance: async () => {},
      isHalted: () => false,
      isTradingDay: () => true,
      intervalMs: 86_400_000,
    });
    const { app } = harness({ rebalanceScheduler: scheduler });
    const res = await app.inject({ method: 'GET', url: '/api/factors/autorebalance' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ enabled: boolean; intervalMs: number }>();
    expect(body.enabled).toBe(false);
    expect(body.intervalMs).toBe(86_400_000);
  });
});

describe('POST /api/factors/autorebalance', () => {
  it('returns 503 when rebalanceScheduler is absent', async () => {
    const { app } = harness();
    const res = await app.inject({
      method: 'POST', url: '/api/factors/autorebalance',
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(503);
  });

  it('starts the scheduler when enabled:true is posted', async () => {
    const setIntervalFn = vi.fn((_fn: () => void, _ms: number) => ({}) as ReturnType<typeof setInterval>);
    const clearIntervalFn = vi.fn();
    const scheduler = new RebalanceScheduler({
      rebalance: async () => {},
      isHalted: () => false,
      isTradingDay: () => true,
      intervalMs: 1000,
      setIntervalFn,
      clearIntervalFn,
    });
    const { app } = harness({ rebalanceScheduler: scheduler });
    const res = await app.inject({
      method: 'POST', url: '/api/factors/autorebalance',
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ enabled: boolean }>().enabled).toBe(true);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
  });

  it('stops the scheduler when enabled:false is posted', async () => {
    const clearIntervalFn = vi.fn();
    const scheduler = new RebalanceScheduler({
      rebalance: async () => {},
      isHalted: () => false,
      isTradingDay: () => true,
      intervalMs: 1000,
      setIntervalFn: (_fn, _ms) => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn,
    });
    scheduler.start();
    const { app } = harness({ rebalanceScheduler: scheduler });
    const res = await app.inject({
      method: 'POST', url: '/api/factors/autorebalance',
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ enabled: boolean }>().enabled).toBe(false);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when enabled field is missing', async () => {
    const scheduler = new RebalanceScheduler({
      rebalance: async () => {},
      isHalted: () => false,
      isTradingDay: () => true,
      intervalMs: 1000,
    });
    const { app } = harness({ rebalanceScheduler: scheduler });
    const res = await app.inject({
      method: 'POST', url: '/api/factors/autorebalance',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
```

And add to the `harness` function signature/body:
```typescript
// In the harness opts type, add:
rebalanceScheduler?: RebalanceScheduler;

// In TradingSystem construction, add:
...(opts.rebalanceScheduler !== undefined ? { rebalanceScheduler: opts.rebalanceScheduler } : {}),
```

And at the top of server.test.ts, add import:
```typescript
import { RebalanceScheduler } from '../factor/RebalanceScheduler.js';
```

- [ ] **Step 2: Run tests — expect FAIL (routes not yet added)**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/api/server.test.ts 2>&1 | tail -15
```
Expected: new tests fail with 404.

- [ ] **Step 3: Add routes to `src/api/server.ts`**

In `buildServer`, right after the `POST /api/factors/rebalance` route and before `return app;`, add:

```typescript
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
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/api/server.test.ts 2>&1 | tail -15
```

- [ ] **Step 5: Full suite**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run 2>&1 | tail -10
```
Expected: all pass (count grows by new tests).

- [ ] **Step 6: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/api/server.ts src/api/server.test.ts && git commit -m "feat(api): GET/POST /api/factors/autorebalance scheduler control endpoints"
```

---

### Task 6: Wire in `src/index.ts` + boot verification

**Files:**
- Modify: `src/index.ts`
- Create: `src/factor/RebalanceScheduler.ts` already done
- Modify: `src/api/server.test.ts` harness already updated

**Env vars:**
- `AUTO_REBALANCE=1` → call `scheduler.start()` on boot
- `REBALANCE_INTERVAL_MS` → interval (default `86_400_000`)

- [ ] **Step 1: Wire into `bootstrap()` in `src/index.ts`**

Add imports at the top:
```typescript
import { RebalanceScheduler } from './factor/RebalanceScheduler.js';
```

After `const system = new TradingSystem({ ... });` and before `const server = buildServer(...)`, add:

```typescript
  const AUTO_REBALANCE = process.env.AUTO_REBALANCE === '1';
  const REBALANCE_INTERVAL_MS = Number(process.env.REBALANCE_INTERVAL_MS ?? '') || 86_400_000;

  // Construct always (API can start it later); auto-start only when AUTO_REBALANCE=1.
  const rebalanceScheduler = new RebalanceScheduler({
    rebalance: () => system.rebalanceFactorPortfolio(),
    isHalted: () => haltSwitch.halted,
    isTradingDay: () => calendar.isTradingDaySync('KR'),
    intervalMs: REBALANCE_INTERVAL_MS,
    logger,
  });
  if (AUTO_REBALANCE) {
    rebalanceScheduler.start();
    logger.log({ type: 'REBALANCE_SCHEDULER_ARMED', message: `[rebalance] auto-scheduler armed, interval=${REBALANCE_INTERVAL_MS}ms`, at: Date.now() });
    console.log(`[rebalance] auto-scheduler armed, interval=${REBALANCE_INTERVAL_MS}ms`);
  }
```

Update the `TradingSystem` construction to include `rebalanceScheduler`:
```typescript
  const system = new TradingSystem({
    // ... existing deps ...
    rebalanceScheduler,
  });
```

Update the `bootstrap()` return value to include the scheduler:
```typescript
  return {
    // ... existing ...
    rebalanceScheduler,
  };
```

Also update the `shutdown` function in `main()` to stop the scheduler:
```typescript
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(saveTimer);
    rebalanceScheduler.stop();
    saveState();
    worker.stop();
    await server.close().catch(() => { /* already closing */ });
  };
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | tail -10
```
Expected: 0 errors.

- [ ] **Step 3: Full test suite**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 4: Boot without AUTO_REBALANCE (must not auto-trade)**

```bash
cd /Users/im-yoseb/auto-trading && timeout 3 npx tsx src/index.ts 2>&1 || true
```
Expected: starts without error, no "[rebalance] auto-scheduler armed" line.

- [ ] **Step 5: Boot with AUTO_REBALANCE=1**

```bash
cd /Users/im-yoseb/auto-trading && AUTO_REBALANCE=1 REBALANCE_INTERVAL_MS=5000 timeout 3 npx tsx src/index.ts 2>&1 || true
```
Expected: "[rebalance] auto-scheduler armed, interval=5000ms" appears in output.

- [ ] **Step 6: Final commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/index.ts && git commit -m "feat(factor): opt-in auto-rebalance scheduler (trading-day + halt gated)"
```

---

### Task 7: Write report

- [ ] **Step 1: Write the report to `.superpowers/sdd/rebalance-scheduler-report.md`**

Include: status, commit hash, one-line test summary, concerns.

---

## Self-Review

**Spec coverage:**
- [x] `RebalanceScheduler` class with all specified methods/getters
- [x] `tick()`: halted skip, non-trading-day skip, overlap guard, throw isolation
- [x] `start()` idempotent, `stop()` clears handle
- [x] Injectable `setIntervalFn`, `clearIntervalFn`, `now`
- [x] `isTradingDaySync` on `MarketCalendarService`
- [x] `TradingSystem.autoRebalanceStatus()` / `setAutoRebalance(enabled)`
- [x] `GET /api/factors/autorebalance`, `POST /api/factors/autorebalance`
- [x] Auth hook covers POST (already wired by `opts.authToken`)
- [x] `src/index.ts` wiring: construct always, start only when `AUTO_REBALANCE=1`
- [x] `REBALANCE_INTERVAL_MS` env var with 24h default
- [x] Log line on start, never log secrets
- [x] 503 when scheduler absent
- [x] Return scheduler from bootstrap
- [x] Shutdown stops the scheduler
- [x] PAPER only — `rebalanceFactorPortfolio()` is already PAPER-only

**Placeholder scan:** None found.

**Type consistency:** All method names match across tasks. `isTradingDaySync(market: Market)` used consistently. `RebalanceScheduler` import path `'../factor/RebalanceScheduler.js'` used in both TradingSystem and server tests.
