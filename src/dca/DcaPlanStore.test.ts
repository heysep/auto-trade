import { describe, it, expect, beforeEach } from 'vitest';
import { DcaPlanStore } from './DcaPlanStore.js';
import type { DcaActivePlan } from './DcaPlanRunner.js';

const t0 = Date.now();

function baseInput(): Omit<DcaActivePlan, 'id'> {
  return {
    symbol: 'AAPL',
    plan: { type: 'vanilla', cadence: 'weekly', amount: 100 },
    startedAt: t0,
    totalInvested: 0,
    shares: 0,
  };
}

describe('DcaPlanStore', () => {
  let store: DcaPlanStore;

  beforeEach(() => {
    store = new DcaPlanStore();
  });

  it('add assigns sequential ids', () => {
    const a = store.add(baseInput());
    const b = store.add(baseInput());
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  it('list returns all plans in insertion order', () => {
    store.add({ ...baseInput(), symbol: 'AAPL' });
    store.add({ ...baseInput(), symbol: 'TSLA' });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.symbol).toBe('AAPL');
    expect(list[1]?.symbol).toBe('TSLA');
  });

  it('remove deletes by id and returns true', () => {
    const p = store.add(baseInput());
    expect(store.remove(p.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('remove returns false for unknown id', () => {
    expect(store.remove(999)).toBe(false);
  });

  it('update patches totalInvested and shares', () => {
    const p = store.add(baseInput());
    const ok = store.update(p.id, { totalInvested: 100, shares: 0.5 });
    expect(ok).toBe(true);
    const found = store.list().find(x => x.id === p.id);
    expect(found?.totalInvested).toBe(100);
    expect(found?.shares).toBe(0.5);
  });

  it('update sets lastContributionAt', () => {
    const p = store.add(baseInput());
    store.update(p.id, { lastContributionAt: t0 + 1000 });
    const found = store.list().find(x => x.id === p.id);
    expect(found?.lastContributionAt).toBe(t0 + 1000);
  });

  it('update sets dipPeak', () => {
    const p = store.add(baseInput());
    store.update(p.id, { dipPeak: 250 });
    const found = store.list().find(x => x.id === p.id);
    expect(found?.dipPeak).toBe(250);
  });

  it('update preserves existing optional fields not in patch', () => {
    const p = store.add({ ...baseInput(), dipPeak: 100 });
    store.update(p.id, { totalInvested: 200 });
    const found = store.list().find(x => x.id === p.id);
    expect(found?.dipPeak).toBe(100);
  });

  it('update returns false for unknown id', () => {
    expect(store.update(999, { totalInvested: 1 })).toBe(false);
  });

  it('dump returns snapshot equal to list', () => {
    store.add(baseInput());
    store.add(baseInput());
    expect(store.dump()).toEqual(store.list());
  });

  it('restore clears and reloads plans', () => {
    store.add(baseInput());
    const snapshot: DcaActivePlan[] = [
      { id: 10, symbol: 'GOOG', plan: { type: 'vanilla', cadence: 'monthly', amount: 500 }, startedAt: t0, totalInvested: 500, shares: 1 },
      { id: 11, symbol: 'MSFT', plan: { type: 'vanilla', cadence: 'weekly', amount: 100 }, startedAt: t0, totalInvested: 0, shares: 0 },
    ];
    store.restore(snapshot);
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.symbol).toBe('GOOG');
    expect(list[1]?.symbol).toBe('MSFT');
  });

  it('restore sets nextId above max restored id', () => {
    const snapshot: DcaActivePlan[] = [
      { id: 5, symbol: 'AAPL', plan: { type: 'vanilla', cadence: 'weekly', amount: 100 }, startedAt: t0, totalInvested: 0, shares: 0 },
    ];
    store.restore(snapshot);
    const next = store.add(baseInput());
    expect(next.id).toBe(6);
  });
});
