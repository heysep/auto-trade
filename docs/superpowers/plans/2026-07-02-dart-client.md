# OpenDART API Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenDART (금감원 전자공시) API client that fetches KR company corp-code maps and financial statements, enabling AQR Value/Quality factors.

**Architecture:** A `DartApiClient` class with injectable `fetchImpl` and `now()` follows the same patterns as `TossApiClient`. Pure parser functions (`parseCorpCodeXml`, `parseFinancialAccounts`) are exported separately for unit testing. The `config.dart` section is optional (no `required()`) so the app boots without a DART key.

**Tech Stack:** TypeScript (strict, ESM), `fflate` (pure-JS zip), Vitest, `npx tsx` for live verification.

## Global Constraints

- TypeScript strict: `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true` — use conditional-spread (`...(val !== undefined ? { field: val } : {})`), not `field: val | undefined`
- ESM `.js` import extensions everywhere (e.g. `import … from './types.js'`)
- NEVER log the API key — masking is not enough, just don't log it
- No scratch/debug files committed
- `npm run typecheck` must stay clean after each task
- `npx vitest run` must stay green (269 → 269+N tests)
- Branch: `feat/trading-ui`

---

### Task 1: Install fflate and add dart config

**Files:**
- Modify: `package.json` (via `npm i fflate`)
- Modify: `src/config/env.ts`

**Interfaces:**
- Produces: `config.dart.apiKey: string`, `config.dart.baseUrl: string`

- [ ] **Step 1: Install fflate**

```bash
cd /Users/im-yoseb/auto-trading && npm i fflate
```

Expected: package.json `dependencies` gains `"fflate": "^0.8.x"`, `node_modules/fflate` appears.

- [ ] **Step 2: Verify fflate has types**

```bash
ls /Users/im-yoseb/auto-trading/node_modules/fflate/lib/index.d.ts
```

Expected: file exists (fflate ships its own types).

- [ ] **Step 3: Add dart section to config**

Edit `/Users/im-yoseb/auto-trading/src/config/env.ts`. Change:

```typescript
export const config = {
  toss: {
    baseUrl: (process.env.TOSS_BASE_URL ?? 'https://openapi.tossinvest.com').replace(/\/$/, ''),
    clientId: required('TOSS_CLIENT_ID'),
    clientSecret: required('TOSS_CLIENT_SECRET'),
    tokenRefreshMarginSec: 60,
  },
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/auto_trading',
} as const;
```

To:

```typescript
export const config = {
  toss: {
    baseUrl: (process.env.TOSS_BASE_URL ?? 'https://openapi.tossinvest.com').replace(/\/$/, ''),
    clientId: required('TOSS_CLIENT_ID'),
    clientSecret: required('TOSS_CLIENT_SECRET'),
    tokenRefreshMarginSec: 60,
  },
  dart: {
    apiKey: process.env.DART_API_KEY ?? '',
    baseUrl: 'https://opendart.fss.or.kr',
  },
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/auto_trading',
} as const;
```

- [ ] **Step 4: Typecheck passes**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add package.json package-lock.json src/config/env.ts && git commit -m "chore(dart): install fflate; add config.dart section (key optional)"
```

---

### Task 2: Create types.ts

**Files:**
- Create: `src/dart/types.ts`

**Interfaces:**
- Produces: `DartFinancials`, `DartAccountRow` (used by parser and client)

- [ ] **Step 1: Write types.ts**

Create `/Users/im-yoseb/auto-trading/src/dart/types.ts`:

```typescript
export interface DartFinancials {
  corpCode: string;
  year: number;
  revenue?: number;
  grossProfit?: number;
  netIncome?: number;
  totalEquity?: number;
  totalLiabilities?: number;
  totalAssets?: number;
}

export interface DartAccountRow {
  account_id?: string;
  account_nm?: string;
  thstrm_amount?: string;
  sj_div?: string;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/dart/types.ts && git commit -m "feat(dart): add DartFinancials and DartAccountRow types"
```

---

### Task 3: Write failing tests (TDD — RED phase)

**Files:**
- Create: `src/dart/DartApiClient.test.ts`

**Interfaces:**
- Consumes: `DartFinancials`, `DartAccountRow` from `./types.js`
- Consumes: `parseCorpCodeXml`, `parseFinancialAccounts`, `DartApiClient` from `./DartApiClient.js`

- [ ] **Step 1: Write the test file**

Create `/Users/im-yoseb/auto-trading/src/dart/DartApiClient.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseCorpCodeXml, parseFinancialAccounts, DartApiClient } from './DartApiClient.js';
import type { DartAccountRow } from './types.js';

