import type { HaltStore, HaltState } from './HaltStore.js';

// Global kill switch (PLAN §11 #10). When tripped, every broker refuses new fills and
// OrderManager refuses new orders. Shared by reference so the API trips what trading reads.
//
// Pass a HaltStore to make the trip DURABLE across restarts — a kill switch that forgets
// itself on reboot is worse than none.
export interface HaltSwitchOptions {
  store?: HaltStore;
  initial?: HaltState;   // overrides the store's loaded state (e.g. tests)
}

export class HaltSwitch {
  private _halted = false;
  private _reason: string | undefined;
  private readonly store: HaltStore | undefined;

  constructor(opts: HaltSwitchOptions = {}) {
    this.store = opts.store;
    const init = opts.initial ?? this.store?.load() ?? undefined;
    if (init?.halted) { this._halted = true; this._reason = init.reason; }
  }

  get halted(): boolean { return this._halted; }
  get reason(): string | undefined { return this._reason; }

  trip(reason: string): void {
    this._halted = true;             // in-memory halt takes effect even if persistence fails
    this._reason = reason;
    this.persist({ halted: true, reason });
  }

  reset(): void {
    this._halted = false;
    this._reason = undefined;
    this.persist({ halted: false });
  }

  // A persistence failure must never abort the in-memory halt or its audit log.
  private persist(state: { halted: boolean; reason?: string }): void {
    try { this.store?.save(state); }
    catch (err) { console.error('[halt] failed to persist kill-switch state:', err); }
  }
}
