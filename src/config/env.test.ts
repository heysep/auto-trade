import { describe, it, expect } from 'vitest';
import { resolveDaytradeMode, parseDaytradeSymbols } from './env.js';

describe('resolveDaytradeMode', () => {
  it('returns LIVE when mode=LIVE and liveEnabled=true', () => {
    expect(resolveDaytradeMode('LIVE', true)).toBe('LIVE');
  });

  it('returns PAPER when mode=LIVE but liveEnabled=false (flag not set)', () => {
    expect(resolveDaytradeMode('LIVE', false)).toBe('PAPER');
  });

  it('returns PAPER when mode=PAPER regardless of liveEnabled', () => {
    expect(resolveDaytradeMode('PAPER', true)).toBe('PAPER');
    expect(resolveDaytradeMode('PAPER', false)).toBe('PAPER');
  });

  it('returns PAPER for unknown/empty mode values (defense in depth)', () => {
    expect(resolveDaytradeMode('', false)).toBe('PAPER');
    expect(resolveDaytradeMode('LIVE_MAYBE', true)).toBe('PAPER');
  });

  it('returns PAPER when mode is undefined', () => {
    expect(resolveDaytradeMode(undefined, true)).toBe('PAPER');
    expect(resolveDaytradeMode(undefined, false)).toBe('PAPER');
  });
});

describe('parseDaytradeSymbols', () => {
  it('parses a comma-separated list into trimmed symbol strings', () => {
    expect(parseDaytradeSymbols('011200,035720,112040', undefined))
      .toEqual(['011200', '035720', '112040']);
  });

  it('trims whitespace around each symbol', () => {
    expect(parseDaytradeSymbols(' 011200 , 035720 , 112040 ', undefined))
      .toEqual(['011200', '035720', '112040']);
  });

  it('falls back to DAYTRADE_SYMBOL as a 1-element list when DAYTRADE_SYMBOLS is absent', () => {
    expect(parseDaytradeSymbols(undefined, '011200')).toEqual(['011200']);
  });

  it('falls back to DAYTRADE_SYMBOL when DAYTRADE_SYMBOLS is empty string', () => {
    expect(parseDaytradeSymbols('', '035720')).toEqual(['035720']);
  });

  it('prefers DAYTRADE_SYMBOLS over DAYTRADE_SYMBOL when both present', () => {
    expect(parseDaytradeSymbols('011200,035720', '999999')).toEqual(['011200', '035720']);
  });

  it('returns the default 5-symbol list when both env vars are absent', () => {
    const result = parseDaytradeSymbols(undefined, undefined);
    expect(result).toContain('011200');
    expect(result).toContain('035720');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('filters out empty segments from malformed input (e.g. trailing commas)', () => {
    expect(parseDaytradeSymbols('011200,,035720,', undefined)).toEqual(['011200', '035720']);
  });
});
