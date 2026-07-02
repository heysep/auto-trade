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
  // Match each <list>…</list> block (CORPCODE.xml uses <list> elements)
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
  const digits = s.replace(/[()]/g, '').replace(/,/g, '');
  const n = Number(digits);
  if (!Number.isFinite(n)) return undefined;
  return negative ? -n : n;
}

// IFRS account_id → field name mapping
const ID_MAP: ReadonlyArray<readonly [string, keyof Omit<DartFinancials, 'corpCode' | 'year'>]> = [
  ['ifrs-full_Revenue',     'revenue'],
  ['ifrs-full_GrossProfit', 'grossProfit'],
  ['ifrs-full_ProfitLoss',  'netIncome'],
  ['ifrs-full_Equity',      'totalEquity'],
  ['ifrs-full_Liabilities', 'totalLiabilities'],
  ['ifrs-full_Assets',      'totalAssets'],
] as const;

// Korean account_nm fallback → field name mapping
const NM_MAP: ReadonlyArray<readonly [string, keyof Omit<DartFinancials, 'corpCode' | 'year'>]> = [
  ['매출액',       'revenue'],
  ['수익(매출액)', 'revenue'],
  ['매출총이익',   'grossProfit'],
  ['당기순이익',   'netIncome'],
  ['자본총계',     'totalEquity'],
  ['부채총계',     'totalLiabilities'],
  ['자산총계',     'totalAssets'],
] as const;

type FinancialField = keyof Omit<DartFinancials, 'corpCode' | 'year'>;

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
  const resolved = new Map<FinancialField, number>();

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

    // Find the CORPCODE.xml entry (case-insensitive key search)
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
   * Tries CFS (연결재무제표) first; retries with OFS (별도재무제표) if CFS list is empty.
   * Returns null when DART status is '013' (no data for the period).
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

    // Try CFS (연결) first
    const cfs = await fetchOnce('CFS');
    if (cfs.status === '013') return null;
    if (cfs.status !== '000') {
      throw new Error(`DART API error: ${cfs.message ?? cfs.status}`);
    }

    // CFS ok but empty list → retry with OFS (별도)
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
