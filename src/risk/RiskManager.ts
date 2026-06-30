import type { OrderRequest, Position, TradingMode, StrategyStatus } from '../domain/types.js';

export interface RiskLimits {
  maxPositionPct: number;        // per-symbol cap, % of capital
  dailyMaxLoss: number;          // absolute, positive number; halt new risk when breached
  maxConsecutiveLosses: number;  // halt new risk after this many losing trades in a row
}

export interface RiskContext {
  mode: TradingMode;
  status: StrategyStatus;
  capital: number;
  limits: RiskLimits;
  positions: Position[];          // ALL current positions for this strategy/mode (portfolio-wide)
  openOrdersForSymbol: number;    // count of unfilled orders on this symbol
  dailyRealizedPnl: number;       // today's realized P&L (negative = loss)
  unrealizedPnl?: number;         // open mark-to-market P&L; folded into the daily-loss halt
  consecutiveLosses: number;
}

export interface RiskDecision { readonly allowed: boolean; readonly reason?: string; }

const allow = (): RiskDecision => ({ allowed: true });
const deny = (reason: string): RiskDecision => ({ allowed: false, reason });

/**
 * Pre-trade gate. Exits (SELL) are ALWAYS permitted to de-risk — they are only
 * checked for oversell — so a paused/halted strategy can still cut a losing
 * position. New exposure (BUY) is subject to status / budget / concentration /
 * loss-halt limits.
 */
export class RiskManager {
  check(order: OrderRequest, referencePrice: number, ctx: RiskContext): RiskDecision {
    if (order.side === 'SELL') {
      const held = ctx.positions
        .filter((p) => p.symbol === order.symbol)
        .reduce((s, p) => s + p.quantity, 0);
      if (order.quantity > held) {
        return deny(`oversell: ${order.quantity} > held ${held} on ${order.symbol}`);
      }
      return allow();   // exits bypass status / stacking / budget gates
    }

    // BUY gates:
    if (ctx.mode === 'LIVE' && ctx.status !== 'LIVE') {
      return deny(`strategy status ${ctx.status} is not LIVE`);
    }
    if (ctx.openOrdersForSymbol > 0) {
      return deny(`open order exists on ${order.symbol}; no stacking`);
    }
    if (!(referencePrice > 0)) return deny('no valid reference price');

    const dailyPnl = ctx.dailyRealizedPnl + (ctx.unrealizedPnl ?? 0);
    if (dailyPnl <= -ctx.limits.dailyMaxLoss) {
      return deny(`daily loss limit hit (${dailyPnl})`);
    }
    if (ctx.consecutiveLosses >= ctx.limits.maxConsecutiveLosses) {
      return deny(`consecutive-loss halt (${ctx.consecutiveLosses})`);
    }

    const notional = order.quantity * referencePrice;   // referencePrice is the worst-case fill (see OrderManager)
    const invested = ctx.positions.reduce((s, p) => s + p.quantity * p.avgPrice, 0);
    if (notional > ctx.capital - invested) {
      return deny(`exceeds investment budget (need ${notional}, free ${ctx.capital - invested})`);
    }
    const symbolCost =
      ctx.positions
        .filter((p) => p.symbol === order.symbol)
        .reduce((s, p) => s + p.quantity * p.avgPrice, 0) + notional;
    if (symbolCost > ctx.capital * (ctx.limits.maxPositionPct / 100)) {
      return deny(`exceeds max position ${ctx.limits.maxPositionPct}% on ${order.symbol}`);
    }
    return allow();
  }
}
