import type { Currency, OrderSide } from '../domain/types.js';
import { roundMoney } from '../domain/money.js';

// Configurable cost model. Defaults are illustrative — tune to the real
// Toss commission schedule (see GET commission, once exposed) before LIVE.
export interface FeeConfig {
  commissionRate: number;        // both sides, fraction of notional
  krSellTaxRate: number;         // KR sell-only transaction tax (거래세+농특세)
  slippageBps: number;           // applied to MARKET orders only
}

export const DEFAULT_FEES: FeeConfig = {
  commissionRate: 0.00015,       // 0.015%
  krSellTaxRate: 0.0018,         // 0.18% (KR sell only)
  slippageBps: 5,                // 0.05%
};

/** Commission on a notional, rounded to currency precision. */
export function commission(notional: number, currency: Currency, cfg: FeeConfig): number {
  return roundMoney(notional * cfg.commissionRate, currency);
}

/** Transaction tax — KR sells only; 0 otherwise. */
export function tax(
  notional: number,
  currency: Currency,
  side: OrderSide,
  cfg: FeeConfig,
): number {
  if (currency === 'KRW' && side === 'SELL') {
    return roundMoney(notional * cfg.krSellTaxRate, currency);
  }
  return 0;
}

/** Slippage-adjusted fill price for MARKET orders (buys pay up, sells receive less). */
export function applySlippage(price: number, side: OrderSide, cfg: FeeConfig): number {
  const f = cfg.slippageBps / 10_000;
  return side === 'BUY' ? price * (1 + f) : price * (1 - f);
}
