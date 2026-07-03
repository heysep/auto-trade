// Centralized, validated environment access. Secrets are read here only.
// No logging of secret values anywhere in the codebase.

import { readFileSync } from 'node:fs';
import type { TradingMode } from '../domain/types.js';

function loadDotEnv(): void {
  try {
    const raw = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trimStart().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        const key = m[1]!;
        const val = m[2] ?? '';
        if (process.env[key] === undefined) {
          process.env[key] = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {
    // .env optional when real env vars are provided by the host
  }
}
loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.includes('xxxx')) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Pure helper — exported for unit tests; no process.env side-effects.
 * Returns 'LIVE' ONLY when mode is exactly 'LIVE' AND liveEnabled is true.
 * Any other combination returns 'PAPER' (defense in depth: fail-safe to paper).
 */
export function resolveDaytradeMode(mode: string | undefined, liveEnabled: boolean): TradingMode {
  if (mode === 'LIVE' && liveEnabled) return 'LIVE';
  if (mode === 'LIVE' && !liveEnabled) {
    // Visible at boot so the operator knows mode was downgraded
    console.warn('[daytrade] DAYTRADE_MODE=LIVE requires LIVE_ENABLED=1; forcing PAPER');
  }
  return 'PAPER';
}

const _liveEnabled = process.env.LIVE_ENABLED === '1';
const _daytradeMode = resolveDaytradeMode(process.env.DAYTRADE_MODE, _liveEnabled);

export const config = {
  toss: {
    baseUrl: (process.env.TOSS_BASE_URL ?? 'https://openapi.tossinvest.com').replace(/\/$/, ''),
    clientId: required('TOSS_CLIENT_ID'),
    clientSecret: required('TOSS_CLIENT_SECRET'),
    // Refresh token lifetime margin: re-issue this many seconds before expiry.
    tokenRefreshMarginSec: 60,
  },
  dart: {
    // Optional — app boots without it; DART features gate on apiKey being non-empty.
    apiKey: process.env.DART_API_KEY ?? '',
    baseUrl: 'https://opendart.fss.or.kr',
  },
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/auto_trading',
  daytrade: {
    /** KRX ticker for the day-trade strategy (default: 011200 HMM). */
    symbol: process.env.DAYTRADE_SYMBOL ?? '011200',
    /** K multiplier for target = open + k*(prevHigh-prevLow). Default 0.5. */
    k: (() => {
      const v = Number(process.env.DAYTRADE_K ?? '0.5');
      return Number.isFinite(v) && v > 0 ? v : 0.5;
    })(),
    /** Total notional budget per day in KRW. Default 100 000. */
    budget: (() => {
      const v = Number(process.env.DAYTRADE_BUDGET ?? '100000');
      return Number.isFinite(v) && v > 0 ? v : 100_000;
    })(),
    /** Resolved trading mode: LIVE only when LIVE_ENABLED=1 AND DAYTRADE_MODE=LIVE. */
    mode: _daytradeMode,
    /** True when LIVE_ENABLED=1 — gates LiveBroker construction. */
    liveEnabled: _liveEnabled,
  },
} as const;
