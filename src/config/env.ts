// Centralized, validated environment access. Secrets are read here only.
// No logging of secret values anywhere in the codebase.

import { readFileSync } from 'node:fs';

function loadDotEnv(): void {
  try {
    const raw = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of raw.split('\n')) {
      if (line.trimStart().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        const key = m[1]!;
        const val = m[2] ?? '';
        if (process.env[key] === undefined) {
          process.env[key] = val.replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch {
    // .env optional when real env vars are provided by the host
  }
}
loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.includes('xxxx')) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  toss: {
    baseUrl: (process.env.TOSS_BASE_URL ?? 'https://openapi.tossinvest.com').replace(/\/$/, ''),
    clientId: required('TOSS_CLIENT_ID'),
    clientSecret: required('TOSS_CLIENT_SECRET'),
    // Refresh token lifetime margin: re-issue this many seconds before expiry.
    tokenRefreshMarginSec: 60,
  },
  dart: {
    // Optional — app boots without it; DART features gate on apiKey being non-empty.
    apiKey: process.env.DART_API_KEY ?? '',
    baseUrl: 'https://opendart.fss.or.kr',
  },
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/auto_trading',
} as const;
