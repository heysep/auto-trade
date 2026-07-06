// Backtest engine for KRX day-trading research. Read-only; no orders, no server.
import { readFileSync } from 'node:fs';
import { KRX_SYMBOLS } from '../../src/market/krxSymbols.js';

const CACHE_DIR = '/private/tmp/claude-501/-Users-im-yoseb-auto-trading/f2ce0953-fc40-4f4e-8066-1b32ea638603/scratchpad/research/cache';

export const BUDGET = 100_000;
export const COST_BREAKOUT = 0.0023; // entry at target (intraday)
export const COST_OPEN = 0.0028;     // entry at open (auction slippage worse)

export interface Bar {
  date: string;      // YYYY-MM-DD
  open: number; high: number; low: number; close: number; volume: number;
}
export interface Sym {
  symbol: string; name: string; sector: string;
  bars: Bar[];
  ma5: number[]; ma20: number[]; avgVol20: number[]; // aligned to bars; NaN until warm
}

export function loadData(): { syms: Sym[]; dates: string[] } {
  const syms: Sym[] = [];
  for (const stock of KRX_SYMBOLS) {
    const raw = JSON.parse(readFileSync(`${CACHE_DIR}/${stock.symbol}.json`, 'utf8')) as Array<Record<string, string>>;
    const bars: Bar[] = raw
      .map((c) => ({
        date: c.timestamp!.slice(0, 10),
        open: +c.openPrice!, high: +c.highPrice!, low: +c.lowPrice!, close: +c.closePrice!,
        volume: c.volume !== undefined ? +c.volume : NaN,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    // Drop the incomplete current day (2026-07-06 — market still open at fetch time).
    const filtered = bars.filter((b) => b.date < '2026-07-06');
    // indicators
    const n = filtered.length;
    const ma5 = new Array(n).fill(NaN);
    const ma20 = new Array(n).fill(NaN);
    const avgVol20 = new Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (i >= 4) { let s = 0; for (let k = i - 4; k <= i; k++) s += filtered[k]!.close; ma5[i] = s / 5; }
      if (i >= 19) {
        let s = 0, sv = 0; for (let k = i - 19; k <= i; k++) { s += filtered[k]!.close; sv += filtered[k]!.volume; }
        ma20[i] = s / 20; avgVol20[i] = sv / 20;
      }
    }
    syms.push({ symbol: stock.symbol, name: stock.name, sector: stock.sector ?? '', bars: filtered, ma5, ma20, avgVol20 });
  }
  // master date list = dates of first symbol (verify alignment)
  const master = syms[0]!.bars.map((b) => b.date);
  for (const s of syms) {
    if (s.bars.length !== master.length) throw new Error(`length mismatch ${s.symbol}: ${s.bars.length} vs ${master.length}`);
    for (let i = 0; i < master.length; i++) if (s.bars[i]!.date !== master[i]) throw new Error(`date misalign ${s.symbol} at ${i}: ${s.bars[i]!.date} vs ${master[i]}`);
  }
  return { syms, dates: master };
}

// A signal for one symbol on one day.
export interface Signal { entry: number; ret: number; rank: number; symbol: string; }
// Strategy: given symbol & today-index i (i>=1, warm), return signal or null.
export type Strategy = (s: Sym, i: number) => Signal | null;

export type PickMode = 'best' | 'worst' | 'alpha';

export interface Metrics {
  trades: number; winRate: number; avgTrade: number; totalReturn: number;
  mdd: number; profitFactor: number; tstat: number;
}

export function simulate(
  syms: Sym[], strat: Strategy, iStart: number, iEnd: number, pick: PickMode,
): { m: Metrics; rets: number[]; log: Array<{ date: string; symbol: string; ret: number }> } {
  const rets: number[] = [];
  const log: Array<{ date: string; symbol: string; ret: number }> = [];
  const n = syms[0]!.bars.length;
  for (let i = iStart; i <= iEnd && i < n; i++) {
    const cands: Signal[] = [];
    for (const s of syms) {
      const sig = strat(s, i);
      if (sig && sig.entry <= BUDGET && sig.entry > 0) cands.push(sig);
    }
    if (cands.length === 0) continue;
    let chosen: Signal;
    if (pick === 'alpha') {
      chosen = cands.slice().sort((a, b) => (a.symbol < b.symbol ? -1 : 1))[0]!;
    } else {
      cands.sort((a, b) => b.rank - a.rank); // descending by rank strength
      chosen = pick === 'best' ? cands[0]! : cands[cands.length - 1]!;
    }
    rets.push(chosen.ret);
    log.push({ date: syms[0]!.bars[i]!.date, symbol: chosen.symbol, ret: chosen.ret });
  }
  return { m: metrics(rets), rets, log };
}

export function metrics(rets: number[]): Metrics {
  const n = rets.length;
  if (n === 0) return { trades: 0, winRate: 0, avgTrade: 0, totalReturn: 0, mdd: 0, profitFactor: 0, tstat: 0 };
  const wins = rets.filter((r) => r > 0).length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const posSum = rets.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const negSum = Math.abs(rets.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  // equity curve + MDD
  let eq = 1, peak = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; if (eq > peak) peak = eq; const dd = eq / peak - 1; if (dd < mdd) mdd = dd; }
  return {
    trades: n, winRate: wins / n, avgTrade: mean, totalReturn: eq - 1, mdd,
    profitFactor: negSum === 0 ? Infinity : posSum / negSum,
    tstat: std === 0 ? 0 : (mean / std) * Math.sqrt(n),
  };
}

export function fmt(m: Metrics): string {
  const pf = m.profitFactor === Infinity ? 'inf' : m.profitFactor.toFixed(2);
  return `n=${m.trades} win=${(m.winRate * 100).toFixed(0)}% avg=${(m.avgTrade * 100).toFixed(3)}% ret=${(m.totalReturn * 100).toFixed(1)}% mdd=${(m.mdd * 100).toFixed(1)}% pf=${pf} t=${m.tstat.toFixed(2)}`;
}

// annualize: trades happen at most 1/day; estimate CAGR from totalReturn over the window's calendar span.
export function annualizedNote(m: Metrics, tradingDays: number): string {
  const yrs = tradingDays / 245;
  const cagr = yrs > 0 ? Math.pow(1 + m.totalReturn, 1 / yrs) - 1 : 0;
  return `~${(cagr * 100).toFixed(0)}%/yr over ${yrs.toFixed(2)}y`;
}
