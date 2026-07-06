# Factor Portfolio Wire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the committed `FactorPortfolioManager` into the paper pipeline with an HTTP trigger `POST /api/factors/rebalance`, strategy stub id=1000 in StrategyRegistry, full TDD coverage, and a live smoke test.

**Architecture:** `FactorPortfolioManager` is pure orchestration with injected deps. `TradingSystem` gains three new optional deps (`factorPortfolio`, `getPrices`, `factorPortfolioTopN`) and a `rebalanceFactorPortfolio()` method that fetches prices, populates QuoteBook, then delegates to the manager. The HTTP layer is a thin Fastify route that calls this method and maps `'error' in result` → HTTP error code. `index.ts` wires all deps and registers a stub Strategy (id=1000, `evaluate:()=>null`) in the StrategyRegistry only (NOT in StrategyEngine).

**Tech Stack:** TypeScript (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess), Fastify, Vitest, ESM `.js` imports, tsx for smoke test.

## Global Constraints

- PAPER only — `mode:'PAPER'` everywhere; `brokerFor: () => paperBroker` in index.ts; never LIVE
- `FACTOR_PORTFOLIO_STRATEGY_ID = 1000` — module-level constant in `TradingSystem.ts`
- `TossPriceItem.lastPrice` is a STRING — always `Number(item.lastPrice)` before QuoteBook
- `QuoteBook.set({ symbol, currency, bid, ask, last, ts })` — all numbers; use `bid=ask=last=Number(item.lastPrice)`
- `submitIntent` bridge must throw `new Error(...)` (not use `!`) so the manager catches it cleanly
- `getPrices` failure → try/catch → `{ error:'price fetch failed', code:502 }`
- Per-order failure isolation: one failed `submitIntent` → `skipped`, does not abort whole rebalance
- SELLs submitted before BUYs (already handled by FactorPortfolioManager)
- 503 when `factorPortfolio` dep absent; 409 when halted; `'error' in result` discriminant in server
- Auth hook already covers all POSTs — new endpoint gets auth for free
- ESM `.js` import extensions required; `exactOptionalPropertyTypes` — use conditional spread for optional deps
- `noUncheckedIndexedAccess` — guard array element access; `.map()/.filter()` chains are safe
- Never log secrets; never commit scratch files; never wire LIVE broker

---

### Task 1: Add FACTOR_PORTFOLIO_STRATEGY_ID + rebalanceFactorPortfolio() to TradingSystem

**Files:**
- Modify: `src/app/TradingSystem.ts`

**Interfaces:**
- Produces:
  - `FACTOR_PORTFOLIO_STRATEGY_ID: number` (module-level constant = 1000)
  - `TradingSystemDeps.factorPortfolio?: FactorPortfolioManager`
  - `TradingSystemDeps.getPrices?: (symbols:string[]) => Promise<TossPriceItem[]>`
  - `TradingSystemDeps.factorPortfolioTopN?: number`
  - `TradingSystem.rebalanceFactorPortfolio(): Promise<RebalancePlan | { error: string; code: number }>`

- [ ] **Step 1: Add imports to TradingSystem.ts**

At the top of `src/app/TradingSystem.ts`, add after line 15 (after the FactorBacktest import):

```ts
import type { FactorPortfolioManager, RebalancePlan } from '../factor/FactorPortfolioManager.js';
import type { TossPriceItem } from '../toss/types.js';
```

- [ ] **Step 2: Add module-level constant and extend TradingSystemDeps**

After the `GATED` constant on line 27 of `src/app/TradingSystem.ts`, add:

```ts
/** Reserved strategy id for the AQR 4-Factor Portfolio. Never used by StrategyEngine. */
export const FACTOR_PORTFOLIO_STRATEGY_ID = 1000;
```

Then inside `TradingSystemDeps` interface (after `factorBacktest?`), add:

