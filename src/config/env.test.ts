import { describe, it, expect } from 'vitest';
import { resolveDaytradeMode } from './env.js';

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
