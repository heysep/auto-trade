import type { TossCandle } from '../toss/types.js';
import { DcaBacktest } from './DcaBacktest.js';
import type { DcaPlan, DcaResult, PricePoint, DcaCadence } from './DcaBacktest.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface DcaCompareInput {
  symbol: string;
  plans: DcaPlan[];
  from?: number;
  to?: number;
  historyCount?: number;
}

export interface DcaCompareResultEntry {
  label: string;
  plan: DcaPlan;
  result: DcaResult;
}

export interface DcaCompareResult {
  symbol: string;
  name?: string;
  from: number;
  to: number;
  years: number;
  priceStart: number;
  priceEnd: number;
  results: DcaCompareResultEntry[];
  benchmark: {
    lumpSum: DcaResult;
    assetReturn: number;
  };
  windowNote: string;
}

export interface DcaServiceDeps {
  getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  now?: () => number;
  ttlMs?: number;
  historyDays?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 300_000;      // 5 minutes
const DEFAULT_HISTORY_DAYS = 2000;
const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_BIWEEK = 14 * MS_PER_DAY;

// ── Private helpers ───────────────────────────────────────────────────────────

/** Count cadence firings across a full price series.  Mirrors DcaBacktest's private logic. */
function countCadencePeriods(prices: PricePoint[], cadence: DcaCadence): number {
  let n = 0;
  let last: number | null = null;
  for (const pt of prices) {
    let fire: boolean;
    if (last === null) {
      fire = true;
    } else {
      const diff = pt.date - last;
      switch (cadence) {
        case 'weekly':   fire = diff >= MS_PER_WEEK;   break;
        case 'biweekly': fire = diff >= MS_PER_BIWEEK; break;
        case 'monthly': {
          const a = new Date(last);
          const b = new Date(pt.date);
          fire = b.getUTCFullYear() !== a.getUTCFullYear() || b.getUTCMonth() !== a.getUTCMonth();
          break;
        }
      }
    }
    if (fire) { n++; last = pt.date; }
  }
  return n;
}

/** Returns a window-bias note when the slice is a bull run with no major drawdown (> 30%). */
function computeWindowNote(prices: PricePoint[]): string {
  const first = prices[0];
  const last  = prices[prices.length - 1];
  if (first === undefined || last === undefined || prices.length < 2) return '';

  let peak   = first.close;
  let maxDD  = 0;
  for (const pt of prices) {
    peak = Math.max(peak, pt.close);
    if (peak > 0) {
      const dd = (pt.close - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
  }

  const assetReturn = first.close > 0 ? last.close / first.close - 1 : 0;
  if (assetReturn > 0 && maxDD > -0.30) {
    return '이 구간은 대세상승장 — 결과 낙관 편향';
  }
  return '';
}

// ── Private cache shape ───────────────────────────────────────────────────────

interface PriceCache {
  data: PricePoint[];
  asOf: number;
}

// ── DcaService ────────────────────────────────────────────────────────────────

export class DcaService {
  private readonly getCandles: (symbol: string, interval: '1d', count: number) => Promise<TossCandle[]>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly historyDays: number;

  private readonly cache    = new Map<string, PriceCache>();
  private readonly inflight = new Map<string, Promise<PricePoint[]>>();

  constructor(deps: DcaServiceDeps) {
    this.getCandles  = deps.getCandles;
    this.now         = deps.now  ?? Date.now;
    this.ttlMs       = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.historyDays = deps.historyDays ?? DEFAULT_HISTORY_DAYS;
  }

  // ── Fetch with TTL cache + in-flight dedup ──────────────────────────────────

  private fetchPrices(symbol: string, count: number): Promise<PricePoint[]> {
    const key = `${symbol}:${count}`;
    const now = this.now();

    // Fresh cache hit
    const cached = this.cache.get(key);
    if (cached !== undefined && now - cached.asOf < this.ttlMs) {
      return Promise.resolve(cached.data);
    }

    // In-flight dedup: check AFTER expired cache (so we don't serve stale on concurrent calls)
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    const promise: Promise<PricePoint[]> = this.getCandles(symbol, '1d', count)
      .then((candles) => {
        const points: PricePoint[] = candles
          .map((c) => ({
            date:  Date.parse(c.timestamp),
            close: Number(c.closePrice),
          }))
          .filter((p): p is PricePoint =>
            Number.isFinite(p.date) && Number.isFinite(p.close) && p.close > 0,
          )
          .sort((a, b) => a.date - b.date);

        this.cache.set(key, { data: points, asOf: this.now() });
        this.inflight.delete(key);
        return points;
      })
      .catch((err: unknown) => {
        this.inflight.delete(key);
        throw err;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  // ── compare ────────────────────────────────────────────────────────────────

  async compare(input: DcaCompareInput): Promise<DcaCompareResult> {
    const { symbol, plans, from, to } = input;
    const count = input.historyCount ?? this.historyDays;

    const allPrices = await this.fetchPrices(symbol, count);

    // Slice to requested window
    const prices = allPrices.filter((p) =>
      (from === undefined || p.date >= from) &&
      (to   === undefined || p.date <= to),
    );

    if (prices.length === 0) {
      throw new Error(`no price data available for ${symbol} in the requested window`);
    }

    const firstPt = prices[0];
    const lastPt  = prices[prices.length - 1];
    // Guards for noUncheckedIndexedAccess (length checked above)
    if (firstPt === undefined || lastPt === undefined) {
      throw new Error(`internal: price slice unexpectedly empty for ${symbol}`);
    }

    const days  = (lastPt.date - firstPt.date) / MS_PER_DAY;
    const years = days / 365;

    // Run each user plan
    const results: DcaCompareResultEntry[] = plans.map((plan, i) => {
      const label = `${plan.type} / ${plan.cadence}${
        i > 0 && plans.slice(0, i).some((p) => p.type === plan.type && p.cadence === plan.cadence)
          ? ` #${i + 1}`
          : ''
      }`;
      return { label, plan, result: new DcaBacktest(plan).run(prices) };
    });

    // lumpSum benchmark — sized to max totalInvested across all user plans
    const maxInvested = results.reduce((m, r) => Math.max(m, r.result.totalInvested), 0);
    const BENCHMARK_CADENCE: DcaCadence = 'monthly';
    const periods = countCadencePeriods(prices, BENCHMARK_CADENCE);
    const lumpAmount = periods > 0 ? maxInvested / periods : maxInvested;
    const lumpPlan: DcaPlan = { type: 'lumpSum', cadence: BENCHMARK_CADENCE, amount: lumpAmount };
    const lumpSumResult: DcaResult = new DcaBacktest(lumpPlan).run(prices);

    // Annualised asset return (buy-hold, no cost)
    const assetReturn =
      days > 0 && firstPt.close > 0
        ? Math.pow(lastPt.close / firstPt.close, 365 / days) - 1
        : 0;

    const windowNote = computeWindowNote(prices);

    return {
      symbol,
      from:       firstPt.date,
      to:         lastPt.date,
      years,
      priceStart: firstPt.close,
      priceEnd:   lastPt.close,
      results,
      benchmark: { lumpSum: lumpSumResult, assetReturn },
      windowNote,
    };
  }
}
