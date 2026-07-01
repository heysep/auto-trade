export interface LogEvent {
  type: string;                  // ORDER_PLACED / RISK_BLOCKED / ORDER_ERROR / ...
  strategyId?: number;
  symbol?: string;
  message?: string;
  payload?: unknown;
  at: number;
}

export interface EventLogger {
  log(e: LogEvent): void;
}

/** In-memory logger for tests/dev; a DB-backed impl writes to event_logs later.
 *  Ring-buffered so a long-lived process can't grow it without bound. */
export class InMemoryEventLogger implements EventLogger {
  readonly events: LogEvent[] = [];
  constructor(private readonly cap = 10_000) {}
  log(e: LogEvent): void {
    this.events.push(e);
    if (this.events.length > this.cap) this.events.shift();   // drop oldest
  }
  ofType(type: string): LogEvent[] { return this.events.filter((e) => e.type === type); }
}
