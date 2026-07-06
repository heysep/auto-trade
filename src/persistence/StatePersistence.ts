import {
  readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { InMemoryRepository, RepoSnapshot } from './repository.js';
import type { InMemoryTradeTracker, TrackerSnapshot } from '../risk/TradeTracker.js';
import type { StrategyRegistry } from '../strategy/StrategyRegistry.js';
import type { Strategy } from '../strategy/Strategy.js';
import type { StrategyStatus } from '../domain/types.js';
import type { StrategyDeployer, DeployRecord } from '../app/StrategyDeployer.js';
import type { DcaPlanStore } from '../dca/DcaPlanStore.js';
import type { DcaActivePlan } from '../dca/DcaPlanRunner.js';

const VERSION = 1;
interface PersistedState {
  version: number;
  repo: RepoSnapshot;
  tracker: TrackerSnapshot;
  registry?: [number, StrategyStatus][];
  strategies?: [number, unknown][];     // per-strategy indicator state
  deployedSpecs?: DeployRecord[];
  dcaStore?: DcaActivePlan[];
}

export interface PersistExtra { registry?: StrategyRegistry; strategies?: Strategy[]; deployer?: StrategyDeployer; dcaStore?: DcaPlanStore; }

const isArr = Array.isArray;

/** All of repo+tracker must be present & well-shaped BEFORE we mutate anything (all-or-nothing). */
function structurallyValid(s: PersistedState): boolean {
  const r = s.repo, t = s.tracker;
  return !!r && !!t
    && isArr(r.orders) && isArr(r.byIdem) && isArr(r.fills) && isArr(r.positions) && isArr(r.equity)
    && isArr(t.baseline) && isArr(t.agg) && isArr(t.history) && isArr(t.violationDays);
}

/**
 * File-backed durability for the single-process trading worker: snapshots repo + trade
 * tracker (+ optional registry statuses and per-strategy indicator state) so trading state
 * survives a restart. Atomic write (temp + fsync + rename).
 *
 * ⚠️ Single-writer only — NOT a substitute for a real DB under multi-process deployment,
 * which would require making OrderRepository async (a larger refactor).
 */
export class FileStatePersistence {
  constructor(private readonly path: string) {}

  save(repo: InMemoryRepository, tracker: InMemoryTradeTracker, extra: PersistExtra = {}): void {
    const state: PersistedState = {
      version: VERSION,
      repo: repo.dump(),
      tracker: tracker.dump(),
      ...(extra.registry ? { registry: extra.registry.dump() } : {}),
      ...(extra.strategies
        ? { strategies: extra.strategies.filter((s) => s.serialize).map((s) => [s.id, s.serialize!()]) }
        : {}),
      ...(extra.deployer ? { deployedSpecs: extra.deployer.records() } : {}),
      ...(extra.dcaStore ? { dcaStore: extra.dcaStore.dump() } : {}),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, 'w');
    try { writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }

  /**
   * Restores into the given repo/tracker (+ registry/strategies). Returns false on
   * absent/corrupt/structurally-invalid (start fresh — recoverable, unlike the kill switch).
   * THROWS on a version mismatch: a readable file from a different schema must NOT be
   * silently discarded (that would drop real positions); migrate or remove the file.
   */
  load(repo: InMemoryRepository, tracker: InMemoryTradeTracker, extra: PersistExtra = {}): boolean {
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); } catch { return false; }   // absent
    let s: PersistedState;
    try { s = JSON.parse(raw) as PersistedState; } catch { return false; }   // unparseable
    if (s?.version !== VERSION) {
      throw new Error(`state file version ${s?.version} != ${VERSION}; refusing to discard state at ${this.path} (migrate or remove it)`);
    }
    if (!structurallyValid(s)) { console.warn(`[state] structurally invalid snapshot at ${this.path}; starting fresh`); return false; }

    repo.restore(s.repo);
    tracker.restore(s.tracker);
    if (extra.deployer && isArr(s.deployedSpecs)) extra.deployer.restore(s.deployedSpecs);
    if (extra.dcaStore && isArr(s.dcaStore)) extra.dcaStore.restore(s.dcaStore);
    if (extra.registry && isArr(s.registry)) extra.registry.restore(s.registry);
    if (extra.strategies && isArr(s.strategies)) {
      const byId = new Map(s.strategies);
      for (const strat of extra.strategies) {
        const st = byId.get(strat.id);
        if (st !== undefined && strat.deserialize) strat.deserialize(st);
      }
    }
    return true;
  }
}
