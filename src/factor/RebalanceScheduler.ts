export interface RebalanceSchedulerDeps {
  rebalance: () => Promise<unknown>;
  isHalted: () => boolean;
  isTradingDay: () => boolean;
  intervalMs: number;
  logger?: { log: (e: unknown) => void };
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
}

type LastRunRecord =
  | { at: number; ok: true }
  | { at: number; ok: false; note: string };

export class RebalanceScheduler {
  private readonly _now: () => number;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (h: ReturnType<typeof setInterval>) => void;
  private _handle: ReturnType<typeof setInterval> | undefined = undefined;
  private _inFlight = false;
  private _lastRun: LastRunRecord | undefined = undefined;

  constructor(private readonly deps: RebalanceSchedulerDeps) {
    this._now = deps.now ?? Date.now;
    this._setInterval = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = deps.clearIntervalFn ?? clearInterval;
  }

  get enabled(): boolean {
    return this._handle !== undefined;
  }

  get intervalMs(): number {
    return this.deps.intervalMs;
  }

  lastRun(): LastRunRecord | undefined {
    return this._lastRun;
  }

  start(): void {
    if (this._handle !== undefined) return;  // idempotent
    this._handle = this._setInterval(() => { void this.tick(); }, this.deps.intervalMs);
  }

  stop(): void {
    if (this._handle === undefined) return;
    this._clearInterval(this._handle);
    this._handle = undefined;
  }

  async tick(): Promise<void> {
    if (this._inFlight) return;  // overlap guard first — an in-flight run's lastRun must not be overwritten
    if (this.deps.isHalted()) {
      this._lastRun = { at: this._now(), ok: false, note: 'halted' };
      return;
    }
    if (!this.deps.isTradingDay()) {
      this._lastRun = { at: this._now(), ok: false, note: 'not a trading day' };
      return;
    }

    this._inFlight = true;
    try {
      await this.deps.rebalance();
      this._lastRun = { at: this._now(), ok: true };
    } catch (err) {
      const note = err instanceof Error ? err.message : String(err);
      this._lastRun = { at: this._now(), ok: false, note };
      this.deps.logger?.log(err);
    } finally {
      this._inFlight = false;
    }
  }
}
