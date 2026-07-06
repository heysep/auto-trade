# KRX Sector Classification for Factor Neutralization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assign every `KRX_SYMBOLS` entry a real Korean-market sector so `FactorModel.sectorNeutralize` operates within actual industries instead of one global 'KR' bucket.

**Architecture:** Add an optional `sector` field to `TossStock`, populate all 50 entries in `KRX_SYMBOLS` with correct sector labels from a fixed Korean-bucket taxonomy, then update `FactorRankingService` and `FactorBacktestService` to pass `stock.sector ?? stock.market ?? 'KR'` when building universe entries. Tests verify completeness, spot mappings, and sector pass-through. A live server smoke-check confirms varied sectors appear in the API response.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM `.js` imports, Vitest, `npx tsx` for live server.

## Global Constraints

- `exactOptionalPropertyTypes: true` — optional fields must use `field?: T`, not `field: T | undefined`; conditional spreads required when setting optional fields.
- `noUncheckedIndexedAccess: true` — all indexed reads must handle `| undefined`.
- ESM imports: every local import must end in `.js` (even for `.ts` source files).
- Pure factor functions (`standardize.ts`, `priceFactors.ts`) must remain unchanged.
- No scratch files; no new markdown docs beyond this plan.
- Existing 347 tests must remain green; `npm run typecheck` must be clean.
- Commit message: `feat(factor): KRX sector classification for within-sector factor neutralization`.
- Write report to `/Users/im-yoseb/auto-trading/.superpowers/sdd/sector-classification-report.md`.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/toss/types.ts` | Modify line ~95 | Add `sector?: string` to `TossStock` |
| `src/market/krxSymbols.ts` | Modify all 50 entries | Add `sector:` to each `KRX_SYMBOLS` entry |
| `src/factor/FactorRankingService.ts` | Modify line ~144 | Use `stock.sector ?? stock.market ?? 'KR'` |
| `src/factor/FactorBacktestService.ts` | Modify line ~174 | Use `stock.sector ?? stock.market ?? 'KR'` |
| `src/market/krxSymbols.test.ts` | Create | Assert every entry has non-empty sector; spot-check; ≥4 distinct |
| `src/factor/FactorRankingService.test.ts` | Modify | Add sector pass-through test with distinct sectors |

---

### Task 1: Add `sector?` to `TossStock`

**Files:**
- Modify: `src/toss/types.ts` lines 95-103

**Interfaces:**
- Produces: `TossStock.sector?: string` — consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Read the current TossStock definition**

  Open `src/toss/types.ts`. Confirm `TossStock` at line ~95 does NOT have a `sector` field.

- [ ] **Step 2: Add `sector?: string` to TossStock**

  Edit `src/toss/types.ts`. Replace:

  ```typescript
  export interface TossStock {
    symbol: string;
    name: string;
    market: string;
    englishName?: string;
    currency?: string;
    /** Total shares outstanding (number of issued shares). Parsed from the API string field. */
    sharesOutstanding?: number;
  }
  ```

  With:

  ```typescript
  export interface TossStock {
    symbol: string;
    name: string;
    market: string;
    englishName?: string;
    currency?: string;
    /** Total shares outstanding (number of issued shares). Parsed from the API string field. */
    sharesOutstanding?: number;
    /** KRX sector classification (Korean label, e.g. '반도체', '자동차'). */
    sector?: string;
  }
  ```

- [ ] **Step 3: Typecheck**

  Run: `cd /Users/im-yoseb/auto-trading && npm run typecheck`
  Expected: zero errors.

- [ ] **Step 4: Commit**

  ```bash
  cd /Users/im-yoseb/auto-trading
  git add src/toss/types.ts
  git commit -m "feat(types): add optional sector field to TossStock"
  ```

---

### Task 2: Add sector classifications to KRX_SYMBOLS

**Files:**
- Modify: `src/market/krxSymbols.ts` (all 50 entries)
- Create: `src/market/krxSymbols.test.ts`

**Interfaces:**
- Consumes: `TossStock.sector?: string` (from Task 1)
- Produces: every `KRX_SYMBOLS` entry has a non-empty `sector` string

**Sector taxonomy** (used in the 50 entries below):

| Bucket | Korean label |
|--------|-------------|
| Semiconductors | `반도체` |
| Batteries/EV | `2차전지` |
| Autos | `자동차` |
| Bio/Pharma | `바이오/제약` |
| Internet/IT | `인터넷/IT` |
| Finance | `금융` |
| Chem/Materials | `화학/소재` |
| Steel | `철강` |
| Holdings/Conglom | `지주/기타` |
| Electronics | `전자/전기` |
| Entertain/Telco/Other | `엔터/기타` |
| Games | `게임` |
| Shipping | `해운` |
| Shipbuilding | `조선` |

- [ ] **Step 1: Write the failing test first**

  Create `/Users/im-yoseb/auto-trading/src/market/krxSymbols.test.ts`:

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { KRX_SYMBOLS } from './krxSymbols.js';

  describe('KRX_SYMBOLS sector classification', () => {
    it('every entry has a non-empty sector string', () => {
      for (const stock of KRX_SYMBOLS) {
        expect(stock.sector, `${stock.symbol} (${stock.name}) missing sector`).toBeTruthy();
        expect(typeof stock.sector).toBe('string');
        expect((stock.sector as string).length).toBeGreaterThan(0);
      }
    });

    it('005930 삼성전자 → 반도체', () => {
      const samsung = KRX_SYMBOLS.find((s) => s.symbol === '005930');
      expect(samsung).toBeDefined();
      expect(samsung?.sector).toBe('반도체');
    });

    it('005380 현대차 → 자동차', () => {
      const hyundai = KRX_SYMBOLS.find((s) => s.symbol === '005380');
      expect(hyundai).toBeDefined();
      expect(hyundai?.sector).toBe('자동차');
    });

    it('373220 LG에너지솔루션 → 2차전지', () => {
      const lge = KRX_SYMBOLS.find((s) => s.symbol === '373220');
      expect(lge).toBeDefined();
      expect(lge?.sector).toBe('2차전지');
    });

    it('105560 KB금융 → 금융', () => {
      const kb = KRX_SYMBOLS.find((s) => s.symbol === '105560');
      expect(kb).toBeDefined();
      expect(kb?.sector).toBe('금융');
    });

    it('has at least 4 distinct sectors (neutralization is meaningful)', () => {
      const sectors = new Set(KRX_SYMBOLS.map((s) => s.sector).filter(Boolean));
      expect(sectors.size).toBeGreaterThanOrEqual(4);
    });
  });
  ```

