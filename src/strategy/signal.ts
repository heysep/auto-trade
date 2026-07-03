import type { Currency } from '../domain/types.js';
import type { OrderIntent } from './Strategy.js';
import { isValidQuantity } from '../domain/money.js';

export type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/** Target-direction (from a signal) + current holding -> at most one order intent. */
export function signalToIntent(
  signal: Signal,
  held: number,
  opts: { currency: Currency; price: number; orderNotional: number },
): OrderIntent | null {
  if (signal === 'BULLISH' && held === 0) {
    const raw = opts.orderNotional / opts.price;
    const qty = opts.currency === 'KRW' ? Math.floor(raw) : raw;
    if (!isValidQuantity(qty, opts.currency)) return null;
    return { side: 'BUY', quantity: qty, orderType: 'MARKET', reason: 'signal BULLISH' };
  }
  if (signal === 'BEARISH' && held > 0) {
    return { side: 'SELL', quantity: held, orderType: 'MARKET', reason: 'signal BEARISH' };
  }
  return null;
}