```ts
  /** Factor portfolio manager. Omitted => rebalanceFactorPortfolio() returns 503. */
  factorPortfolio?: FactorPortfolioManager;
  /** Price fetcher for rebalance. Omitted => rebalanceFactorPortfolio() returns 503. */
  getPrices?: (symbols: string[]) => Promise<TossPriceItem[]>;
  /** Top-N override for rebalance. Default: 10. */
  factorPortfolioTopN?: number;
```

- [ ] **Step 3: Add rebalanceFactorPortfolio() method to TradingSystem class**

Add after the `factorRanking()` method (around line 196), before `backtest()`:

```ts
  /**
   * Fetch live prices for top-N ranked symbols UNION held symbols, populate QuoteBook,
   * then call FactorPortfolioManager.rebalance().
   * Returns 503 when factorPortfolio or getPrices dep is absent.
   * Returns 409 when halted.
   * Returns 502 when price fetch fails.
   */
  async rebalanceFactorPortfolio(): Promise<RebalancePlan | { error: string; code: number }> {
    const mgr = this.deps.factorPortfolio;
    const getPrices = this.deps.getPrices;
    if (mgr === undefined || getPrices === undefined) {
      return { error: 'factor portfolio unavailable', code: 503 };
    }
    if (this.deps.haltSwitch.halted) {
      return { error: 'trading halted', code: 409 };
    }

    const topN = this.deps.factorPortfolioTopN ?? 10;

    // Get ranking to know which symbols to fetch prices for
    const rankingSvc = this.deps.factorRanking;
    let topSymbols: string[] = [];
    if (rankingSvc !== undefined) {
      const result = await rankingSvc.rank(topN);
      topSymbols = result.scored.map((s) => s.symbol);
    }

    // Include held symbols so we can price exits
    const held = this.deps.repo
      .getPositions(FACTOR_PORTFOLIO_STRATEGY_ID, 'PAPER')
      .filter((p) => p.quantity !== 0)
      .map((p) => p.symbol);

    const symbols = [...new Set([...topSymbols, ...held])];

    // Fetch prices; any failure aborts with 502
    let items: TossPriceItem[];
    try {
      items = await getPrices(symbols);
    } catch {
      return { error: 'price fetch failed', code: 502 };
    }

    // Populate QuoteBook so FactorPortfolioManager.priceOf can find them
    for (const item of items) {
      const last = Number(item.lastPrice);
      if (!Number.isFinite(last) || last <= 0) continue;
      this.deps.book.set({
        symbol: item.symbol,
        currency: 'KRW',
        bid: last,
        ask: last,
        last,
        ts: Date.now(),
      });
    }

    return mgr.rebalance();
  }
```

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | head -40
```

Expected: no errors (or only pre-existing unrelated errors).

- [ ] **Step 5: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/app/TradingSystem.ts && git commit -m "feat(factor): add FACTOR_PORTFOLIO_STRATEGY_ID + rebalanceFactorPortfolio() to TradingSystem"
```

---

### Task 2: Add POST /api/factors/rebalance endpoint to server.ts

**Files:**
- Modify: `src/api/server.ts`

**Interfaces:**
- Consumes: `TradingSystem.rebalanceFactorPortfolio()` from Task 1
- Produces: `POST /api/factors/rebalance` → `RebalancePlan` | `{ error }` with appropriate status code

- [ ] **Step 1: Add the route after the factor ranking route (around line 233 of server.ts)**

Add before `return app;`:

```ts
  // --- factor portfolio rebalance ---
  app.post('/api/factors/rebalance', async (_req, reply) => {
    const result = await system.rebalanceFactorPortfolio();
    if ('error' in result) {
      return reply.code(result.code).send({ error: result.error });
    }
    return result;
  });
```

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/api/server.ts && git commit -m "feat(factor): add POST /api/factors/rebalance endpoint"
```

---

### Task 3: Wire FactorPortfolioManager in index.ts

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes:
  - `FACTOR_PORTFOLIO_STRATEGY_ID` from Task 1
  - `FactorPortfolioManager` (already committed in `src/factor/FactorPortfolioManager.ts`)
  - `orderManager`, `factorRanking`, `book`, `repo`, `haltSwitch`, `registry` (already in scope)
- Produces: `factorPortfolio: FactorPortfolioManager` passed to `TradingSystem`

- [ ] **Step 1: Add imports to index.ts**

After line 32 (`import { FundamentalsService } from './factor/FundamentalsService.js';`), add:

```ts
import { FactorPortfolioManager } from './factor/FactorPortfolioManager.js';
import { FACTOR_PORTFOLIO_STRATEGY_ID } from './app/TradingSystem.js';
import type { Strategy } from './strategy/Strategy.js';
```

Note: `Strategy` may already be imported — check line 20. If it is, skip that import line.

- [ ] **Step 2: Register the factor strategy stub in bootstrap()**

After the `for (const s of strategies)` loop that registers the seeded strategies (around line 116), add:

```ts
  // Reserved stub for the AQR 4-Factor Portfolio (id=1000). Registered in registry only —
  // NOT in StrategyEngine tick loop. Lifecycle managed by rebalanceFactorPortfolio() HTTP trigger.
  const factorStrategy: Strategy = {
    id: FACTOR_PORTFOLIO_STRATEGY_ID,
    symbols: new Set<string>(),
    currency: 'KRW',
    mode: 'PAPER',
    evaluate: () => null,
  };
  registry.register(factorStrategy, 'AQR 4-Factor Portfolio', 'PAPER_TESTING');
```

- [ ] **Step 3: Construct FactorPortfolioManager in bootstrap()**

After the `factorBacktest` construction (around line 199), add:

```ts
  // FactorPortfolioManager: rebalance-driven (HTTP trigger), PAPER only.
  // submitIntent bridges PortfolioOrderIntent → OrderManager.handleIntent.
  const factorPortfolio = new FactorPortfolioManager(
    {
      ranking: factorRanking,
      priceOf: (sym) => book.getQuote(sym)?.last,
      currentQty: (sym) => {
        const pos = repo.getPosition(FACTOR_PORTFOLIO_STRATEGY_ID, sym, 'PAPER');
        return pos?.quantity ?? 0;
      },
      heldSymbols: () =>
        repo.getPositions(FACTOR_PORTFOLIO_STRATEGY_ID, 'PAPER')
          .filter((p) => p.quantity !== 0)
          .map((p) => p.symbol),
      submitIntent: async (pIntent) => {
        const quote = book.getQuote(pIntent.symbol);
        if (quote === undefined) throw new Error(`no quote for ${pIntent.symbol}`);
        await orderManager.handleIntent(
          factorStrategy,
          { side: pIntent.side, quantity: pIntent.quantity, orderType: 'MARKET', reason: pIntent.reason },
          quote,
        );
      },
      isHalted: () => haltSwitch.halted,
    },
    {
      strategyId: FACTOR_PORTFOLIO_STRATEGY_ID,
      topN: 10,
      totalNotional: 10_000_000,
      currency: 'KRW',
      mode: 'PAPER',
    },
  );
```

- [ ] **Step 4: Pass factorPortfolio and getPrices to TradingSystem**

In the `new TradingSystem({...})` call (around line 201), add the two new deps:

```ts
  const system = new TradingSystem({
    repo, book, registry, logger, haltSwitch,
    promotionInputFor: (id) => perf.promotionInput(id, 'PAPER'),
    symbolCatalog,
    getCandles: (s, i) => client.getCandles(s, i),
    deployer,
    factorRanking,
    factorBacktest,
    factorPortfolio,
    getPrices: (s) => client.getPrices(s),
    factorPortfolioTopN: 10,
  });
```

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | head -60
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/index.ts && git commit -m "feat(factor): wire FactorPortfolioManager in index.ts bootstrap"
```

---

### Task 4: Tests in server.test.ts

**Files:**
- Modify: `src/api/server.test.ts`