// ---------------------------------------------------------------------------
// parseCorpCodeXml
// ---------------------------------------------------------------------------

const CORP_CODE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
<list>
<corp_code>00126380</corp_code>
<corp_name>삼성전자</corp_name>
<stock_code>005930</stock_code>
<modify_date>20240101</modify_date>
</list>
<list>
<corp_code>00164779</corp_code>
<corp_name>SK하이닉스</corp_name>
<stock_code>000660</stock_code>
<modify_date>20240101</modify_date>
</list>
<list>
<corp_code>00999999</corp_code>
<corp_name>비상장기업</corp_name>
<stock_code> </stock_code>
<modify_date>20240101</modify_date>
</list>
</result>`;

describe('parseCorpCodeXml', () => {
  it('returns a map with 2 listed entries (excludes whitespace-only stock_code)', () => {
    const map = parseCorpCodeXml(CORP_CODE_XML);
    expect(map.size).toBe(2);
    expect(map.get('005930')).toBe('00126380');
    expect(map.get('000660')).toBe('00164779');
    expect(map.has('999999')).toBe(false);
  });

  it('does not include entries with empty stock_code', () => {
    const xml = `<result><list><corp_code>00111111</corp_code><corp_name>Test</corp_name><stock_code></stock_code><modify_date>20240101</modify_date></list></result>`;
    const map = parseCorpCodeXml(xml);
    expect(map.size).toBe(0);
  });

  it('handles 6-char stock codes correctly', () => {
    const map = parseCorpCodeXml(CORP_CODE_XML);
    // All keys must be exactly 6 chars
    for (const key of map.keys()) {
      expect(key).toHaveLength(6);
    }
  });
});

// ---------------------------------------------------------------------------
// parseFinancialAccounts
// ---------------------------------------------------------------------------

const ACCOUNT_LIST: DartAccountRow[] = [
  { account_id: 'ifrs-full_Revenue',      account_nm: '매출액',    thstrm_amount: '302,231,360',  sj_div: 'IS' },
  { account_id: 'ifrs-full_GrossProfit',  account_nm: '매출총이익', thstrm_amount: '100,543,000',  sj_div: 'IS' },
  { account_id: 'ifrs-full_ProfitLoss',   account_nm: '당기순이익', thstrm_amount: '(15,234,000)', sj_div: 'IS' },
  { account_id: 'ifrs-full_Equity',       account_nm: '자본총계',   thstrm_amount: '230,000,000',  sj_div: 'BS' },
  { account_id: 'ifrs-full_Liabilities',  account_nm: '부채총계',   thstrm_amount: '90,000,000',   sj_div: 'BS' },
  { account_id: 'ifrs-full_Assets',       account_nm: '자산총계',   thstrm_amount: '320,000,000',  sj_div: 'BS' },
];

describe('parseFinancialAccounts', () => {
  it('parses all 6 accounts including parentheses-negative', () => {
    const result = parseFinancialAccounts(ACCOUNT_LIST, '00126380', 2024);
    expect(result.corpCode).toBe('00126380');
    expect(result.year).toBe(2024);
    expect(result.revenue).toBe(302_231_360);
    expect(result.grossProfit).toBe(100_543_000);
    expect(result.netIncome).toBe(-15_234_000);
    expect(result.totalEquity).toBe(230_000_000);
    expect(result.totalLiabilities).toBe(90_000_000);
    expect(result.totalAssets).toBe(320_000_000);
  });

  it('omits fields not found in the list (exactOptionalPropertyTypes safe)', () => {
    const partial: DartAccountRow[] = [
      { account_id: 'ifrs-full_Revenue', account_nm: '매출액', thstrm_amount: '1,000', sj_div: 'IS' },
    ];
    const result = parseFinancialAccounts(partial, '00126380', 2024);
    expect(result.revenue).toBe(1000);
    expect('grossProfit' in result).toBe(false);
    expect('netIncome' in result).toBe(false);
    expect('totalEquity' in result).toBe(false);
  });

  it('falls back to account_nm when account_id is absent', () => {
    const rows: DartAccountRow[] = [
      { account_nm: '자산총계', thstrm_amount: '500,000', sj_div: 'BS' },
    ];
    const result = parseFinancialAccounts(rows, '00126380', 2024);
    expect(result.totalAssets).toBe(500_000);
  });

  it('falls back to Korean name 수익(매출액) for revenue', () => {
    const rows: DartAccountRow[] = [
      { account_nm: '수익(매출액)', thstrm_amount: '200,000', sj_div: 'IS' },
    ];
    const result = parseFinancialAccounts(rows, '00126380', 2024);
    expect(result.revenue).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// DartApiClient.financials (injected fetchImpl)
// ---------------------------------------------------------------------------

function makeJsonFetch(body: unknown): typeof fetch {
  return async (_input, _init) => {
    const text = JSON.stringify(body);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => text,
      json: async () => body,
    } as unknown as Response;
  };
}

describe('DartApiClient.financials', () => {
  it('returns null when status is 013 (no data)', async () => {
    const client = new DartApiClient({
      apiKey: 'test-key',
      fetchImpl: makeJsonFetch({ status: '013', message: '조회된 데이타가 없습니다.' }),
    });
    const result = await client.financials('00126380', 2024);
    expect(result).toBeNull();
  });

  it('returns parsed DartFinancials on status 000 with valid list', async () => {
    const responseBody = {
      status: '000',
      message: 'OK',
      list: [
        { account_id: 'ifrs-full_Revenue', account_nm: '매출액', thstrm_amount: '302,231,360', sj_div: 'IS' },
        { account_id: 'ifrs-full_Assets',  account_nm: '자산총계', thstrm_amount: '455,905,208', sj_div: 'BS' },
        { account_id: 'ifrs-full_Equity',  account_nm: '자본총계', thstrm_amount: '230,126,050', sj_div: 'BS' },
        { account_id: 'ifrs-full_ProfitLoss', account_nm: '당기순이익', thstrm_amount: '15,234,000', sj_div: 'IS' },
      ],
    };
    const client = new DartApiClient({
      apiKey: 'test-key',
      fetchImpl: makeJsonFetch(responseBody),
    });
    const result = await client.financials('00126380', 2024);
    expect(result).not.toBeNull();
    expect(result?.revenue).toBe(302_231_360);
    expect(result?.totalAssets).toBe(455_905_208);
    expect(result?.totalEquity).toBe(230_126_050);
    expect(result?.netIncome).toBe(15_234_000);
  });

  it('retries with OFS when CFS returns empty list, returns OFS data', async () => {
    const cfsResponse = { status: '000', message: 'OK', list: [] };
    const ofsResponse = {
      status: '000',
      message: 'OK',
      list: [
        { account_id: 'ifrs-full_Assets', account_nm: '자산총계', thstrm_amount: '100,000', sj_div: 'BS' },
      ],
    };

    let callCount = 0;
    const fetchImpl: typeof fetch = async (input, _init) => {
      callCount++;
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.includes('fs_div=CFS') ? cfsResponse : ofsResponse;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as unknown as Response;
    };

    const client = new DartApiClient({ apiKey: 'test-key', fetchImpl });
    const result = await client.financials('00126380', 2024);
    expect(callCount).toBe(2);
    expect(result?.totalAssets).toBe(100_000);
  });

  it('throws on non-000 non-013 status', async () => {
    const client = new DartApiClient({
      apiKey: 'test-key',
      fetchImpl: makeJsonFetch({ status: '800', message: 'System error' }),
    });
    await expect(client.financials('00126380', 2024)).rejects.toThrow('System error');
  });

  it('throws if apiKey is empty', async () => {
    const client = new DartApiClient({ apiKey: '' });
    await expect(client.financials('00126380', 2024)).rejects.toThrow('DART_API_KEY not configured');
  });
});

describe('DartApiClient.corpCodeMap', () => {
  it('throws if apiKey is empty', async () => {
    const client = new DartApiClient({ apiKey: '' });
    await expect(client.corpCodeMap()).rejects.toThrow('DART_API_KEY not configured');
  });
});
```

