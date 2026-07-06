import { loadData, simulate, fmt, annualizedNote, BUDGET, Strategy } from './engine.js';
import { breakout, gapDown, momentum, BreakoutCfg, GapCfg, MomCfg } from './strategies.js';

const { syms, dates } = loadData();
const N = dates.length;
const iSplit = Math.floor(N * 0.6);
const TRAIN_START = 20, TRAIN_END = iSplit - 1;
const TEST_START = iSplit, TEST_END = N - 1;

console.log(`=== DATA ===`);
console.log(`symbols=${syms.length} bars=${N} (${dates[0]} -> ${dates[N - 1]})`);
console.log(`split idx=${iSplit}: TRAIN dates ${dates[TRAIN_START]}..${dates[TRAIN_END]} (${TRAIN_END - TRAIN_START + 1}d), TEST ${dates[TEST_START]}..${dates[TEST_END]} (${TEST_END - TEST_START + 1}d)`);

// Budget/universe characterization
{
  let sumAfford = 0, days = 0, everAfford = new Set<string>();
  const priceAtEnd: Array<[string, number]> = [];
  for (let i = TRAIN_START; i <= TEST_END; i++) {
    let c = 0;
    for (const s of syms) { if (s.bars[i]!.open <= BUDGET) { c++; everAfford.add(s.symbol); } }
    sumAfford += c; days++;
  }
  for (const s of syms) priceAtEnd.push([s.name, s.bars[N - 1]!.close]);
  console.log(`\n=== BUDGET (₩${BUDGET.toLocaleString()}) ===`);
  console.log(`avg affordable symbols/day (open<=budget): ${(sumAfford / days).toFixed(1)} of ${syms.length}`);
  console.log(`symbols ever affordable: ${everAfford.size} of ${syms.length}`);
  const tooExpensive = syms.filter((s) => !everAfford.has(s.symbol)).map((s) => `${s.name}`);
  console.log(`NEVER affordable (price>100k whole window): ${tooExpensive.length ? tooExpensive.join(', ') : 'none'}`);
}

function trainRow(label: string, strat: Strategy): void {
  const r = simulate(syms, strat, TRAIN_START, TRAIN_END, 'best');
  console.log(`${label.padEnd(52)} ${fmt(r.m)}`);
}

console.log(`\n===== FAMILY 1: BREAKOUT (train, pick=best) =====`);
const Ks: Array<number | 'adaptive'> = [0.3, 0.5, 0.7, 'adaptive'];
const ranges = [0, 0.01, 0.02, 0.03, 0.05, 0.08];
console.log('-- base K sweep x minRangePct, no filters --');
for (const K of Ks) for (const mr of ranges) {
  trainRow(`K=${K} minR=${mr}`, breakout({ K, minRangePct: mr || undefined }));
}
console.log('-- + trend(MA20) filter --');
for (const K of Ks) for (const mr of [0.02, 0.03, 0.05]) {
  trainRow(`K=${K} minR=${mr} trendMA20`, breakout({ K, minRangePct: mr, trendMA20: true }));
}
console.log('-- + trend(MA5>MA20) --');
for (const K of Ks) for (const mr of [0.02, 0.03, 0.05]) {
  trainRow(`K=${K} minR=${mr} MA5>MA20`, breakout({ K, minRangePct: mr, trendMA5: true }));
}
console.log('-- + gapGuard --');
for (const K of Ks) for (const mr of [0.02, 0.03, 0.05]) {
  trainRow(`K=${K} minR=${mr} gapGuard`, breakout({ K, minRangePct: mr, gapGuard: true }));
}
console.log('-- + volConfirm --');
for (const K of Ks) for (const mr of [0.02, 0.03, 0.05]) {
  trainRow(`K=${K} minR=${mr} volConf`, breakout({ K, minRangePct: mr, volConfirm: true }));
}
console.log('-- combined best-guess filters --');
for (const K of [0.5, 0.7, 'adaptive'] as Array<number | 'adaptive'>) for (const mr of [0.02, 0.03, 0.05]) {
  trainRow(`K=${K} minR=${mr} trend+gapGuard`, breakout({ K, minRangePct: mr, trendMA20: true, gapGuard: true }));
  trainRow(`K=${K} minR=${mr} trend+gap+vol`, breakout({ K, minRangePct: mr, trendMA20: true, gapGuard: true, volConfirm: true }));
}

console.log(`\n===== FAMILY 2: GAP-DOWN MEAN REVERSION (train, pick=best) =====`);
for (const G of [0.02, 0.03, 0.04, 0.05, 0.06]) {
  trainRow(`G=${G} noTrend`, gapDown({ G }));
  trainRow(`G=${G} trend`, gapDown({ G, trend: true }));
  trainRow(`G=${G} trend+vol`, gapDown({ G, trend: true, volConfirm: true }));
}

console.log(`\n===== FAMILY 3: MOMENTUM CONTINUATION (train, pick=best) =====`);
for (const R of [0.03, 0.05, 0.07, 0.1]) {
  trainRow(`R=${R} bare`, momentum({ R }));
  trainRow(`R=${R} nearHigh0.3`, momentum({ R, nearHigh: 0.3 }));
  trainRow(`R=${R} nearHigh0.3+vol1.5`, momentum({ R, nearHigh: 0.3, volSpike: 1.5 }));
  trainRow(`R=${R} nearHigh0.3+vol1.5+confirm`, momentum({ R, nearHigh: 0.3, volSpike: 1.5, confirm: true }));
}

console.log(`\n(train window trading days: ${TRAIN_END - TRAIN_START + 1})`);