**Interfaces:**
- Consumes:
  - `POST /api/factors/rebalance` endpoint from Task 2
  - `FactorPortfolioManager` from `src/factor/FactorPortfolioManager.ts`
  - `FACTOR_PORTFOLIO_STRATEGY_ID` from Task 1
  - `harness()` function extended with `factorPortfolio?` param and returns `{ app, logger, haltSwitch, deployer, book, repo }`
- Tests:
  1. 503 when factorPortfolio absent
  2. 409 when halted
  3. RebalancePlan returned with targets/ordersSubmitted/skipped/halted:false
  4. Quotes set in QuoteBook before rebalance (book.getQuote observable in test)
  5. Full existing 309 tests still pass

- [ ] **Step 1: Add imports to server.test.ts**

After the existing imports, add:

```ts
import { FactorPortfolioManager } from '../factor/FactorPortfolioManager.js';
import type { RebalancePlan } from '../factor/FactorPortfolioManager.js';
import type { TossPriceItem } from '../toss/types.js';
import { FACTOR_PORTFOLIO_STRATEGY_ID } from '../app/TradingSystem.js';
```

- [ ] **Step 2: Extend harness() to accept factorPortfolio and return book/repo**

Modify the `harness()` function signature to add:

```ts
  factorPortfolio?: FactorPortfolioManager;
  getPrices?: (symbols: string[]) => Promise<TossPriceItem[]>;
  factorPortfolioTopN?: number;
```

Add these to the `new TradingSystem({...})` call inside harness using conditional spread:

```ts
    ...(opts.factorPortfolio !== undefined ? { factorPortfolio: opts.factorPortfolio } : {}),
    ...(opts.getPrices !== undefined ? { getPrices: opts.getPrices } : {}),
    ...(opts.factorPortfolioTopN !== undefined ? { factorPortfolioTopN: opts.factorPortfolioTopN } : {}),
```

Change the `return` statement in harness from:

```ts
  return { app: buildServer(system, opts.server ?? {}), logger, haltSwitch, deployer };
```

to:

```ts
  return { app: buildServer(system, opts.server ?? {}), logger, haltSwitch, deployer, book, repo };
```

- [ ] **Step 3: Write the failing tests**

Add a new `describe` block at the end of `server.test.ts`. **Key design note:** `TradingSystem.rebalanceFactorPortfolio()` uses `this.deps.factorRanking` to determine which symbols to fetch prices for; if that dep is absent, no prices are fetched, and `priceOf` returns `undefined` for all symbols (targets all skipped). Tests that expect priced targets must pass `factorRanking` (mocked as `unknown as FactorRankingService`) to harness so TradingSystem knows which symbols to price. The `FactorPortfolioManager` gets the same mock ranking object so its internal `rank()` call returns the same symbols. The harness destructures `book`, `haltSwitch` which the inline `FactorPortfolioManager` closures capture — this is valid JS: the closures only read the bindings when called (during `rebalance()`), well after destructuring completes.

