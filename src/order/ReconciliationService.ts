import type { Broker } from '../broker/Broker.js';
import type { OrderRepository } from '../persistence/repository.js';
import type { TradingMode } from '../domain/types.js';
import type { EventLogger } from '../observability/EventLogger.js';
import type { TradeTracker } from '../risk/TradeTracker.js';
import { applyFillToPosition } from '../domain/positionAccounting.js';

export interface ReconciliationReport {
  matched: number;
  orphanBroker: string[];   // open at broker, absent from our DB (we lost track)
  resolvedLocal: string[];  // were open locally, closed at broker -> we booked their fills
}

export interface ReconciliationOptions {
  mode: TradingMode;
  now?: () => number;
  tracker?: TradeTracker;
}

/**
 * On boot (and periodically), align our DB's open orders with the broker's truth.
 * Match is by broker order id: a LIVE order's local id IS its Toss orderId.
 * Discrepancies are logged so a human/automation can resolve before trading resumes.
 */
export class ReconciliationService {
  private readonly mode: TradingMode;
  private readonly now: () => number;
  private readonly tracker: TradeTracker | undefined;

  constructor(
    private readonly broker: Broker,
    private readonly repo: OrderRepository,
    private readonly logger: EventLogger,
    opts: ReconciliationOptions,
  ) {
    this.mode = opts.mode;
    this.now = opts.now ?? Date.now;
    this.tracker = opts.tracker;
  }

  async reconcile(): Promise<ReconciliationReport> {
    let live;
    try {
      live = await this.broker.getOpenOrders();
    } catch (err) {
      // A reconcile that can't reach the broker must be loud, not silently swallowed.
      this.logger.log({ type: 'RECONCILE_ERROR', message: String(err), at: this.now() });
      throw err;
    }
    const local = this.repo.getOpenOrders(this.mode);
    const liveIds = new Set(live.map((o) => o.brokerOrderId));
    const localIds = new Set(local.map((o) => o.id));

    const matched = local.filter((o) => liveIds.has(o.id)).length;
    const orphanBroker = live.filter((o) => !localIds.has(o.brokerOrderId)).map((o) => o.brokerOrderId);

    // Orders open locally but no longer open at the broker FILLED or were CANCELED while we
    // were offline. Book any missed fills (PLAN §5.8) and close the local order.
    const resolvedLocal: string[] = [];
    for (const o of local.filter((x) => !liveIds.has(x.id))) {
      const fills = await this.broker.getFills(o.id);
      for (const f of fills) {
        this.repo.addFill(f);
        const effect = applyFillToPosition(this.repo, {
          strategyId: o.strategyId, symbol: o.symbol, currency: o.currency, side: o.side, mode: o.mode,
        }, f);
        this.tracker?.onFill(
          { strategyId: o.strategyId, symbol: o.symbol, mode: o.mode, currency: o.currency },
          effect, f.filledAt,
        );
      }
      this.repo.updateOrder({ ...o, status: fills.length ? 'FILLED' : 'CANCELED' });
      resolvedLocal.push(o.id);
    }

    const report: ReconciliationReport = { matched, orphanBroker, resolvedLocal };
    if (orphanBroker.length || resolvedLocal.length) {
      this.logger.log({
        type: 'RECONCILE_MISMATCH', message: 'open-order set diverged from broker',
        payload: report, at: this.now(),
      });
    }
    return report;
  }
}
