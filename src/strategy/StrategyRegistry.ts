import type { Strategy } from './Strategy.js';
import type { StrategyStatus } from '../domain/types.js';

export interface StrategyEntry {
  strategy: Strategy;
  name: string;
  status: StrategyStatus;
}

/** Public view of a strategy for the API (no live instance leaked). */
export interface StrategyView {
  id: number;
  name: string;
  status: StrategyStatus;
  mode: Strategy['mode'];
  symbols: string[];
}

const view = (e: StrategyEntry): StrategyView => ({
  id: e.strategy.id,
  name: e.name,
  status: e.status,
  mode: e.strategy.mode,
  symbols: [...e.strategy.symbols],
});

/** Holds registered strategies and their lifecycle status (DRAFT → … → LIVE). */
export class StrategyRegistry {
  private readonly entries = new Map<number, StrategyEntry>();

  register(strategy: Strategy, name: string, status: StrategyStatus = 'PAPER_TESTING'): void {
    this.entries.set(strategy.id, { strategy, name, status });
  }

  list(): StrategyView[] { return [...this.entries.values()].map(view); }

  get(id: number): StrategyView | undefined {
    const e = this.entries.get(id);
    return e ? view(e) : undefined;
  }

  entry(id: number): StrategyEntry | undefined { return this.entries.get(id); }

  setStatus(id: number, status: StrategyStatus): StrategyView | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    e.status = status;
    return view(e);
  }
}