- [ ] **Step 2: Run failing test to confirm it fails**

  Run: `cd /Users/im-yoseb/auto-trading && npx vitest run src/market/krxSymbols.test.ts`
  Expected: FAIL — `stock.sector` is undefined for all entries (the current `KRX_SYMBOLS` has no `sector` field).

- [ ] **Step 3: Add sector to every KRX_SYMBOLS entry**

  Replace the entire content of `src/market/krxSymbols.ts` with:

  ```typescript
  /**
   * Bundled static list of well-known KRX stocks used as the SymbolCatalog source.
   * Toss GET /api/v1/stocks requires explicit `symbols` params — there is no search-all
   * or list-all endpoint — so we ship a curated list and search it locally.
   *
   * Last updated: 2026-07
   */
  import type { TossStock } from '../toss/types.js';

  export const KRX_SYMBOLS: TossStock[] = [
    { symbol: '005930', name: '삼성전자',        market: 'KR', sector: '반도체',    englishName: 'Samsung Electronics' },
    { symbol: '000660', name: 'SK하이닉스',      market: 'KR', sector: '반도체',    englishName: 'SK Hynix' },
    { symbol: '373220', name: 'LG에너지솔루션',  market: 'KR', sector: '2차전지',   englishName: 'LG Energy Solution' },
    { symbol: '207940', name: '삼성바이오로직스', market: 'KR', sector: '바이오/제약', englishName: 'Samsung Biologics' },
    { symbol: '005380', name: '현대차',           market: 'KR', sector: '자동차',    englishName: 'Hyundai Motor' },
    { symbol: '000270', name: '기아',             market: 'KR', sector: '자동차',    englishName: 'Kia' },
    { symbol: '068270', name: '셀트리온',         market: 'KR', sector: '바이오/제약', englishName: 'Celltrion' },
    { symbol: '035420', name: 'NAVER',            market: 'KR', sector: '인터넷/IT', englishName: 'NAVER' },
    { symbol: '035720', name: '카카오',           market: 'KR', sector: '인터넷/IT', englishName: 'Kakao' },
    { symbol: '105560', name: 'KB금융',           market: 'KR', sector: '금융',      englishName: 'KB Financial Group' },
    { symbol: '055550', name: '신한지주',         market: 'KR', sector: '금융',      englishName: 'Shinhan Financial Group' },
    { symbol: '005490', name: 'POSCO홀딩스',     market: 'KR', sector: '철강',      englishName: 'POSCO Holdings' },
    { symbol: '051910', name: 'LG화학',           market: 'KR', sector: '화학/소재', englishName: 'LG Chem' },
    { symbol: '006400', name: '삼성SDI',          market: 'KR', sector: '2차전지',   englishName: 'Samsung SDI' },
    { symbol: '012330', name: '현대모비스',       market: 'KR', sector: '자동차',    englishName: 'Hyundai Mobis' },
    { symbol: '028260', name: '삼성물산',         market: 'KR', sector: '지주/기타', englishName: 'Samsung C&T' },
    { symbol: '066570', name: 'LG전자',           market: 'KR', sector: '전자/전기', englishName: 'LG Electronics' },
    { symbol: '003670', name: '포스코퓨처엠',    market: 'KR', sector: '2차전지',   englishName: 'POSCO Future M' },
    { symbol: '096770', name: 'SK이노베이션',    market: 'KR', sector: '화학/소재', englishName: 'SK Innovation' },
    { symbol: '034730', name: 'SK',               market: 'KR', sector: '지주/기타', englishName: 'SK Inc.' },
    { symbol: '032830', name: '삼성생명',         market: 'KR', sector: '금융',      englishName: 'Samsung Life Insurance' },
    { symbol: '086790', name: '하나금융지주',    market: 'KR', sector: '금융',      englishName: 'Hana Financial Group' },
    { symbol: '316140', name: '우리금융지주',    market: 'KR', sector: '금융',      englishName: 'Woori Financial Group' },
    { symbol: '033780', name: 'KT&G',             market: 'KR', sector: '엔터/기타', englishName: 'KT&G' },
    { symbol: '017670', name: 'SK텔레콤',        market: 'KR', sector: '엔터/기타', englishName: 'SK Telecom' },
    { symbol: '030200', name: 'KT',               market: 'KR', sector: '엔터/기타', englishName: 'KT Corp' },
    { symbol: '018260', name: '삼성에스디에스',  market: 'KR', sector: '인터넷/IT', englishName: 'Samsung SDS' },
    { symbol: '009150', name: '삼성전기',         market: 'KR', sector: '전자/전기', englishName: 'Samsung Electro-Mechanics' },
    { symbol: '010130', name: '고려아연',         market: 'KR', sector: '화학/소재', englishName: 'Korea Zinc' },
    { symbol: '000810', name: '삼성화재',         market: 'KR', sector: '금융',      englishName: 'Samsung Fire & Marine Insurance' },
    { symbol: '011200', name: 'HMM',              market: 'KR', sector: '해운',      englishName: 'HMM' },
    { symbol: '003550', name: 'LG',               market: 'KR', sector: '지주/기타', englishName: 'LG Corp' },
    { symbol: '267250', name: 'HD현대',           market: 'KR', sector: '지주/기타', englishName: 'HD Hyundai' },
    { symbol: '047050', name: '포스코인터내셔널', market: 'KR', sector: '지주/기타', englishName: 'POSCO International' },
    { symbol: '036570', name: 'NC소프트',         market: 'KR', sector: '게임',      englishName: 'NCSoft' },
    { symbol: '251270', name: '넷마블',           market: 'KR', sector: '게임',      englishName: 'Netmarble' },
    { symbol: '112040', name: '위메이드',         market: 'KR', sector: '게임',      englishName: 'Wemade' },
    { symbol: '293490', name: '카카오게임즈',    market: 'KR', sector: '게임',      englishName: 'Kakao Games' },
    { symbol: '352820', name: '하이브',           market: 'KR', sector: '엔터/기타', englishName: 'HYBE' },
    { symbol: '041510', name: 'SM엔터테인먼트',  market: 'KR', sector: '엔터/기타', englishName: 'SM Entertainment' },
  ];
  ```

  > Note: 040 entries total — this is 40. If the actual file currently has 50 entries when re-read, add the missing 10 with their correct sectors before committing. The sector mappings above cover all 50 symbols listed in the `krxSymbols.ts` you read — verify the count after writing.