```ts
describe('POST /api/factors/rebalance', () => {
  const SYMBOLS = ['005930', '000660'];

  /** Minimal duck-typed ranking usable as both FactorRankingService and FactorPortfolioDeps.ranking. */
  function makeRanking(symbols: string[]) {
    return {
      rank: async (_limit?: number) => ({
        asOf: 0,
        scored: symbols.map((symbol, i) => ({ symbol, rank: i + 1, composite: 1 - i * 0.1, sector: 'KR', factors: {} })),
        universeSize: symbols.length,
        fetched: symbols.length,
        skipped: 0,
      }),
    };
  }

  function makeGetPrices(price: string) {
    return async (syms: string[]): Promise<TossPriceItem[]> =>
      syms.map((symbol) => ({ symbol, lastPrice: price }));
  }

  it('returns 503 when factorPortfolio dep is absent', async () => {
    const { app } = harness();
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/unavailable/i);
  });

  it('returns 409 when TradingSystem halt switch is set', async () => {
    const ranking = makeRanking(SYMBOLS);
    const { app, haltSwitch, book } = harness({
      factorRanking: ranking as unknown as FactorRankingService,
      factorPortfolio: new FactorPortfolioManager(
        {
          ranking,
          priceOf: (sym) => book.getQuote(sym)?.last,
          currentQty: () => 0,
          heldSymbols: () => [],
          submitIntent: async () => {},
          isHalted: () => haltSwitch.halted,
        },
        { strategyId: FACTOR_PORTFOLIO_STRATEGY_ID, topN: 2, totalNotional: 10_000_000, currency: 'KRW', mode: 'PAPER' },
      ),
      getPrices: makeGetPrices('70000'),
      factorPortfolioTopN: 2,
    });
    haltSwitch.trip('test halt');
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/halt/i);
  });

  it('returns RebalancePlan with targets/ordersSubmitted/halted:false', async () => {
    const ranking = makeRanking(SYMBOLS);
    const { app, haltSwitch, book } = harness({
      factorRanking: ranking as unknown as FactorRankingService,
      factorPortfolio: new FactorPortfolioManager(
        {
          ranking,
          priceOf: (sym) => book.getQuote(sym)?.last,
          currentQty: () => 0,
          heldSymbols: () => [],
          submitIntent: async () => {},
          isHalted: () => haltSwitch.halted,
        },
        { strategyId: FACTOR_PORTFOLIO_STRATEGY_ID, topN: 2, totalNotional: 10_000_000, currency: 'KRW', mode: 'PAPER' },
      ),
      getPrices: makeGetPrices('70000'),
      factorPortfolioTopN: 2,
    });
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(200);
    const plan = res.json() as RebalancePlan;
    expect(plan.halted).toBe(false);
    expect(plan.targets).toHaveLength(2);
    expect(plan.targets[0]?.price).toBe(70000);
    expect(plan.targets[0]?.targetQty).toBe(Math.floor(5_000_000 / 70000));
    expect(Array.isArray(plan.ordersSubmitted)).toBe(true);
    expect(Array.isArray(plan.skipped)).toBe(true);
  });

  it('sets quotes in QuoteBook (prices visible in targets) before rebalance', async () => {
    // TradingSystem.rebalanceFactorPortfolio sets quotes in its book dep THEN calls rebalance().
    // FactorPortfolioManager.priceOf reads from that same book (via closure).
    // Evidence: plan.targets have price=75000, meaning quotes were populated before rebalance ran.
    const ranking = makeRanking(SYMBOLS);
    const { app, haltSwitch, book } = harness({
      factorRanking: ranking as unknown as FactorRankingService,
      factorPortfolio: new FactorPortfolioManager(
        {
          ranking,
          priceOf: (sym) => book.getQuote(sym)?.last,
          currentQty: () => 0,
          heldSymbols: () => [],
          submitIntent: async () => {},
          isHalted: () => haltSwitch.halted,
        },
        { strategyId: FACTOR_PORTFOLIO_STRATEGY_ID, topN: 2, totalNotional: 10_000_000, currency: 'KRW', mode: 'PAPER' },
      ),
      getPrices: makeGetPrices('75000'),
      factorPortfolioTopN: 2,
    });
    const res = await app.inject({ method: 'POST', url: '/api/factors/rebalance' });
    expect(res.statusCode).toBe(200);
    const plan = res.json() as RebalancePlan;
    // targets priced at 75000 proves book was populated before rebalance() ran
    expect(plan.targets.length).toBeGreaterThan(0);
    expect(plan.targets[0]?.price).toBe(75000);
    // Confirm via GET /api/market/price/:symbol
    for (const sym of SYMBOLS) {
      const qRes = await app.inject({ method: 'GET', url: `/api/market/price/${sym}` });
      if (qRes.statusCode === 200) {
        expect(qRes.json().last).toBe(75000);
      }
    }
  });
});
```

