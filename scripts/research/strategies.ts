import { Sym, Signal, Strategy, COST_BREAKOUT, COST_OPEN } from './engine.js';

// ---------- Family 1: filtered volatility breakout ----------
export interface BreakoutCfg {
  K: number | 'adaptive';
  trendMA20?: boolean;   // prev.close > MA20
  trendMA5?: boolean;    // MA5 > MA20
  gapGuard?: boolean;    // skip if open >= prevHigh
  volConfirm?: boolean;  // prevVol > avgVol20*1.3
  minRangePct?: number;  // prevRange/open >= x
  maxRangePct?: number;
}
export function breakout(cfg: BreakoutCfg): Strategy {
  return (s: Sym, i: number): Signal | null => {
    if (i < 20) return null;
    const prev = s.bars[i - 1]!, today = s.bars[i]!;
    const prevRange = prev.high - prev.low;
    if (prevRange <= 0) return null;
    const rangePct = prevRange / today.open;
    if (cfg.minRangePct !== undefined && rangePct < cfg.minRangePct) return null;
    if (cfg.maxRangePct !== undefined && rangePct > cfg.maxRangePct) return null;
    let K: number;
    if (cfg.K === 'adaptive') {
      K = 1 - Math.abs(prev.close - prev.open) / prevRange; // yesterday noise ratio
      if (K < 0) K = 0; if (K > 1) K = 1;
    } else K = cfg.K;
    if (cfg.gapGuard && today.open >= prev.high) return null;
    if (cfg.trendMA20 && !(prev.close > s.ma20[i - 1]!)) return null;
    if (cfg.trendMA5 && !(s.ma5[i - 1]! > s.ma20[i - 1]!)) return null;
    if (cfg.volConfirm && !(prev.volume > s.avgVol20[i - 1]! * 1.3)) return null;
    const target = today.open + K * prevRange;
    if (today.high < target) return null; // no breakout
    const entry = Math.max(target, today.open); // can't fill below the open
    const ret = today.close / entry - 1 - COST_BREAKOUT;
    return { entry, ret, rank: rangePct, symbol: s.symbol };
  };
}

// ---------- Family 2: gap-down mean reversion ----------
export interface GapCfg { G: number; maxG?: number; trend?: boolean; volConfirm?: boolean; }
export function gapDown(cfg: GapCfg): Strategy {
  return (s: Sym, i: number): Signal | null => {
    if (i < 20) return null;
    const prev = s.bars[i - 1]!, today = s.bars[i]!;
    const gap = (prev.close - today.open) / prev.close;
    if (gap < cfg.G) return null;
    if (cfg.maxG !== undefined && gap > cfg.maxG) return null; // exclude limit-down/phantom extremes (untradeable)
    if (cfg.trend && !(prev.close > s.ma20[i - 1]!)) return null;
    if (cfg.volConfirm && !(prev.volume > s.avgVol20[i - 1]! * 1.3)) return null;
    const entry = today.open;
    const ret = today.close / entry - 1 - COST_OPEN;
    return { entry, ret, rank: gap, symbol: s.symbol };
  };
}

// ---------- Family 3: momentum continuation ----------
export interface MomCfg {
  R: number;          // prior-day return threshold
  nearHigh?: number;  // (prevHigh-prevClose)/prevRange <= nearHigh
  volSpike?: number;  // prevVol > avgVol20*mult
  confirm?: boolean;  // require today.open > prev.close
}
export function momentum(cfg: MomCfg): Strategy {
  return (s: Sym, i: number): Signal | null => {
    if (i < 21) return null;
    const prev2 = s.bars[i - 2]!, prev = s.bars[i - 1]!, today = s.bars[i]!;
    const prevRange = prev.high - prev.low;
    if (prevRange <= 0) return null;
    const priorRet = prev.close / prev2.close - 1;
    if (priorRet < cfg.R) return null;
    if (cfg.nearHigh !== undefined && !((prev.high - prev.close) / prevRange <= cfg.nearHigh)) return null;
    if (cfg.volSpike !== undefined && !(prev.volume > s.avgVol20[i - 1]! * cfg.volSpike)) return null;
    if (cfg.confirm && !(today.open > prev.close)) return null;
    const entry = today.open;
    const ret = today.close / entry - 1 - COST_OPEN;
    return { entry, ret, rank: priorRet, symbol: s.symbol };
  };
}
