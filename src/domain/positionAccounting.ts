import type { Fill, Position, Currency, OrderSide, TradingMode } from './types.js';
import type { OrderRepository } from '../persistence/repository.js';
import { roundMoney, roundBasis } from './money.js';

export interface AccountingParams {
  strategyId: number;
  symbol: string;
  currency: Currency;
  side: OrderSide;
  mode: TradingMode;
}

/** What a fill did to the position — enough to drive round-trip P&L tracking. */
export interface FillEffect {
  realizedDelta: number;        // realized P&L from this fill (0 for buys)
  openedFromFlat: boolean;      // a BUY that opened a previously-flat position
  closedToFlat: boolean;        // a SELL that returned the position to 0 (round-trip close)
  positionRealizedPnl: number;  // cumulative realized P&L after this fill
}

/**
 * Average-cost accounting applied to one fill. Shared by PaperBroker (simulated fills)
 * and ReconciliationService (booking missed live fills) so both move positions identically.
 * avgPrice kept at basis precision (no cash rounding) to avoid cost drift; cash amounts
 * (realizedPnl) are currency-rounded. Returns a FillEffect for round-trip tracking.
 */
export function applyFillToPosition(
  repo: OrderRepository,
  p: AccountingParams,
  fill: Fill,
): FillEffect {
  const prev: Position = repo.getPosition(p.strategyId, p.symbol, p.mode) ?? {
    strategyId: p.strategyId, symbol: p.symbol, mode: p.mode,
    quantity: 0, avgPrice: 0, realizedPnl: 0,
  };
  const gross = fill.price * fill.quantity;

  if (p.side === 'BUY') {
    const buyCost = gross + fill.fee + fill.tax;          // fees fold into cost basis
    const newQty = prev.quantity + fill.quantity;
    const newAvg = (prev.quantity * prev.avgPrice + buyCost) / newQty;
    repo.upsertPosition({ ...prev, quantity: newQty, avgPrice: roundBasis(newAvg) });
    return {
      realizedDelta: 0,
      openedFromFlat: prev.quantity === 0,
      closedToFlat: false,
      positionRealizedPnl: prev.realizedPnl,
    };
  }

  // SELL
  const proceeds = gross - fill.fee - fill.tax;
  const costRemoved = fill.quantity * prev.avgPrice;
  const realizedDelta = roundMoney(proceeds - costRemoved, p.currency);
  const newQty = prev.quantity - fill.quantity;
  const newRealized = roundMoney(prev.realizedPnl + realizedDelta, p.currency);
  repo.upsertPosition({
    ...prev,
    quantity: newQty,
    avgPrice: newQty > 0 ? prev.avgPrice : 0,
    realizedPnl: newRealized,
  });
  return {
    realizedDelta,
    openedFromFlat: false,
    closedToFlat: newQty === 0,
    positionRealizedPnl: newRealized,
  };
}
