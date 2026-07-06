import { loadData, simulate, fmt, metrics, BUDGET, COST_OPEN, Sym } from './engine.js';
import { gapDown, GapCfg } from './strategies.js';

const { syms, dates } = loadData();
const N = dates.length;
const iSplit = Math.floor(N * 0.6);
const TRAIN_START = 20, TRAIN_END = iSplit - 1;
const TEST_START = iSplit, TEST_END = N - 1;

console.log(`TEST window: ${dates[TEST_START]}..${dates[TEST_END]} (${TEST_END - TEST_START + 1} trading days)`);
console.log(`Frozen family: GAP-DOWN MEAN REVERSION (no trend, no vol filter). Cost=${COST_OPEN * 100}% (open entry).\n`);

// Pre-specified frozen candidates (chosen from TRAIN only):
//  primary  = G=0.02 (max trade count -> best chance of statistically evaluable test)
//  variants = G=0.025, G=0.03 (stricter, higher per-trade edge on train)
const candidates: Array<[string, GapCfg]> = [
  ['G=0.02  (PRIMARY)', { G: 0.02 }],
  ['G=0.025', { G: 0.025 }],
  ['G=0.03', { G: 0.03 }],
];

console.log('===== TEST-PERIOD RESULTS (frozen), tie-break sensitivity =====');
for (const [label, cfg] of candidates) {
  for (const pick of ['best', 'worst', 'alpha'] as const) {
    const r = simulate(syms, gapDown(cfg), TEST_START, TEST_END, pick);
    console.log(`${label.padEnd(20)} pick=${pick.padEnd(6)} ${fmt(r.m)}`);
  }
  console.log('');
}

// Sensitivity: does adding the trend filter (which HURT on train) also hurt on test?
console.log('===== TEST: trend-filter sensitivity (pick=best) =====');
for (const [label, cfg] of candidates) {
  const rNo = simulate(syms, gapDown(cfg), TEST_START, TEST_END, 'best');
  const rYes = simulate(syms, gapDown({ ...cfg, trend: true }), TEST_START, TEST_END, 'best');
  console.log(`${label.padEnd(20)} noTrend: ${fmt(rNo.m)}`);
  console.log(`${''.padEnd(20)} trend:   ${fmt(rYes.m)}`);
}

// ===== Clustering / independence diagnostics for PRIMARY on TEST =====
console.log('\n===== CLUSTERING DIAGNOSTICS (G=0.02 primary, pick=best, TEST) =====');
const prim = gapDown({ G: 0.02 });
const r = simulate(syms, prim, TEST_START, TEST_END, 'best');
// Per trade date: how many AFFORDABLE symbols also signalled that day (co-signal count)?
const perDay: Array<{ date: string; symbol: string; ret: number; coSignals: number }> = [];
for (let i = TEST_START; i <= TEST_END; i++) {
  let co = 0;
  for (const s of syms) {
    const sig = gapDown({ G: 0.02 })(s, i);
    if (sig && sig.entry <= BUDGET && sig.entry > 0) co++;
  }
  const t = r.log.find((x) => x.date === dates[i]);
  if (t) perDay.push({ date: dates[i]!, symbol: t.symbol, ret: t.ret, coSignals: co });
}
console.log(`total trades: ${perDay.length}`);
const multi = perDay.filter((d) => d.coSignals >= 3).length;
const solo = perDay.filter((d) => d.coSignals === 1).length;
console.log(`trades on "cluster" days (>=3 affordable symbols gapped down): ${multi} (${(100 * multi / perDay.length).toFixed(0)}%)`);
console.log(`trades on solo days (only 1 symbol gapped down): ${solo}`);
// P&L concentration
const sorted = perDay.slice().sort((a, b) => b.ret - a.ret);
const totalPnl = perDay.reduce((a, b) => a + b.ret, 0);
const top3 = sorted.slice(0, 3).reduce((a, b) => a + b.ret, 0);
const top5 = sorted.slice(0, 5).reduce((a, b) => a + b.ret, 0);
console.log(`sum of per-trade returns: ${(totalPnl * 100).toFixed(1)}%`);
console.log(`top-3 trades contribute: ${(top3 * 100).toFixed(1)}% (${(100 * top3 / totalPnl).toFixed(0)}% of total)`);
console.log(`top-5 trades contribute: ${(top5 * 100).toFixed(1)}% (${(100 * top5 / totalPnl).toFixed(0)}% of total)`);
// month distribution
const byMonth = new Map<string, number>();
for (const d of perDay) byMonth.set(d.date.slice(0, 7), (byMonth.get(d.date.slice(0, 7)) ?? 0) + 1);
console.log(`trade months: ${[...byMonth.entries()].map(([m, c]) => `${m}:${c}`).join(' ')}`);

// Robustness: leave-one-out on the single best trade — does the edge survive removing it?
const retsNoTop = perDay.slice().sort((a, b) => b.ret - a.ret).slice(1).map((d) => d.ret);
console.log(`\nDrop single best trade -> ${fmt(metrics(retsNoTop))}`);
const retsNoTop3 = perDay.slice().sort((a, b) => b.ret - a.ret).slice(3).map((d) => d.ret);
console.log(`Drop top-3 trades   -> ${fmt(metrics(retsNoTop3))}`);

// full trade log
console.log('\n=== PRIMARY test trade log (date, symbol, ret%, coSignals) ===');
for (const d of perDay) {
  const nm = syms.find((s) => s.symbol === d.symbol)!.name;
  console.log(`${d.date} ${d.symbol} ${nm.padEnd(10)} ${(d.ret * 100).toFixed(2).padStart(7)}%  co=${d.coSignals}`);
}
