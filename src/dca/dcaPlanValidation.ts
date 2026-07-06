import type { DcaPlanType, DcaCadence } from './DcaBacktest.js';

const PLAN_TYPES: readonly DcaPlanType[] = [
  'vanilla', 'valueAveraging', 'dipBuying', 'trendFiltered', 'lumpSum',
];
const CADENCES: readonly DcaCadence[] = ['weekly', 'biweekly', 'monthly'];

export function validatePlan(plan: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof plan !== 'object' || plan === null) {
    return { ok: false, error: 'plan must be an object' };
  }
  const p = plan as Record<string, unknown>;

  if (!PLAN_TYPES.includes(p['type'] as DcaPlanType)) {
    return { ok: false, error: `type must be one of ${PLAN_TYPES.join(', ')}` };
  }
  if (!CADENCES.includes(p['cadence'] as DcaCadence)) {
    return { ok: false, error: `cadence must be one of ${CADENCES.join(', ')}` };
  }

  const amount = Number(p['amount']);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'amount must be a positive finite number' };
  }

  if (p['type'] === 'dipBuying') {
    const dipExtra = Number(p['dipExtra']);
    if (!Number.isFinite(dipExtra) || dipExtra < 0) {
      return { ok: false, error: 'dipExtra must be a non-negative finite number for dipBuying' };
    }
    const dipDrawdownPct = Number(p['dipDrawdownPct']);
    if (!Number.isFinite(dipDrawdownPct) || dipDrawdownPct <= 0 || dipDrawdownPct >= 1) {
      return { ok: false, error: 'dipDrawdownPct must be in (0, 1) for dipBuying' };
    }
  }

  if (p['type'] === 'trendFiltered') {
    const tw = p['trendWindow'];
    if (!Number.isInteger(tw) || (tw as number) <= 0) {
      return { ok: false, error: 'trendWindow must be a positive integer for trendFiltered' };
    }
  }

  if (p['costPct'] !== undefined) {
    const costPct = Number(p['costPct']);
    if (!Number.isFinite(costPct) || costPct < 0 || costPct > 0.05) {
      return { ok: false, error: 'costPct must be in [0, 0.05]' };
    }
  }

  return { ok: true };
}
