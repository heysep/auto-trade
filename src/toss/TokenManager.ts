// OAuth2 token lifecycle for the Toss Open API.
// Toss uses client_credentials and issues NO refresh_token, so "refresh" = re-issue.
// Token kept in memory only; never logged, never persisted in plaintext.

import { config } from '../config/env.js';
import { REQUEST_TIMEOUT_MS } from './http.js';
import type { TokenResponse } from './types.js';

export class TokenManager {
  private token: string | null = null;
  private expiresAtMs = 0;
  private inflight: Promise<string> | null = null;

  /** Returns a valid access token, re-issuing if expired/near-expiry. */
  async getToken(now: number = Date.now()): Promise<string> {
    const marginMs = config.toss.tokenRefreshMarginSec * 1000;
    if (this.token && now < this.expiresAtMs - marginMs) return this.token;
    // De-duplicate concurrent re-issue (single-flight lock).
    if (this.inflight) return this.inflight;
    this.inflight = this.issue(now).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async issue(now: number): Promise<string> {
    const basic = Buffer.from(
      `${config.toss.clientId}:${config.toss.clientSecret}`,
    ).toString('base64');

    const res = await fetch(`${config.toss.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Do not include the response body verbatim — may echo request context.
      throw new Error(`Token issuance failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as TokenResponse;
    this.token = body.access_token;
    this.expiresAtMs = now + body.expires_in * 1000;
    return this.token;
  }
}
