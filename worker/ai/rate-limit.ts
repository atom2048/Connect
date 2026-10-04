import { hmacSha256 } from './fingerprint';

export const INTERACTION_RATE_LIMIT = 5;
export const INTERACTION_RATE_WINDOW_MS = 60_000;

/**
 * Authenticated users are keyed by account so a shared NAT/IP cannot consume
 * another user's burst budget. Anonymous identities are already derived from
 * the same HMACed edge address as `rateLimitKey`; counting both would charge
 * one request twice and silently cut the advertised burst limit in half.
 */
export function interactionRateLimitKeys(anonymous: boolean, viewerId: string, rateLimitKey: string): string[] {
  return [anonymous ? rateLimitKey : viewerId];
}

/**
 * D1 fallback for environments where the Cloudflare Rate Limit binding is
 * unavailable at runtime. The key is HMACed before persistence, and the
 * single SQLite upsert makes the fixed-window counter atomic across Worker
 * isolates. This table contains no raw UID, IP, question, or token.
 */
export async function persistentInteractionRateLimit(db: D1Database, secret: string, key: string, now = Date.now()): Promise<boolean> {
  const rateKey = await hmacSha256(secret, key);
  const windowStart = Math.floor(now / INTERACTION_RATE_WINDOW_MS) * INTERACTION_RATE_WINDOW_MS;
  const expiresAt = windowStart + INTERACTION_RATE_WINDOW_MS;
  const row = await db.prepare(`
    INSERT INTO ai_interaction_rate_limits(rate_key,window_start,request_count,expires_at)
    VALUES(?,?,1,?)
    ON CONFLICT(rate_key) DO UPDATE SET
      window_start=CASE WHEN ai_interaction_rate_limits.window_start=? THEN ai_interaction_rate_limits.window_start ELSE excluded.window_start END,
      request_count=CASE WHEN ai_interaction_rate_limits.window_start=? THEN ai_interaction_rate_limits.request_count+1 ELSE 1 END,
      expires_at=excluded.expires_at
    RETURNING request_count
  `).bind(rateKey, windowStart, expiresAt, windowStart, windowStart).first<{ request_count: number }>();
  return Number(row?.request_count || 0) <= INTERACTION_RATE_LIMIT;
}