- [ ] **Step 2: Run tests — expect failures (RED)**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/dart/DartApiClient.test.ts 2>&1 | tail -20
```

Expected: fails with "Cannot find module './DartApiClient.js'".

- [ ] **Step 3: Commit failing tests**

```bash
cd /Users/im-yoseb/auto-trading && git add src/dart/DartApiClient.test.ts && git commit -m "test(dart): add failing tests for parseCorpCodeXml, parseFinancialAccounts, DartApiClient"
```

---

### Task 4: Implement DartApiClient (GREEN phase)

**Files:**
- Create: `src/dart/DartApiClient.ts`

**Interfaces:**
- Consumes: `DartFinancials`, `DartAccountRow` from `./types.js`
- Consumes: `config` from `../config/env.js`
- Consumes: `fflate` for `unzipSync`
- Produces: `parseCorpCodeXml(xml: string): Map<string,string>`
- Produces: `parseFinancialAccounts(list: DartAccountRow[], corpCode: string, year: number): DartFinancials`
- Produces: `class DartApiClient` with `corpCodeMap(): Promise<Map<string,string>>` and `financials(corpCode: string, year: number, reprtCode?: string): Promise<DartFinancials | null>`

- [ ] **Step 1: Write DartApiClient.ts**

Create `/Users/im-yoseb/auto-trading/src/dart/DartApiClient.ts`:

```typescript
// OpenDART (금감원 전자공시) API client.
// Fetches corp-code maps and financial statements for KR Value/Quality factors.
// NEVER log the API key.