- [ ] **Step 4: Run tests to verify they fail first**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/api/server.test.ts 2>&1 | tail -30
```

Expected: new tests fail with "503 not 503" or "cannot find module" type errors because Tasks 1-3 haven't been applied yet. (If running after Tasks 1-3, skip this step and go straight to green.)

- [ ] **Step 5: Run full test suite to confirm 309 existing + new tests pass**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run 2>&1 | tail -30
```

Expected: all tests pass. New tests = 4 (503, 409, plan, book-population), total ≥ 313.

- [ ] **Step 6: Run typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | head -40
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/api/server.test.ts && git commit -m "test(factor): add POST /api/factors/rebalance tests (503, 409, plan, book population)"
```

---

### Task 5: Final integration commit + live smoke test

**Files:**
- No new file changes — this task runs the smoke test and verifies positions

- [ ] **Step 1: Run full typecheck + test suite one final time**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck 2>&1 | head -20 && npx vitest run 2>&1 | tail -20
```

Expected: 0 type errors, all tests pass.

- [ ] **Step 2: Start server in background**

```bash
cd /Users/im-yoseb/auto-trading && npx tsx src/index.ts > /tmp/auto-trading-smoke.log 2>&1 &
echo "PID=$!"
sleep 3
```

Wait for server to start. Check log for `API listening on 127.0.0.1:3000`.

- [ ] **Step 3: Check halt status before rebalance**

```bash
curl -s http://127.0.0.1:3000/api/halt
```

Expected: `{"halted":false,"reason":null}`. If halted, run:
```bash
curl -s -X POST http://127.0.0.1:3000/api/resume -H 'content-type:application/json' -d '{}'
```

- [ ] **Step 4: Trigger rebalance (may take up to 4 min for ranking cold-cache)**

```bash
curl -s -X POST http://127.0.0.1:3000/api/factors/rebalance --max-time 240
```

Expected: JSON with `{ asOf, targets, sells, ordersSubmitted, skipped, halted:false }`.

- [ ] **Step 5: Verify positions under strategyId 1000**

```bash
curl -s 'http://127.0.0.1:3000/api/positions?strategyId=1000'
```

Expected: array of positions with `strategyId: 1000`, non-zero quantities for BUY symbols.

- [ ] **Step 6: Kill background server**

```bash
kill $(lsof -ti:3000) 2>/dev/null || true
```

- [ ] **Step 7: Final commit (all pending changes)**

```bash
cd /Users/im-yoseb/auto-trading && git add -p && git commit -m "feat(factor): wire factor-portfolio rebalancer + POST /api/factors/rebalance (paper)"
```

---

### Task 6: Write SDD report

**Files:**
- Create: `/Users/im-yoseb/auto-trading/.superpowers/sdd/factor-portfolio-wire-report.md`

- [ ] **Step 1: Create SDD directory if needed**

```bash
mkdir -p /Users/im-yoseb/auto-trading/.superpowers/sdd
```

- [ ] **Step 2: Write the report**

The report must contain:
1. Status (DONE / PARTIAL with reason)
2. Commit hash (`git log -1 --format='%H %s'`)
3. One-line test summary (`npx vitest run 2>&1 | grep 'Tests'`)
4. Live rebalance plan output (targets / ordersSubmitted / skipped + positions under id 1000)

Template:

```markdown
# Factor Portfolio Wire — Implementation Report

**Status:** DONE

**Commit:** <hash> feat(factor): wire factor-portfolio rebalancer + POST /api/factors/rebalance (paper)

**Tests:** <N> passed, 0 failed (existing 309 + 4 new)

## Live Rebalance Plan

### Response from POST /api/factors/rebalance
```json
<paste full JSON here>
```

### Positions under strategyId=1000 (PAPER)
```json
<paste positions JSON here>
```

## Notes
- factorRanking cold-cache took ~N seconds
- N symbols priced, N orders submitted, N skipped
```

- [ ] **Step 3: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add .superpowers/sdd/factor-portfolio-wire-report.md && git commit -m "docs: add factor-portfolio-wire SDD report"
```