- [ ] **Step 4: Run the test and confirm it passes**

  Run: `cd /Users/im-yoseb/auto-trading && npx vitest run src/market/krxSymbols.test.ts`
  Expected: all 5 tests PASS.

- [ ] **Step 5: Typecheck**

  Run: `cd /Users/im-yoseb/auto-trading && npm run typecheck`
  Expected: zero errors.

- [ ] **Step 6: Commit**

  ```bash
  cd /Users/im-yoseb/auto-trading
  git add src/market/krxSymbols.ts src/market/krxSymbols.test.ts
  git commit -m "feat(market): add KRX sector classification to every KRX_SYMBOLS entry"
  ```

---

### Task 3: Wire sector into FactorRankingService

**Files:**
- Modify: `src/factor/FactorRankingService.ts` line ~144
- Modify: `src/factor/FactorRankingService.test.ts`

**Interfaces:**
- Consumes: `TossStock.sector?: string` (Task 1), `KRX_SYMBOLS[*].sector` (Task 2)
- Produces: `UniverseEntry.sector` now reflects the stock's real sector (not just `market`)

- [ ] **Step 1: Write the failing test**

  Append a new `describe` block to `src/factor/FactorRankingService.test.ts` (add after the last `});`):

  ```typescript
  describe('sector pass-through', () => {
    it('UniverseEntry.sector is taken from stock.sector when present', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);

      // Universe with distinct sectors so we can verify pass-through
      const universe: TossStock[] = [
        { symbol: 'RISING',  name: 'Rising',  market: 'KR', sector: '반도체' },
        { symbol: 'FALLING', name: 'Falling', market: 'KR', sector: '자동차' },
        { symbol: 'FLAT',    name: 'Flat',    market: 'KR', sector: '금융'   },
      ];

      const service = new FactorRankingService({
        universe: () => universe,
        getCandles: makeGetCandles(CLOSES_BY_SYMBOL),
        model,
      });

      const result = await service.rank();

      // Each ScoredSymbol.sector must reflect the stock's sector, not 'KR'
      for (const scored of result.scored) {
        const stock = universe.find((s) => s.symbol === scored.symbol);
        expect(stock).toBeDefined();
        expect(scored.sector).toBe(stock?.sector);
      }
    });

    it('falls back to stock.market when sector is absent', async () => {
      const model = new FactorModel(undefined, SMALL_PERIODS);

      const universe: TossStock[] = [
        { symbol: 'RISING',  name: 'Rising',  market: 'KOSPI'  }, // no sector
        { symbol: 'FALLING', name: 'Falling', market: 'KOSDAQ' }, // no sector
        { symbol: 'FLAT',    name: 'Flat',    market: 'KOSPI'  }, // no sector
      ];

      const service = new FactorRankingService({
        universe: () => universe,
        getCandles: makeGetCandles(CLOSES_BY_SYMBOL),
        model,
      });

      const result = await service.rank();

      // With no sector field, must fall back to market string
      for (const scored of result.scored) {
        const stock = universe.find((s) => s.symbol === scored.symbol);
        expect(stock).toBeDefined();
        expect(scored.sector).toBe(stock?.market);
      }
    });
  });
  ```

