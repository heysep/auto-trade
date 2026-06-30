// Shared HTTP concerns for Toss API calls: timeouts, body parsing, rate-limit errors.

export const REQUEST_TIMEOUT_MS = 10_000;

/** Carries rate-limit context so callers can back off intelligently. */
export class RateLimitError extends Error {
  constructor(
    readonly retryAfterSec: number | undefined,
    readonly remaining: string | null,
    readonly reset: string | null,
  ) {
    super('Toss API rate limited (429)');
    this.name = 'RateLimitError';
  }

  static from(res: Response): RateLimitError {
    const ra = res.headers.get('retry-after');
    return new RateLimitError(
      ra ? Number(ra) : undefined,
      res.headers.get('x-ratelimit-remaining'),
      res.headers.get('x-ratelimit-reset'),
    );
  }
}

/** Parse a response body, tolerating 204 / empty bodies (e.g. successful cancels). */
export async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  return JSON.parse(text);
}

/** Toss wraps payloads in `{ result: ... }`; unwrap generically. */
export function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'result' in body) {
    return (body as { result: unknown }).result;
  }
  return body;
}
