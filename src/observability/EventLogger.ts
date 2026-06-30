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

/** In-memory logger for tests/dev; a DB-backed impl writes to event_logs later. */
export class InMemoryEventLogger implements EventLogger {
  readonly events: LogEvent[] = [];
  log(e: LogEvent): void { this.events.push(e); }
  ofType(type: string): LogEvent[] { return this.events.filter((e) => e.type === type); }
}
