// Money helpers. Toss returns numeric values as STRINGS, so parse explicitly.
// We use `number` internally but round at every boundary to the currency's
// precision to avoid float drift accumulating across many fills.

export type Currency = 'KRW' | 'USD';

/** Decimal places used for monetary amounts per currency. */
export function moneyScale(currency: Currency): number {
  return currency === 'KRW' ? 0 : 2;
}

/** Round a monetary amount to its currency precision, half-away-from-zero. */
export function roundMoney(amount: number, currency: Currency): number {
  const f = 10 ** moneyScale(currency);
  // Scale by magnitude then re-apply sign so negatives round symmetrically
  // (an absolute epsilon nudge is swamped by the ULP at real money magnitudes).
  return (Math.sign(amount) * Math.round(Math.abs(amount) * f)) / f;
}

/** Round a per-share basis/ratio — finer than cash precision to avoid cost drift. */
export function roundBasis(value: number): number {
  return Math.round(value * 1e8) / 1e8;   // 8 dp, well within NUMERIC(18,4) storage
}

/** Parse a Toss string-number safely; throws on garbage rather than NaN-poisoning. */
export function parseNum(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${JSON.stringify(v)}`);
  return n;
}

/** KR equities trade in whole shares; US allows fractional. */
export function isValidQuantity(qty: number, currency: Currency): boolean {
  if (!(qty > 0) || !Number.isFinite(qty)) return false;
  if (currency === 'KRW') return Number.isInteger(qty);
  return true;
}