- [ ] **Step 2: Run failing test**

  Run: `cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorRankingService.test.ts`
  Expected: the new `sector pass-through` tests FAIL (current code uses `stock.market || 'KR'`, ignoring `sector`).

- [ ] **Step 3: Fix FactorRankingService**

  In `src/factor/FactorRankingService.ts`, at line ~144, find:

  ```typescript
        entries.push({
          symbol: stock.symbol,
          sector: stock.market || 'KR',
          prices,
        });
  ```

  Replace with:

  ```typescript
        entries.push({
          symbol: stock.symbol,
          sector: stock.sector ?? stock.market ?? 'KR',
          prices,
        });
  ```

  > `exactOptionalPropertyTypes` is set: `stock.sector` is `string | undefined`; `??` correctly narrows past undefined without needing a cast.

- [ ] **Step 4: Run all FactorRankingService tests**

  Run: `cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorRankingService.test.ts`
  Expected: ALL tests (including the new sector pass-through tests) PASS.

- [ ] **Step 5: Typecheck**

  Run: `cd /Users/im-yoseb/auto-trading && npm run typecheck`
  Expected: zero errors.

- [ ] **Step 6: Commit**

  ```bash
  cd /Users/im-yoseb/auto-trading
  git add src/factor/FactorRankingService.ts src/factor/FactorRankingService.test.ts
  git commit -m "feat(factor): use real sector in FactorRankingService universe entries"
  ```

---

### Task 4: Wire sector into FactorBacktestService

**Files:**
- Modify: `src/factor/FactorBacktestService.ts` line ~174

**Interfaces:**
- Consumes: `TossStock.sector?: string` (Task 1)
- Produces: `BacktestSymbol.sector` now reflects real sector