import { unzipSync } from 'fflate';
import type { DartFinancials, DartAccountRow } from './types.js';

// ---------------------------------------------------------------------------
// Pure parsers — unit-tested independently of network
// ---------------------------------------------------------------------------

/**
 * Parse CORPCODE.xml → Map<stockCode(6-char), corpCode>.
 * Skips entries whose <stock_code> is empty or whitespace-only.
 */
export function parseCorpCodeXml(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match each <list>…</list> block (CORPCODE.xml uses <list> not <item>)
  const blockRe = /<list>([\s\S]*?)<\/list>/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(xml)) !== null) {
    const inner = block[1] ?? '';
    const corpCode = (/<corp_code>(.*?)<\/corp_code>/.exec(inner)?.[1] ?? '').trim();
    const stockCode = (/<stock_code>(.*?)<\/stock_code>/.exec(inner)?.[1] ?? '').trim();
    if (stockCode.length === 6 && corpCode.length > 0) {
      map.set(stockCode, corpCode);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Amount parser: "302,231,360" → 302231360; "(15,234,000)" → -15234000
// ---------------------------------------------------------------------------

function parseAmount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const s = raw.trim();
  const negative = s.startsWith('(') && s.endsWith(')');
  const digits = s.replace(/[(),]/g, '').replace(/,/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

// IFRS account_id → field name mapping
const ID_MAP: ReadonlyArray<[string, keyof Omit<DartFinancials, 'corpCode' | 'year'>]> = [
  ['ifrs-full_Revenue',     'revenue'],
  ['ifrs-full_GrossProfit', 'grossProfit'],
  ['ifrs-full_ProfitLoss',  'netIncome'],
  ['ifrs-full_Equity',      'totalEquity'],
  ['ifrs-full_Liabilities', 'totalLiabilities'],
  ['ifrs-full_Assets',      'totalAssets'],
];

// Korean account_nm fallback → field name mapping
const NM_MAP: ReadonlyArray<[string, keyof Omit<DartFinancials, 'corpCode' | 'year'>]> = [
  ['매출액',       'revenue'],
  ['수익(매출액)', 'revenue'],
  ['매출총이익',   'grossProfit'],
  ['당기순이익',   'netIncome'],
  ['자본총계',     'totalEquity'],
  ['부채총계',     'totalLiabilities'],
  ['자산총계',     'totalAssets'],
];

/**
 * Map a list of DartAccountRow entries to DartFinancials.
 * Prefers matching by account_id (IFRS id), falls back to account_nm.
 * Omits fields not found (conditional-spread, compatible with exactOptionalPropertyTypes).
 */
export function parseFinancialAccounts(
  list: DartAccountRow[],
  corpCode: string,
  year: number,
): DartFinancials {
  type FieldKey = keyof Omit<DartFinancials, 'corpCode' | 'year'>;
  const resolved = new Map<FieldKey, number>();

  for (const row of list) {
    const id = row.account_id?.trim() ?? '';
    const nm = row.account_nm?.trim() ?? '';
    const amount = parseAmount(row.thstrm_amount);
    if (amount === undefined) continue;

    // Try account_id first
    let matched = false;
    for (const [key, field] of ID_MAP) {
      if (id === key && !resolved.has(field)) {
        resolved.set(field, amount);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Fall back to account_nm
    for (const [key, field] of NM_MAP) {
      if (nm === key && !resolved.has(field)) {
        resolved.set(field, amount);
        break;
      }
    }
  }

  return {
    corpCode,
    year,
    ...(resolved.has('revenue')          ? { revenue:          resolved.get('revenue')!          } : {}),
    ...(resolved.has('grossProfit')      ? { grossProfit:      resolved.get('grossProfit')!      } : {}),
    ...(resolved.has('netIncome')        ? { netIncome:        resolved.get('netIncome')!        } : {}),
    ...(resolved.has('totalEquity')      ? { totalEquity:      resolved.get('totalEquity')!      } : {}),
    ...(resolved.has('totalLiabilities') ? { totalLiabilities: resolved.get('totalLiabilities')! } : {}),
    ...(resolved.has('totalAssets')      ? { totalAssets:      resolved.get('totalAssets')!      } : {}),
  };
}

// ---------------------------------------------------------------------------
// DartApiClient
// ---------------------------------------------------------------------------

const CORP_CODE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface DartApiResponse {
  status: string;
  message?: string;
  list?: DartAccountRow[];
}

export class DartApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  // corp-code map cache
  private cachedCorpMap: Map<string, string> | undefined;
  private cacheExpiresAt = 0;

  constructor(opts: {
    apiKey: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? 'https://opendart.fss.or.kr';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Fetch and cache the corp-code map (stockCode → corpCode).
   * OpenDART returns a ZIP containing CORPCODE.xml.
   * Cache TTL: 24 hours.
   */
  async corpCodeMap(): Promise<Map<string, string>> {
    if (!this.apiKey) throw new Error('DART_API_KEY not configured');

    const nowMs = this.now();
    if (this.cachedCorpMap !== undefined && nowMs < this.cacheExpiresAt) {
      return this.cachedCorpMap;
    }

    const url = `${this.baseUrl}/api/corpCode.xml?crtfc_key=${this.apiKey}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`DART corpCode.xml -> HTTP ${res.status}`);

    const buf = await res.arrayBuffer();
    const zipEntries = unzipSync(new Uint8Array(buf));

    // Find the CORPCODE.xml entry (case-insensitive)
    let xmlEntry: Uint8Array | undefined;
    for (const [name, data] of Object.entries(zipEntries)) {
      if (name.toLowerCase().includes('corpcode') && name.toLowerCase().endsWith('.xml')) {
        xmlEntry = data;
        break;
      }
    }
    if (xmlEntry === undefined) throw new Error('DART ZIP did not contain CORPCODE.xml');

    const xml = new TextDecoder('utf-8').decode(xmlEntry);
    const map = parseCorpCodeXml(xml);

    this.cachedCorpMap = map;
    this.cacheExpiresAt = nowMs + CORP_CODE_TTL_MS;
    return map;
  }

  /**
   * Fetch annual financial statements for a corp.
   * reprtCode: '11011' = annual (사업보고서), '11012' = Q3, '11013' = Q1, '11014' = Q2.
   * Tries CFS (연결) first; retries with OFS (별도) if CFS list is empty.
   * Returns null when DART status is '013' (no data).
   */
  async financials(
    corpCode: string,
    year: number,
    reprtCode = '11011',
  ): Promise<DartFinancials | null> {
    if (!this.apiKey) throw new Error('DART_API_KEY not configured');

    const fetchOnce = async (fsDiv: 'CFS' | 'OFS'): Promise<DartApiResponse> => {
      const url =
        `${this.baseUrl}/api/fnlttSinglAcntAll.json` +
        `?crtfc_key=${this.apiKey}` +
        `&corp_code=${encodeURIComponent(corpCode)}` +
        `&bsns_year=${year}` +
        `&reprt_code=${reprtCode}` +
        `&fs_div=${fsDiv}`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`DART fnlttSinglAcntAll -> HTTP ${res.status}`);
      return (await res.json()) as DartApiResponse;
    };

    // Try CFS first
    const cfs = await fetchOnce('CFS');
    if (cfs.status === '013') return null;
    if (cfs.status !== '000') {
      throw new Error(`DART API error: ${cfs.message ?? cfs.status}`);
    }

    // CFS ok but empty list → retry with OFS
    const list = cfs.list ?? [];
    if (list.length === 0) {
      const ofs = await fetchOnce('OFS');
      if (ofs.status === '013') return null;
      if (ofs.status !== '000') {
        throw new Error(`DART API error (OFS): ${ofs.message ?? ofs.status}`);
      }
      return parseFinancialAccounts(ofs.list ?? [], corpCode, year);
    }

    return parseFinancialAccounts(list, corpCode, year);
  }
}
```

- [ ] **Step 2: Run tests — expect GREEN**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run src/dart/DartApiClient.test.ts 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 3: Run full suite — still 269+N green**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run 2>&1 | tail -10
```

Expected: all test files pass, test count ≥ 280.

- [ ] **Step 4: Typecheck clean**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/dart/DartApiClient.ts && git commit -m "feat(dart): implement DartApiClient with corpCodeMap, financials, and pure parsers"
```

---

### Task 5: Live verify with temp script, then delete

**Files:**
- Create (temp): `/Users/im-yoseb/auto-trading/scripts/verify-dart.ts` — DELETE after verifying

**Interfaces:**
- Consumes: `DartApiClient` from `../src/dart/DartApiClient.js`
- Consumes: `config` from `../src/config/env.js`

- [ ] **Step 1: Write temp verification script**

Create `/Users/im-yoseb/auto-trading/scripts/verify-dart.ts`:

```typescript
// Temporary live-verification script — DELETE BEFORE COMMIT.
// DO NOT LOG THE API KEY.
import { DartApiClient } from '../src/dart/DartApiClient.js';
import { config } from '../src/config/env.js';

const client = new DartApiClient({ apiKey: config.dart.apiKey });

console.log('Fetching corp-code map...');
const map = await client.corpCodeMap();
console.log(`Corp-code map loaded: ${map.size} entries`);

const corpCode = map.get('005930');
if (!corpCode) throw new Error('005930 (Samsung) not found in corp-code map');
console.log(`005930 → corpCode: ${corpCode}`);

// Try 2025 first, fall back to 2024
let fin = await client.financials(corpCode, 2025);
let year = 2025;
if (fin === null) {
  console.log('2025 not yet filed, falling back to 2024...');
  fin = await client.financials(corpCode, 2024);
  year = 2024;
}
if (fin === null) throw new Error(`No financials found for ${corpCode}`);

console.log(`\n=== Samsung Electronics (005930) ${year} Financials ===`);
console.log(`corpCode:         ${fin.corpCode}`);
console.log(`netIncome:        ${fin.netIncome?.toLocaleString() ?? 'N/A'}`);
console.log(`totalEquity:      ${fin.totalEquity?.toLocaleString() ?? 'N/A'}`);
console.log(`totalAssets:      ${fin.totalAssets?.toLocaleString() ?? 'N/A'}`);
```

- [ ] **Step 2: Run live verification**

```bash
cd /Users/im-yoseb/auto-trading && npx tsx scripts/verify-dart.ts 2>&1
```

Expected: prints corp_code, netIncome, totalEquity, totalAssets for Samsung Electronics.

- [ ] **Step 3: Delete temp script**

```bash
rm /Users/im-yoseb/auto-trading/scripts/verify-dart.ts
```

- [ ] **Step 4: Confirm deletion**

```bash
ls /Users/im-yoseb/auto-trading/scripts/verify-dart.ts 2>&1
```

Expected: "No such file or directory"

---

### Task 6: Final checks, report, commit

**Files:**
- Create: `/Users/im-yoseb/auto-trading/.superpowers/sdd/dart-client-report.md`

**Interfaces:**
- Consumes: output of all prior tasks

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/im-yoseb/auto-trading && npx vitest run 2>&1 | tail -10
```

Expected: all files pass, ≥ 280 tests.

- [ ] **Step 2: Final typecheck**

```bash
cd /Users/im-yoseb/auto-trading && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: No scratch files left**

```bash
git status
```

Expected: only `src/dart/`, `src/config/env.ts`, `package.json`, `package-lock.json`, `docs/superpowers/plans/`, `.superpowers/sdd/` should be changed/added.

- [ ] **Step 4: Write report**

Create `/Users/im-yoseb/auto-trading/.superpowers/sdd/dart-client-report.md` with:
- Status (DONE/PARTIAL)
- Commit hash
- Test summary (X tests, all pass)
- Live 005930 financials (corpCode, netIncome, totalEquity, totalAssets, year)

- [ ] **Step 5: Final commit**

```bash
cd /Users/im-yoseb/auto-trading && git add src/dart/ src/config/env.ts package.json package-lock.json docs/superpowers/plans/ .superpowers/sdd/ && git commit -m "feat(dart): OpenDART client (corp-code map + financial statements) for Value/Quality factors"
```
