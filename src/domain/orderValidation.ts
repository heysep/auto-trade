import { isValidQuantity } from './money.js';
import type { OrderRequest } from './types.js';

/** Shared pre-trade validation so PaperBroker and LiveBroker reject the same bad orders. */
export function assertValidOrder(req: OrderRequest): void {
  if (!isValidQuantity(req.quantity, req.currency)) {
    throw new Error(`Invalid quantity ${req.quantity} for ${req.currency}`);
  }
  if (req.orderType === 'LIMIT' && !(typeof req.limitPrice === 'number' && req.limitPrice > 0)) {
    throw new Error('LIMIT order requires a positive limitPrice');
  }
}
