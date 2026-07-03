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
        { account_id: 'ifrs-full_Revenue',   account_nm: '매출액',    thstrm_amount: '302,231,360', sj_div: 'IS' },
        { account_id: 'ifrs-full_Assets',    account_nm: '자산총계',   thstrm_amount: '455,905,208', sj_div: 'BS' },
        { account_id: 'ifrs-full_Equity',    account_nm: '자본총계',   thstrm_amount: '230,126,050', sj_div: 'BS' },
        { account_id: 'ifrs-full_ProfitLoss',account_nm: '당기순이익', thstrm_amount: '15,234,000',  sj_div: 'IS' },
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
