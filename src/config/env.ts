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
 *
 * Parses the DAYTRADE_SYMBOLS env var (comma-separated tickers, e.g. "011200,035720").
 * Falls back to DAYTRADE_SYMBOL as a 1-element list when DAYTRADE_SYMBOLS is absent.
 * Falls back to a hardcoded default 5-symbol universe when neither is set.
 *
 * Whitespace around each symbol is trimmed; empty segments are filtered out.
 */
export function parseDaytradeSymbols(
  symbols: string | undefined,
  fallbackSymbol: string | undefined,
): string[] {
  if (symbols !== undefined && symbols !== '') {
    const list = symbols.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }
  if (fallbackSymbol !== undefined && fallbackSymbol !== '') {
    const trimmed = fallbackSymbol.trim();
    if (trimmed !== '') return [trimmed];
  }
  // Default universe: HMM / 카카오 / 위메이드 / 에코프로비엠 / 에코프로
  return ['011200', '035720', '112040', '247540', '086520'];
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
    /**
     * Candidate symbol universe (comma-separated DAYTRADE_SYMBOLS, fallback to DAYTRADE_SYMBOL,
     * then default 5-symbol list). The affordability filter auto-drops symbols the budget can't buy.
     */
    symbols: parseDaytradeSymbols(process.env.DAYTRADE_SYMBOLS, process.env.DAYTRADE_SYMBOL),
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
    /** Minimum (prevHigh-prevLow)/todayOpen for a symbol to be eligible. Default 0.01 (1%). */
    minRangePct: (() => {
      const v = Number(process.env.DAYTRADE_MIN_RANGE_PCT ?? '0.01');
      return Number.isFinite(v) && v >= 0 ? v : 0.01;
    })(),
    /** Resolved trading mode: LIVE only when LIVE_ENABLED=1 AND DAYTRADE_MODE=LIVE. */
    mode: _daytradeMode,
    /** True when LIVE_ENABLED=1 — gates LiveBroker construction. */
    liveEnabled: _liveEnabled,
  },
} as const;
