import { describe, it, expect, vi } from 'vitest';
import { StrategyDeployer } from './StrategyDeployer.js';
import { StrategyRegistry } from '../strategy/StrategyRegistry.js';
import { StrategyEngine } from '../strategy/StrategyEngine.js';
import { WatchList } from '../market/WatchList.js';
import type { StrategySpec } from '../strategy/strategySpec.js';
import type { OrderManager } from '../order/OrderManager.js';
import type { TradingMode } from '../domain/types.js';

// Minimal StrategyEngine stub
function makeEngine(): StrategyEngine {
  const orderManager = {
    handleIntent: vi.fn(),
  } as unknown as OrderManager;
  return new StrategyEngine({
    orderManager,
    getPosition: () => undefined,
  });
}

const thresholdSpec: StrategySpec = {
  type: 'threshold',
  params: { buyBelow: 70_000, sellAbove: 80_000, orderNotional: 1_000_000 },
};

describe('StrategyDeployer', () => {
  it('deploy registers strategy in engine and registry, adds symbol to watchList, calls onChange', () => {
    const engine = makeEngine();
    const registry = new StrategyRegistry();
    const watchList = new WatchList();
    const onChange = vi.fn();

    const deployer = new StrategyDeployer(
      { engine, registry, watchList, currency: 'KRW', mode: 'PAPER', onChange },
      100,
    );

    const record = deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'my-strategy' });

    expect(record.id).toBe(100);
    expect(record.symbol).toBe('005930');
    expect(record.name).toBe('my-strategy');
    expect(record.spec).toEqual(thresholdSpec);

    // Strategy appears in registry
    expect(registry.get(100)).toBeDefined();
    expect(registry.get(100)?.name).toBe('my-strategy');
    expect(registry.get(100)?.status).toBe('PAPER_TESTING');

    // Symbol in watchList
    expect(watchList.list()).toContainEqual({ symbol: '005930', market: 'KR' });

    // onChange called
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('second deploy gets the next id', () => {
    const deployer = new StrategyDeployer(
      {
        engine: makeEngine(),
        registry: new StrategyRegistry(),
        watchList: new WatchList(),
        currency: 'KRW',
        mode: 'PAPER',
      },
      1,
    );

    const first = deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'first' });
    const second = deployer.deploy({ symbol: '035720', spec: thresholdSpec, name: 'second' });

    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  it('records() returns all deployed records', () => {
    const deployer = new StrategyDeployer(
      {
        engine: makeEngine(),
        registry: new StrategyRegistry(),
        watchList: new WatchList(),
        currency: 'KRW',
        mode: 'PAPER',
      },
      1,
    );

    deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'a' });
    deployer.deploy({ symbol: '035720', spec: thresholdSpec, name: 'b' });

    const recs = deployer.records();
    expect(recs).toHaveLength(2);
    expect(recs.map(r => r.name)).toContain('a');
    expect(recs.map(r => r.name)).toContain('b');
  });

  it('deploy uses KR market for KRW currency', () => {
    const watchList = new WatchList();
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList, currency: 'KRW', mode: 'PAPER' },
      1,
    );
    deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'kr' });
    expect(watchList.list()[0]?.market).toBe('KR');
  });

  it('deploy uses US market for USD currency', () => {
    const watchList = new WatchList();
    const smaSpec: StrategySpec = {
      type: 'sma',
      params: { fastPeriod: 5, slowPeriod: 20, orderNotional: 1000 },
    };
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList, currency: 'USD', mode: 'PAPER' },
      1,
    );
    deployer.deploy({ symbol: 'AAPL', spec: smaSpec, name: 'us' });
    expect(watchList.list()[0]?.market).toBe('US');
  });

  it('undeploy removes strategy from registry and engine, returns true', () => {
    const engine = makeEngine();
    const registry = new StrategyRegistry();
    const watchList = new WatchList();
    const onChange = vi.fn();

    const deployer = new StrategyDeployer(
      { engine, registry, watchList, currency: 'KRW', mode: 'PAPER', onChange },
      1,
    );

    const record = deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'a' });
    onChange.mockClear();

    const result = deployer.undeploy(record.id);

    expect(result).toBe(true);
    expect(registry.get(record.id)).toBeUndefined();
    expect(watchList.list()).toEqual([]);
    expect(deployer.records()).toEqual([]);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('undeploy returns false for unknown id', () => {
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList: new WatchList(), currency: 'KRW', mode: 'PAPER' },
      1,
    );
    expect(deployer.undeploy(999)).toBe(false);
  });

  it('undeploy keeps watchList symbol if another deployed record still uses it', () => {
    const watchList = new WatchList();
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList, currency: 'KRW', mode: 'PAPER' },
      1,
    );

    const r1 = deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'a' });
    deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'b' });

    // Undeploy the first one; symbol should remain because second still uses it
    deployer.undeploy(r1.id);

    expect(watchList.list()).toContainEqual({ symbol: '005930', market: 'KR' });
  });

  it('undeploy removes watchList symbol when no other strategy uses it', () => {
    const watchList = new WatchList();
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList, currency: 'KRW', mode: 'PAPER' },
      1,
    );

    const r1 = deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'a' });
    deployer.deploy({ symbol: '035720', spec: thresholdSpec, name: 'b' });

    deployer.undeploy(r1.id);

    // '005930' removed, '035720' still there
    expect(watchList.list()).not.toContainEqual({ symbol: '005930', market: 'KR' });
    expect(watchList.list()).toContainEqual({ symbol: '035720', market: 'KR' });
  });

  it('restore rebuilds records without calling onChange', () => {
    const registry = new StrategyRegistry();
    const watchList = new WatchList();
    const onChange = vi.fn();

    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry, watchList, currency: 'KRW', mode: 'PAPER', onChange },
      100,
    );

    const recordsToRestore = [
      { id: 5, symbol: '005930', name: 'a', spec: thresholdSpec },
      { id: 7, symbol: '035720', name: 'b', spec: thresholdSpec },
    ];

    deployer.restore(recordsToRestore);

    // onChange NOT called during restore
    expect(onChange).not.toHaveBeenCalled();

    // Records rebuilt
    expect(deployer.records()).toHaveLength(2);
    expect(registry.get(5)).toBeDefined();
    expect(registry.get(7)).toBeDefined();
    expect(watchList.list()).toContainEqual({ symbol: '005930', market: 'KR' });
    expect(watchList.list()).toContainEqual({ symbol: '035720', market: 'KR' });
  });

  it('restore advances id counter past the max restored id', () => {
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList: new WatchList(), currency: 'KRW', mode: 'PAPER' },
      1,
    );

    deployer.restore([
      { id: 10, symbol: '005930', name: 'a', spec: thresholdSpec },
      { id: 15, symbol: '035720', name: 'b', spec: thresholdSpec },
    ]);

    // Next deploy should use id 16 (max+1)
    const next = deployer.deploy({ symbol: '000660', spec: thresholdSpec, name: 'c' });
    expect(next.id).toBe(16);
  });

  it('restore with empty array leaves deployer in clean state', () => {
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList: new WatchList(), currency: 'KRW', mode: 'PAPER' },
      5,
    );

    deployer.restore([]);
    expect(deployer.records()).toEqual([]);

    // startId still honored
    const next = deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'a' });
    expect(next.id).toBe(5);
  });

  it('restore uses startId as floor when all restored ids are below startId', () => {
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry: new StrategyRegistry(), watchList: new WatchList(), currency: 'KRW', mode: 'PAPER' },
      20,
    );

    deployer.restore([
      { id: 3, symbol: '005930', name: 'a', spec: thresholdSpec },
    ]);

    // max(startId=20, maxRecordId+1=4) = 20
    const next = deployer.deploy({ symbol: '000660', spec: thresholdSpec, name: 'b' });
    expect(next.id).toBe(20);
  });

  it('undeploy keeps watchList symbol if a static registry strategy still uses it', () => {
    const registry = new StrategyRegistry();
    const watchList = new WatchList();
    const deployer = new StrategyDeployer(
      { engine: makeEngine(), registry, watchList, currency: 'KRW', mode: 'PAPER' },
      1,
    );

    // Register a static (non-deployer) strategy directly in the registry
    const staticStrategy = {
      id: 9999,
      symbols: new Set(['005930']),
      currency: 'KRW' as const,
      mode: 'PAPER' as const,
      evaluate: vi.fn(),
    };
    registry.register(staticStrategy, 'static-strategy', 'LIVE');

    // Deploy a dynamic strategy on the same symbol
    const dynamicRecord = deployer.deploy({ symbol: '005930', spec: thresholdSpec, name: 'dynamic' });

    // Undeploy the dynamic strategy
    deployer.undeploy(dynamicRecord.id);

    // Symbol should STILL be in watchList because the static strategy uses it
    expect(watchList.list()).toContainEqual({ symbol: '005930', market: 'KR' });
  });
});
