import { readFileSync } from 'node:fs';
const CACHE = '/private/tmp/claude-501/-Users-im-yoseb-auto-trading/f2ce0953-fc40-4f4e-8066-1b32ea638603/scratchpad/research/cache';

// suspicious trades: [symbol, name, date]
const checks: Array<[string, string, string]> = [
  ['112040', '위메이드', '2025-12-29'],
  ['112040', '위메이드', '2026-01-13'],
  ['030200', 'KT', '2026-02-06'],
  ['086520', '에코프로', '2026-06-11'],
  ['293490', '카카오게임즈', '2026-06-29'],
  ['035720', '카카오', '2026-03-04'],
  ['293490', '카카오게임즈', '2026-06-23'],
];

for (const [sym, name, date] of checks) {
  const raw = JSON.parse(readFileSync(`${CACHE}/${sym}.json`, 'utf8')) as Array<Record<string, string>>;
  const bars = raw.map((c) => ({
    date: c.timestamp.slice(0, 10), o: +c.openPrice, h: +c.highPrice, l: +c.lowPrice, c: +c.closePrice, v: c.volume ? +c.volume : NaN,
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
  const idx = bars.findIndex((b) => b.date === date);
  console.log(`\n=== ${name} ${sym} around ${date} ===`);
  for (let i = Math.max(0, idx - 2); i <= Math.min(bars.length - 1, idx + 1); i++) {
    const b = bars[i]!;
    const prev = bars[i - 1];
    const gapPct = prev ? ((prev.c - b.o) / prev.c * 100) : NaN;      // gap-down %
    const o2c = (b.c / b.o - 1) * 100;                                 // open->close %
    const dayRange = (b.h - b.l) / b.o * 100;                          // intraday range %
    const fromPrevClose = prev ? (b.h / prev.c - 1) * 100 : NaN;       // high vs prevClose (limit check)
    const mark = i === idx ? ' <-- TRADE DAY' : '';
    console.log(`${b.date} O=${b.o} H=${b.h} L=${b.l} C=${b.c} vol=${b.v}  gapDn=${gapPct.toFixed(1)}% o2c=${o2c.toFixed(1)}% range=${dayRange.toFixed(1)}% high/prevC=${fromPrevClose.toFixed(1)}%${mark}`);
  }
}
