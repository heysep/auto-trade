import { loadData, simulate, fmt } from './engine.js';
import { gapDown } from './strategies.js';

const { syms, dates } = loadData();
const N = dates.length;
const iSplit = Math.floor(N * 0.6);
const TRAIN_START = 20, TRAIN_END = iSplit - 1, TEST_START = iSplit, TEST_END = N - 1;

console.log('Realistically-tradeable gap-down band: exclude gaps > maxG (limit-down / phantom opens).');
console.log('G=lower bound, maxG=upper bound on the gap-down %.\n');

for (const maxG of [0.08, 0.10, 0.12, 0.15]) {
  console.log(`--- maxG=${maxG} ---`);
  for (const G of [0.02, 0.03]) {
    const tr = simulate(syms, gapDown({ G, maxG }), TRAIN_START, TRAIN_END, 'best');
    const te = simulate(syms, gapDown({ G, maxG }), TEST_START, TEST_END, 'best');
    const teW = simulate(syms, gapDown({ G, maxG }), TEST_START, TEST_END, 'worst');
    console.log(`  G=${G} TRAIN ${fmt(tr.m)}`);
    console.log(`  G=${G} TEST  ${fmt(te.m)}`);
    console.log(`  G=${G} TESTw ${fmt(teW.m)}`);
  }
}

// How much of the raw (no-maxG) test edge is the extreme-gap tail?
console.log('\n--- Decomposition: G=0.02, TEST, by gap magnitude bucket ---');
const buckets: Array<[string, number, number]> = [
  ['gap 2-5%', 0.02, 0.05], ['gap 5-8%', 0.05, 0.08], ['gap 8-12%', 0.08, 0.12], ['gap 12-30%+', 0.12, 999],
];
for (const [lbl, lo, hi] of buckets) {
  const r = simulate(syms, gapDown({ G: lo, maxG: hi }), TEST_START, TEST_END, 'best');
  console.log(`  ${lbl.padEnd(12)} ${fmt(r.m)}`);
}
