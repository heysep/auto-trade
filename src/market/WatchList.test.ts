import { describe, it, expect } from 'vitest';
import { WatchList } from './WatchList.js';
import type { WatchEntry } from './WatchList.js';

describe('WatchList', () => {
  it('starts empty with no initial entries', () => {
    const wl = new WatchList();
    expect(wl.list()).toEqual([]);
  });

  it('starts with provided initial entries', () => {
    const initial: WatchEntry[] = [
      { symbol: '005930', market: 'KR' },
      { symbol: 'AAPL', market: 'US' },
    ];
    const wl = new WatchList(initial);
    expect(wl.list()).toHaveLength(2);
    expect(wl.list()).toContainEqual({ symbol: '005930', market: 'KR' });
    expect(wl.list()).toContainEqual({ symbol: 'AAPL', market: 'US' });
  });

  it('add is idempotent by symbol', () => {
    const wl = new WatchList();
    wl.add({ symbol: '005930', market: 'KR' });
    wl.add({ symbol: '005930', market: 'KR' });
    wl.add({ symbol: '005930', market: 'KR' });
    expect(wl.list()).toHaveLength(1);
    expect(wl.list()[0]).toEqual({ symbol: '005930', market: 'KR' });
  });

  it('add inserts a new symbol', () => {
    const wl = new WatchList();
    wl.add({ symbol: 'AAPL', market: 'US' });
    expect(wl.list()).toEqual([{ symbol: 'AAPL', market: 'US' }]);
  });

  it('remove works for existing symbol', () => {
    const wl = new WatchList([{ symbol: '005930', market: 'KR' }]);
    wl.remove('005930');
    expect(wl.list()).toEqual([]);
  });

  it('remove is a no-op for unknown symbol', () => {
    const wl = new WatchList([{ symbol: '005930', market: 'KR' }]);
    wl.remove('AAPL');
    expect(wl.list()).toHaveLength(1);
  });

  it('list returns current state after multiple operations', () => {
    const wl = new WatchList();
    wl.add({ symbol: '005930', market: 'KR' });
    wl.add({ symbol: 'AAPL', market: 'US' });
    wl.remove('005930');
    wl.add({ symbol: '035720', market: 'KR' });
    const result = wl.list();
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ symbol: 'AAPL', market: 'US' });
    expect(result).toContainEqual({ symbol: '035720', market: 'KR' });
  });
});
