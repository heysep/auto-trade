import type { DcaActivePlan } from './DcaPlanRunner.js';

// ── Patch type ────────────────────────────────────────────────────────────────

/**
 * Fields that DcaScheduler / TradingSystem may update after a contribution.
 * All optional; only provided fields are applied.
 */
export interface DcaStorePatch {
  lastContributionAt?: number;
  totalInvested?: number;
  shares?: number;
  dipPeak?: number;
}

// ── DcaPlanStore ──────────────────────────────────────────────────────────────

/**
 * In-memory repository for active DCA plans.
 *
 * Thread-safety note: Node.js is single-threaded; async operations in the
 * scheduler do not interleave with synchronous Map mutations here.
 */
export class DcaPlanStore {
  private readonly _map = new Map<number, DcaActivePlan>();
  private _nextId = 1;

  /** Assign an ID, store, and return the plan. */
  add(input: Omit<DcaActivePlan, 'id'>): DcaActivePlan {
    const id = this._nextId++;
    const plan: DcaActivePlan = { id, ...input };
    this._map.set(id, plan);
    return plan;
  }

  /** All active plans (insertion order). */
  list(): DcaActivePlan[] {
    return [...this._map.values()];
  }

  /** Returns false when id not found. */
  remove(id: number): boolean {
    return this._map.delete(id);
  }

  /**
   * Apply a partial patch to plan `id`.
   *
   * Built field-by-field to satisfy `exactOptionalPropertyTypes`: optional
   * fields are only added when the patch value is defined.
   */
  update(id: number, patch: DcaStorePatch): boolean {
    const existing = this._map.get(id);
    if (existing === undefined) return false;

    // Build updated object explicitly — spread of Partial triggers
    // exactOptionalPropertyTypes errors if we spread undefined keys.
    const updated: DcaActivePlan = {
      id:            existing.id,
      symbol:        existing.symbol,
      plan:          existing.plan,
      startedAt:     existing.startedAt,
      totalInvested: patch.totalInvested !== undefined ? patch.totalInvested : existing.totalInvested,
      shares:        patch.shares        !== undefined ? patch.shares        : existing.shares,
    };

    // Optional fields — only include when a value exists in patch or existing.
    if (patch.lastContributionAt !== undefined) {
      updated.lastContributionAt = patch.lastContributionAt;
    } else if (existing.lastContributionAt !== undefined) {
      updated.lastContributionAt = existing.lastContributionAt;
    }

    if (patch.dipPeak !== undefined) {
      updated.dipPeak = patch.dipPeak;
    } else if (existing.dipPeak !== undefined) {
      updated.dipPeak = existing.dipPeak;
    }

    this._map.set(id, updated);
    return true;
  }

  /** Snapshot for persistence. */
  dump(): DcaActivePlan[] {
    return this.list();
  }

  /**
   * Clear all plans and replace with `plans`.
   * Sets nextId to max(plan.id) + 1 so future ids don't collide.
   */
  restore(plans: DcaActivePlan[]): void {
    this._map.clear();
    let maxId = 0;
    for (const plan of plans) {
      this._map.set(plan.id, plan);
      if (plan.id > maxId) maxId = plan.id;
    }
    this._nextId = maxId + 1;
  }
}
