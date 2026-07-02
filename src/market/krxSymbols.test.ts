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
