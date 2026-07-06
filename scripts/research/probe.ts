import { TossApiClient } from '../../src/toss/TossApiClient.js';

async function main() {
  const client = new TossApiClient();

  // Daily probe on Samsung
  const daily = await client.getCandles('005930', '1d', 500);
  console.log('=== DAILY 005930 ===');
  console.log('count:', daily.length);
  console.log('first:', JSON.stringify(daily[0]));
  console.log('last:', JSON.stringify(daily[daily.length - 1]));
  const firstTs = daily[0]?.timestamp;
  const lastTs = daily[daily.length - 1]?.timestamp;
  console.log('range:', firstTs, '->', lastTs);
  console.log('has volume?', daily[0]?.volume !== undefined);

  // 1m probe: how deep does it go?
  const m1 = await client.getCandles('005930', '1m', 200);
  console.log('=== 1m 005930 (count=200) ===');
  console.log('count:', m1.length);
  console.log('first:', JSON.stringify(m1[0]));
  console.log('last:', JSON.stringify(m1[m1.length - 1]));

  // 1m deeper probe
  const m1deep = await client.getCandles('005930', '1m', 2000);
  console.log('=== 1m 005930 (count=2000) ===');
  console.log('count:', m1deep.length);
  const days = new Set(m1deep.map((c) => c.timestamp.slice(0, 10)));
  console.log('distinct trading days:', days.size);
  console.log('first ts:', m1deep[0]?.timestamp, 'last ts:', m1deep[m1deep.length - 1]?.timestamp);
}

main().catch((e) => { console.error(e); process.exit(1); });