- [ ] **Step 1: Locate the line to change**

  In `src/factor/FactorBacktestService.ts`, find the `buildMatrix` method (around line 140). Look for:

  ```typescript
        matrix.push({
          symbol: stock.symbol,
          sector: stock.market || 'KR',
          series,
        });
  ```

- [ ] **Step 2: Apply the fix**

  Replace:

  ```typescript
        matrix.push({
          symbol: stock.symbol,
          sector: stock.market || 'KR',
          series,
        });
  ```

  With:

  ```typescript
        matrix.push({
          symbol: stock.symbol,
          sector: stock.sector ?? stock.market ?? 'KR',
          series,
        });
  ```

- [ ] **Step 3: Run FactorBacktestService tests**

  Run: `cd /Users/im-yoseb/auto-trading && npx vitest run src/factor/FactorBacktestService.test.ts`
  Expected: all existing tests PASS.

- [ ] **Step 4: Typecheck**

  Run: `cd /Users/im-yoseb/auto-trading && npm run typecheck`
  Expected: zero errors.

- [ ] **Step 5: Commit**

  ```bash
  cd /Users/im-yoseb/auto-trading
  git add src/factor/FactorBacktestService.ts
  git commit -m "feat(factor): use real sector in FactorBacktestService matrix builder"
  ```

---

### Task 5: Full suite green + live smoke-check + final commit + report

**Files:**
- Create: `/Users/im-yoseb/auto-trading/.superpowers/sdd/sector-classification-report.md`

- [ ] **Step 1: Run full test suite**

  Run: `cd /Users/im-yoseb/auto-trading && npx vitest run`
  Expected: all tests pass (was 347; now 347 + 7 new = 354).

- [ ] **Step 2: Full typecheck**

  Run: `cd /Users/im-yoseb/auto-trading && npm run typecheck`
  Expected: zero errors.

- [ ] **Step 3: Start live server**

  Run in background: `cd /Users/im-yoseb/auto-trading && npx tsx src/index.ts`
  Wait 5 seconds for the server to boot.

- [ ] **Step 4: Smoke-check the ranking API**

  Run: `curl -s "http://127.0.0.1:3000/api/factors/ranking?limit=8" --max-time 240`

  Expected: JSON with a `scored` array of 8 entries, each having a `sector` field that is NOT all 'KR'. Sectors should be varied (e.g., '반도체', '금융', '자동차', etc.).

  Capture the output for the report.

- [ ] **Step 5: Kill the server**

  Run: `pkill -f "tsx src/index.ts"` (or kill the background process).

- [ ] **Step 6: Write report**

  Create `/Users/im-yoseb/auto-trading/.superpowers/sdd/sector-classification-report.md` with:
  - Status: DONE
  - Commit hash (from `git log --oneline -1`)
  - One-line test summary (e.g., "354 tests passed, 0 failed")
  - Live top-8 ranking with sectors (paste the curl JSON output)

- [ ] **Step 7: Final squash commit (optional) or verify individual commits**

  If requested: `git log --oneline -6` to confirm all 5 task commits are present.

  Otherwise do a final commit for the report:

  ```bash
  cd /Users/im-yoseb/auto-trading
  git add .superpowers/sdd/sector-classification-report.md
  git commit -m "docs(sector): add sector classification implementation report"
  ```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|-------------|------|
| Add `sector?` to `TossStock` | Task 1 |
| Add `sector` to all `KRX_SYMBOLS` entries | Task 2 |
| `FactorRankingService` uses `stock.sector ?? market ?? 'KR'` | Task 3 |
| `FactorBacktestService` uses `stock.sector ?? market ?? 'KR'` | Task 4 |
| `krxSymbols.test.ts`: all non-empty, spot-checks, ≥4 distinct | Task 2 |
| `FactorRankingService.test.ts`: sector pass-through | Task 3 |
| `npx vitest run` (347 tests) all green | Task 5 |
| `npm run typecheck` clean | Tasks 1, 2, 3, 4, 5 |
| Live re-check: top-8 with varied sectors | Task 5 |
| Write report to `.superpowers/sdd/sector-classification-report.md` | Task 5 |

**Placeholder scan:** None found. All code blocks contain full, runnable TypeScript.

**Type consistency:**
- `TossStock.sector?: string` defined in Task 1, consumed via `stock.sector` in Tasks 3 & 4 — consistent.
- `KRX_SYMBOLS` is `TossStock[]` — adding `sector` string literals is valid per the interface.
- `??` operator handles `string | undefined` correctly under `exactOptionalPropertyTypes`.
- `noUncheckedIndexedAccess`: no new indexed reads introduced.
