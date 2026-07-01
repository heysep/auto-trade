import { describe, it, expect } from 'vitest';
import { StrategyRegistry } from './StrategyRegistry.js';
import { ThresholdStrategy } from './ThresholdStrategy.js';

const strat = (id: number) => new ThresholdStrategy({
  id, symbol: '005930', currency: 'KRW', mode: 'PAPER',
  buyBelow: 70_000, sellAbove: 80_000, orderNotional: 1_000_000,
});

describe('StrategyRegistry', () => {
  it('registers and lists a public view (no live instance leaked)', () => {
    const r = new StrategyRegistry();
    r.register(strat(1), 'dip-buyer');
    expect(r.list()).toEqual([
      { id: 1, name: 'dip-buyer', status: 'PAPER_TESTING', mode: 'PAPER', symbols: ['005930'] },
    ]);
  });

  it('gets by id and returns undefined for unknown', () => {
    const r = new StrategyRegistry();
    r.register(strat(1), 'a');
    expect(r.get(1)?.name).toBe('a');
    expect(r.get(99)).toBeUndefined();
  });

  it('updates status, rejecting unknown ids', () => {
    const r = new StrategyRegistry();
    r.register(strat(1), 'a');
    expect(r.setStatus(1, 'APPROVED')?.status).toBe('APPROVED');
    expect(r.get(1)?.status).toBe('APPROVED');
    expect(r.setStatus(99, 'LIVE')).toBeUndefined();
  });
});
