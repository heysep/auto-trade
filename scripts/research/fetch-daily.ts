import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { TossApiClient } from '../../src/toss/TossApiClient.js';
import { KRX_SYMBOLS } from '../../src/market/krxSymbols.js';

const CACHE_DIR = '/private/tmp/claude-501/-Users-im-yoseb-auto-trading/f2ce0953-fc40-4f4e-8066-1b32ea638603/scratchpad/research/cache';

async function main() {
  const client = new TossApiClient();
  const summary: Array<{ symbol: string; name: string; bars: number; first: string; last: string }> = [];

  for (const stock of KRX_SYMBOLS) {
    const file = `${CACHE_DIR}/${stock.symbol}.json`;
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf8'));
      summary.push({ symbol: stock.symbol, name: stock.name, bars: cached.length, first: cached[0]?.timestamp, last: cached[cached.length - 1]?.timestamp });
      console.log(`[cache] ${stock.symbol} ${stock.name} — ${cached.length} bars`);
      continue;
    }
    try {
      const candles = await client.getCandles(stock.symbol, '1d', 500);
      writeFileSync(file, JSON.stringify(candles));
      summary.push({ symbol: stock.symbol, name: stock.name, bars: candles.length, first: candles[0]?.timestamp, last: candles[candles.length - 1]?.timestamp });
      console.log(`[fetch] ${stock.symbol} ${stock.name} — ${candles.length} bars (${candles[0]?.timestamp?.slice(0,10)} -> ${candles[candles.length-1]?.timestamp?.slice(0,10)})`);
    } catch (e) {
      console.error(`[FAIL] ${stock.symbol} ${stock.name}:`, (e as Error).message);
    }
  }

  writeFileSync(`${CACHE_DIR}/_summary.json`, JSON.stringify(summary, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log('symbols fetched:', summary.length, '/', KRX_SYMBOLS.length);
  const barCounts = summary.map((s) => s.bars);
  console.log('bar counts min/max:', Math.min(...barCounts), '/', Math.max(...barCounts));
}

main().catch((e) => { console.error(e); process.exit(1); });
