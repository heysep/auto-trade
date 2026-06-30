// Live API spec probe for Toss Securities Open API.
// Zero dependencies — run with: node scripts/probe-live-spec.mjs
//
// Purpose: resolve the ⚠️ unconfirmed items in docs/toss-api-spec.md against the
// REAL API using your credentials — without ever printing secrets or tokens.
//
//   - confirms /oauth2/token works + actual expires_in (token lifetime)
//   - confirms path prefix (/v1 vs /api/v1) by probing candidates
//   - captures rate-limit headers if the server sends them
//   - discovers response SHAPE (field names + value types) for accounts/holdings/orders
//
// Safety: client_secret and access_token are NEVER logged. String values in
// discovered shapes are masked (first2…last2). Raw values are not written anywhere.

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

// --- minimal .env loader (no dotenv dependency) ---
function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trimStart().startsWith('#')) {
        env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    console.error('No .env found. Copy .env.example -> .env and fill credentials.');
    process.exit(1);
  }
  return env;
}

const env = loadEnv();
const BASE = (env.TOSS_BASE_URL || 'https://openapi.tossinvest.com').replace(/\/$/, '');
const CLIENT_ID = env.TOSS_CLIENT_ID;
const CLIENT_SECRET = env.TOSS_CLIENT_SECRET;
const SYMBOL = env.PROBE_SYMBOL || '005930';

if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_ID.includes('xxxx')) {
  console.error('TOSS_CLIENT_ID / TOSS_CLIENT_SECRET not set in .env');
  process.exit(1);
}

// mask any string value so account numbers / ids / tokens never leak in output
function maskValue(v) {
  if (typeof v === 'string') {
    if (v.length <= 4) return '***';
    return `${v.slice(0, 2)}…${v.slice(-2)} (len ${v.length})`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v; // safe scalars kept
  return v;
}

// reduce a JSON body to { field: type/maskedSample } for shape discovery
function shapeOf(obj, depth = 0) {
  if (obj === null) return 'null';
  if (Array.isArray(obj)) return obj.length ? [shapeOf(obj[0], depth + 1)] : [];
  if (typeof obj === 'object') {
    if (depth > 3) return '…';
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') out[k] = shapeOf(v, depth + 1);
      else if (typeof v === 'number') out[k] = 'number';        // hide value (e.g. accountSeq)
      else out[k] = `${typeof v}: ${maskValue(v)}`;
    }
    return out;
  }
  if (typeof obj === 'number') return 'number';
  return `${typeof obj}: ${maskValue(obj)}`;
}

function rateHeaders(res) {
  const out = {};
  for (const [k, v] of res.headers.entries()) {
    if (/ratelimit|retry-after|x-rate/i.test(k)) out[k] = v;
  }
  return out;
}

const report = { base: BASE, checkedAt: 'see-shell-date', token: {}, prefix: {}, endpoints: {} };

async function getToken() {
  // Try Basic auth + form body (most common for client_credentials).
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  let res = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  let mode = 'basic-auth';
  if (!res.ok) {
    // Fallback: credentials in body.
    res = await fetch(`${BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }).toString(),
    });
    mode = 'body-credentials';
  }
  const body = await res.json().catch(() => ({}));
  report.token = {
    ok: res.ok,
    status: res.status,
    authMode: res.ok ? mode : 'FAILED',
    token_type: body.token_type,
    expires_in: body.expires_in,           // <- confirms real token lifetime
    has_refresh_token: 'refresh_token' in body,
    rateHeaders: rateHeaders(res),
  };
  if (!res.ok) {
    console.error('Token request FAILED:', res.status, JSON.stringify(body));
    return null;
  }
  return body.access_token; // used in-memory only; never logged
}

async function probe(label, candidates, token, extraHeaders = {}) {
  // try each candidate path, record the first that returns 2xx
  for (const path of candidates) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
      });
    } catch (e) {
      report.endpoints[label] = { tried: path, error: String(e) };
      continue;
    }
    const body = await res.json().catch(() => ({}));
    const entry = {
      tried: path,
      status: res.status,
      ok: res.ok,
      rateHeaders: rateHeaders(res),
      // Always run through shapeOf so error bodies can't leak raw account-shaped data.
      ...(res.ok ? {} : { code: body?.code }),     // error codes are safe enums
      shape: shapeOf(body),
    };
    report.endpoints[label] = entry;
    if (res.ok) {
      report.prefix[label] = path.startsWith('/api/v1') ? '/api/v1' : '/v1';
      return { body, path };
    }
  }
  return null;
}

(async () => {
  console.log(`Probing ${BASE} …\n`);
  const token = await getToken();
  console.log('TOKEN:', JSON.stringify(report.token, null, 2), '\n');
  if (!token) { writeFileSync('docs/probe-result.json', JSON.stringify(report, null, 2)); process.exit(1); }

  // 1) accounts — confirms prefix + gives accountSeq for X-Tossinvest-Account.
  //    IMPORTANT: header value is accountSeq (integer), NOT accountNo.
  const acc = await probe('accounts', ['/api/v1/accounts'], token);
  let accountSeq = env.TOSS_ACCOUNT;
  if (!accountSeq && acc?.body) {
    const m = JSON.stringify(acc.body).match(/"accountSeq"\s*:\s*(\d+)/);
    if (m) accountSeq = m[1];
  }
  const accHeader = accountSeq ? { 'X-Tossinvest-Account': String(accountSeq) } : {};
  report.accountSeqUsed = accountSeq ? `present (seq, masked)` : 'NONE';

  // 2) holdings (account-scoped)
  await probe('holdings', ['/api/v1/holdings'], token, accHeader);
  // 3) price — confirm batch param shape
  await probe('price', [`/api/v1/prices?symbols=${SYMBOL}`], token);
  // 4) orders list (read-only — NO order placed). status is REQUIRED.
  await probe('orders_open', ['/api/v1/orders?status=OPEN'], token, accHeader);
  // 5) market calendar (for MarketDataWorker session hours)
  await probe('calendar_kr', ['/api/v1/market-calendar/KR'], token);

  console.log('ENDPOINTS:', JSON.stringify(report.endpoints, null, 2));
  console.log('\nPREFIX SUMMARY:', JSON.stringify(report.prefix, null, 2));
  writeFileSync('docs/probe-result.json', JSON.stringify(report, null, 2));
  console.log('\nSaved docs/probe-result.json (gitignored, secrets masked).');
  console.log('NOTE: this probe is READ-ONLY. No orders were placed.');
})();
