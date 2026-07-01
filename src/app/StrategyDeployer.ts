import type { Currency, TradingMode } from '../domain/types.js';
import type { StrategyEngine } from '../strategy/StrategyEngine.js';
import type { StrategyRegistry } from '../strategy/StrategyRegistry.js';
import type { StrategySpec } from '../strategy/strategySpec.js';
import { buildStrategy } from '../strategy/strategySpec.js';
import type { WatchList } from '../market/WatchList.js';

export interface DeployRecord {
  id: number;
  symbol: string;
  name: string;
  spec: StrategySpec;
}

export interface StrategyDeployerDeps {
  engine: StrategyEngine;
  registry: StrategyRegistry;
  watchList: WatchList;
  currency: Currency;
  mode: TradingMode;
  onChange?: () => void;
}

/**
 * Owns dynamic strategy lifecycle: deploy (build+register+watch) and
 * undeploy (unregister+dewatch). Supports serialisable restore on boot.
 */
export class StrategyDeployer {
  private readonly records_ = new Map<number, DeployRecord>();
  private nextId: number;

  constructor(
    private readonly deps: StrategyDeployerDeps,
    startId: number,
  ) {
    this.nextId = startId;
  }

  /** Build, register, and start watching a new strategy. */
  deploy(input: { symbol: string; spec: StrategySpec; name: string }): DeployRecord {
    const id = this.nextId++;
    const { symbol, spec, name } = input;
    const { engine, registry, watchList, currency, mode, onChange } = this.deps;

    const strategy = buildStrategy(id, symbol, currency, mode, spec);
    engine.register(strategy);
    registry.register(strategy, name, 'PAPER_TESTING');
    watchList.add({ symbol, market: currency === 'KRW' ? 'KR' : 'US' });

    const record: DeployRecord = { id, symbol, name, spec };
    this.records_.set(id, record);
    onChange?.();
    return record;
  }

  /**
   * Unregister and stop watching a strategy.
   * Returns false if the id is unknown.
   */
  undeploy(id: number): boolean {
    const record = this.records_.get(id);
    if (!record) return false;

    const { engine, registry, watchList, onChange } = this.deps;

    engine.unregister(id);
    registry.remove(id);
    this.records_.delete(id);

    // Only remove from watchList if no other deployed record uses the symbol
    const symbolStillUsed = [...this.records_.values()].some(r => r.symbol === record.symbol);
    if (!symbolStillUsed) {
      watchList.remove(record.symbol);
    }

    onChange?.();
    return true;
  }

  /** Return a snapshot of currently deployed records. */
  records(): DeployRecord[] {
    return [...this.records_.values()];
  }

  /**
   * Rebuild strategies from persisted records (called on boot).
   * Does NOT trigger onChange. Advances the id counter past the max restored id.
   */
  restore(records: DeployRecord[]): void {
    const { engine, registry, watchList, currency, mode } = this.deps;

    let maxId = -Infinity;
    for (const record of records) {
      const { id, symbol, name, spec } = record;

      const strategy = buildStrategy(id, symbol, currency, mode, spec);
      engine.register(strategy);
      registry.register(strategy, name, 'PAPER_TESTING');
      watchList.add({ symbol, market: currency === 'KRW' ? 'KR' : 'US' });

      this.records_.set(id, record);
      if (id > maxId) maxId = id;
    }

    // Advance counter: max(startId, maxRecordId + 1)
    if (Number.isFinite(maxId)) {
      if (maxId + 1 > this.nextId) {
        this.nextId = maxId + 1;
      }
    }
  }
}
