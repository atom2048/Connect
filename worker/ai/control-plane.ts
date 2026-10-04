import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import type { HardStopReason } from './types';

type RuntimeState = { enabled: boolean; hardStopReason: HardStopReason | null; routerCooldownUntil: number; imagesAvailable: boolean; imagesRetryAfter: number; alertVerifiedAt: number };

export class OpenRouterAccountControlPlane extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS permits(lease_id TEXT PRIMARY KEY, environment TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, dispatched_at INTEGER, finished_at INTEGER);
        CREATE INDEX IF NOT EXISTS permits_expiry ON permits(state,expires_at);
        CREATE TABLE IF NOT EXISTS usage_events(id TEXT PRIMARY KEY, environment TEXT NOT NULL, dispatched_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS usage_time ON usage_events(dispatched_at);
        CREATE TABLE IF NOT EXISTS runtime_state(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, hard_stop_reason TEXT, router_cooldown_until INTEGER NOT NULL, images_available INTEGER NOT NULL, images_retry_after INTEGER NOT NULL, tokens REAL NOT NULL, token_updated_at INTEGER NOT NULL);
        INSERT OR IGNORE INTO runtime_state(id,enabled,router_cooldown_until,images_available,images_retry_after,tokens,token_updated_at) VALUES(1,1,0,1,0,18,0);
        CREATE TABLE IF NOT EXISTS breaker_samples(id TEXT PRIMARY KEY, scope TEXT NOT NULL, category TEXT NOT NULL, failed INTEGER NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS breaker_scope_time ON breaker_samples(scope,created_at);
        CREATE TABLE IF NOT EXISTS breakers(scope TEXT PRIMARY KEY, state TEXT NOT NULL, open_until INTEGER NOT NULL, half_open_inflight INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS scan_failures(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS scan_failure_time ON scan_failures(created_at);
      `);
      try { this.ctx.storage.sql.exec('ALTER TABLE runtime_state ADD COLUMN alert_verified_at INTEGER NOT NULL DEFAULT 0'); } catch { /* already migrated */ }
    });
  }

  private runtimeRow(): RuntimeState & { tokens: number; tokenUpdatedAt: number } {
    const row = [...this.ctx.storage.sql.exec<{ enabled: number; hard_stop_reason: string | null; router_cooldown_until: number; images_available: number; images_retry_after: number; tokens: number; token_updated_at: number; alert_verified_at: number }>('SELECT * FROM runtime_state WHERE id=1')][0];
    return {
      enabled: Boolean(row.enabled), hardStopReason: (row.hard_stop_reason as HardStopReason | null) || null,
      routerCooldownUntil: Number(row.router_cooldown_until), imagesAvailable: Boolean(row.images_available),
      imagesRetryAfter: Number(row.images_retry_after), alertVerifiedAt: Number(row.alert_verified_at || 0), tokens: Number(row.tokens), tokenUpdatedAt: Number(row.token_updated_at),
    };
  }

  private refillTokens(stamp: number): number {
    const runtime = this.runtimeRow();
    const tokens = Math.min(18, runtime.tokens + Math.max(0, stamp - runtime.tokenUpdatedAt) * (18 / 60_000));
    this.ctx.storage.sql.exec('UPDATE runtime_state SET tokens=?,token_updated_at=? WHERE id=1', tokens, stamp);
    return tokens;
  }

  private counts(stamp: number): { account: number; production: number } {
    this.ctx.storage.sql.exec('DELETE FROM usage_events WHERE dispatched_at < ?', stamp - 86_400_000);
    const row = [...this.ctx.storage.sql.exec<{ account: number; production: number }>(`SELECT count(*) account, sum(CASE WHEN environment='production' THEN 1 ELSE 0 END) production FROM usage_events WHERE dispatched_at>=?`, stamp - 86_400_000)][0];
    return { account: Number(row.account || 0), production: Number(row.production || 0) };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') { try { body = await request.json() as Record<string, unknown>; } catch { body = {}; } }
    const stamp = Date.now();
    if (url.pathname === '/runtime') {
      const current = this.runtimeRow();
      if (!current.imagesAvailable && current.imagesRetryAfter > 0 && current.imagesRetryAfter <= stamp) {
        this.ctx.storage.sql.exec('UPDATE runtime_state SET images_available=1,images_retry_after=0 WHERE id=1');
        return Response.json(this.runtimeRow());
      }
      return Response.json(current);
    }
    if (url.pathname === '/permit/reserve') {
      const runtime = this.runtimeRow();
      if (!runtime.enabled || runtime.hardStopReason || runtime.routerCooldownUntil > stamp) return Response.json({ ok: false, code: runtime.hardStopReason || 'ROUTER_COOLDOWN', retryAfter: runtime.routerCooldownUntil }, { status: 503 });
      const environment = String(body.environment || 'production');
      const usage = this.counts(stamp);
      if (usage.account >= 900 || (environment === 'production' && usage.production >= 850)) return Response.json({ ok: false, code: 'AI_CAPACITY_UNAVAILABLE' }, { status: 503 });
      const tokens = this.refillTokens(stamp);
      if (tokens < 1) return Response.json({ ok: false, code: 'AI_CAPACITY_UNAVAILABLE' }, { status: 503 });
      const leaseId = crypto.randomUUID();
      this.ctx.storage.sql.exec('UPDATE runtime_state SET tokens=tokens-1 WHERE id=1');
      this.ctx.storage.sql.exec(`INSERT INTO permits(lease_id,environment,state,created_at,expires_at) VALUES(?,?,'RESERVED',?,?)`, leaseId, environment, stamp, stamp + 30_000);
      await this.ctx.storage.setAlarm(stamp + 31_000);
      return Response.json({ ok: true, leaseId, pressure: Math.max(usage.production / 850, usage.account / 900) });
    }
    const leaseId = String(body.leaseId || '');
    if (url.pathname === '/permit/dispatch') {
      const changed = this.ctx.storage.sql.exec(`UPDATE permits SET state='DISPATCHED',dispatched_at=? WHERE lease_id=? AND state='RESERVED' RETURNING environment`, stamp, leaseId).toArray();
      if (!changed.length) return Response.json({ ok: false }, { status: 409 });
      this.ctx.storage.sql.exec('INSERT INTO usage_events(id,environment,dispatched_at) VALUES(?,?,?)', leaseId, String(changed[0].environment), stamp);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/permit/finish') {
      this.ctx.storage.sql.exec(`UPDATE permits SET state='FINISHED',finished_at=? WHERE lease_id=? AND state='DISPATCHED'`, stamp, leaseId);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/permit/release') {
      const changed = this.ctx.storage.sql.exec(`UPDATE permits SET state='RELEASED',finished_at=? WHERE lease_id=? AND state='RESERVED' RETURNING lease_id`, stamp, leaseId).toArray();
      if (changed.length) this.ctx.storage.sql.exec('UPDATE runtime_state SET tokens=min(18,tokens+1) WHERE id=1');
      return Response.json({ ok: true, released: changed.length === 1 });
    }
    if (url.pathname === '/cooldown') {
      const until = Math.max(stamp + 60_000, Number(body.until || 0));
      this.ctx.storage.sql.exec('UPDATE runtime_state SET router_cooldown_until=? WHERE id=1', until);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/images/unavailable') {
      const nextMonth = Date.UTC(new Date(stamp).getUTCFullYear(), new Date(stamp).getUTCMonth() + 1, 1, 1);
      this.ctx.storage.sql.exec('UPDATE runtime_state SET images_available=0,images_retry_after=? WHERE id=1', Number(body.retryAfter || nextMonth));
      return Response.json({ ok: true });
    }
    if (url.pathname === '/alert/test') {
      if (!this.env.AI_ALERT_WEBHOOK_URL || !this.env.AI_ALERT_SIGNING_SECRET) return Response.json({ ok: false, code: 'ALERT_WEBHOOK_NOT_CONFIGURED' }, { status: 503 });
      const alertBody = JSON.stringify({ event: 'connect_ai_alert_test', at: new Date(stamp).toISOString() });
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.env.AI_ALERT_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(alertBody)))].map((part) => part.toString(16).padStart(2, '0')).join('');
      const response = await fetch(this.env.AI_ALERT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Connect-Signature': signature }, body: alertBody });
      if (!response.ok) return Response.json({ ok: false, code: 'ALERT_WEBHOOK_DELIVERY_FAILED', status: response.status }, { status: 503 });
      this.ctx.storage.sql.exec('UPDATE runtime_state SET alert_verified_at=? WHERE id=1', stamp);
      return Response.json({ ok: true, verifiedAt: stamp });
    }
    if (url.pathname === '/breaker/check') {
      const scope = String(body.scope || '');
      const row = [...this.ctx.storage.sql.exec<{ state: string; open_until: number; half_open_inflight: number }>('SELECT state,open_until,half_open_inflight FROM breakers WHERE scope=?', scope)][0];
      if (!row || row.state === 'CLOSED') return Response.json({ ok: true, probe: false });
      if (row.state === 'OPEN' && row.open_until > stamp) return Response.json({ ok: false, retryAfter: row.open_until }, { status: 503 });
      if (row.state === 'OPEN') this.ctx.storage.sql.exec(`UPDATE breakers SET state='HALF_OPEN',half_open_inflight=0,updated_at=? WHERE scope=?`, stamp, scope);
      const claimed = this.ctx.storage.sql.exec(`UPDATE breakers SET half_open_inflight=1,updated_at=? WHERE scope=? AND state='HALF_OPEN' AND half_open_inflight=0 RETURNING scope`, stamp, scope).toArray();
      return claimed.length ? Response.json({ ok: true, probe: true }) : Response.json({ ok: false }, { status: 503 });
    }
    if (url.pathname === '/breaker/sample') {
      const scope = String(body.scope || '');
      const failed = Boolean(body.failed);
      const category = String(body.category || 'provider');
      this.ctx.storage.sql.exec('INSERT INTO breaker_samples(id,scope,category,failed,created_at) VALUES(?,?,?,?,?)', crypto.randomUUID(), scope, category, failed ? 1 : 0, stamp);
      this.ctx.storage.sql.exec('DELETE FROM breaker_samples WHERE created_at<?', stamp - 300_000);
      const current = [...this.ctx.storage.sql.exec<{ state: string }>('SELECT state FROM breakers WHERE scope=?', scope)][0];
      if (current?.state === 'HALF_OPEN') {
        this.ctx.storage.sql.exec(`INSERT INTO breakers(scope,state,open_until,half_open_inflight,updated_at) VALUES(?, ?, ?, 0, ?)
          ON CONFLICT(scope) DO UPDATE SET state=excluded.state,open_until=excluded.open_until,half_open_inflight=0,updated_at=excluded.updated_at`, scope, failed ? 'OPEN' : 'CLOSED', failed ? stamp + 300_000 : 0, stamp);
        return Response.json({ ok: true });
      }
      const samples = this.ctx.storage.sql.exec<{ failed: number }>('SELECT failed FROM breaker_samples WHERE scope=? AND category=? ORDER BY created_at DESC LIMIT 20', scope, category).toArray();
      const failures = samples.reduce((sum, sample) => sum + Number(sample.failed), 0);
      if (samples.length >= 5 && failures / samples.length >= 0.6) this.ctx.storage.sql.exec(`INSERT INTO breakers(scope,state,open_until,half_open_inflight,updated_at) VALUES(?,'OPEN',?,0,?) ON CONFLICT(scope) DO UPDATE SET state='OPEN',open_until=excluded.open_until,half_open_inflight=0,updated_at=excluded.updated_at`, scope, stamp + 300_000, stamp);
      return Response.json({ ok: true, samples: samples.length, failures });
    }
    if (url.pathname === '/breaker/open') {
      const scope = String(body.scope || '');
      if (!scope) return Response.json({ ok: false, code: 'BREAKER_SCOPE_REQUIRED' }, { status: 400 });
      const until = Math.max(stamp + 60_000, Number(body.until || 0));
      this.ctx.storage.sql.exec(`INSERT INTO breakers(scope,state,open_until,half_open_inflight,updated_at) VALUES(?,'OPEN',?,0,?)
        ON CONFLICT(scope) DO UPDATE SET state='OPEN',open_until=excluded.open_until,half_open_inflight=0,updated_at=excluded.updated_at`, scope, until, stamp);
      return Response.json({ ok: true, retryAfter: until });
    }
    if (url.pathname === '/hard-stop') {
      const reason = String(body.reason || 'MANUAL');
      this.ctx.storage.sql.exec('UPDATE runtime_state SET enabled=0,hard_stop_reason=? WHERE id=1', reason);
      if (this.env.AI_ALERT_WEBHOOK_URL && this.env.AI_ALERT_SIGNING_SECRET) {
        const alertBody = JSON.stringify({ event: 'connect_ai_hard_stop', reason, at: new Date(stamp).toISOString() });
        this.ctx.waitUntil((async () => {
          const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.env.AI_ALERT_SIGNING_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(alertBody)))].map((part) => part.toString(16).padStart(2, '0')).join('');
          await fetch(this.env.AI_ALERT_WEBHOOK_URL!, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Connect-Signature': signature }, body: alertBody });
        })().catch(() => undefined));
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/scan-failure') {
      this.ctx.storage.sql.exec('INSERT INTO scan_failures(id,created_at) VALUES(?,?)', crypto.randomUUID(), stamp);
      this.ctx.storage.sql.exec('DELETE FROM scan_failures WHERE created_at<?', stamp - 300_000);
      const count = Number([...this.ctx.storage.sql.exec<{ count: number }>('SELECT count(*) count FROM scan_failures')][0]?.count || 0);
      if (count >= 10) this.ctx.storage.sql.exec(`UPDATE runtime_state SET enabled=0,hard_stop_reason='RISK_SCANNER_FAILURE' WHERE id=1`);
      return Response.json({ ok: true, count });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const stamp = Date.now();
    const expired = this.ctx.storage.sql.exec(`UPDATE permits SET state='EXPIRED',finished_at=? WHERE state='RESERVED' AND expires_at<=? RETURNING lease_id`, stamp, stamp).toArray();
    if (expired.length) this.ctx.storage.sql.exec('UPDATE runtime_state SET tokens=min(18,tokens+?) WHERE id=1', expired.length);
    const next = [...this.ctx.storage.sql.exec<{ next_at: number | null }>(`SELECT min(expires_at) next_at FROM permits WHERE state='RESERVED'`)][0];
    if (next?.next_at) await this.ctx.storage.setAlarm(Number(next.next_at) + 1_000);
  }
}

export async function controlFetch(env: Env, path: string, body: Record<string, unknown> = {}): Promise<Response> {
  if (!env.AI_CONTROL_PLANE) return Response.json({ ok: false, code: 'AI_CONTROL_PLANE_UNAVAILABLE' }, { status: 503 });
  try {
    return await env.AI_CONTROL_PLANE.getByName('openrouter-account').fetch(`https://control.internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (cause) {
    // A Durable Object transport error must remain distinguishable from an
    // OpenRouter failure. Callers can then stop safely without turning a
    // control-plane outage into a misleading provider error.
    console.error(JSON.stringify({
      event: 'ai_control_plane_failed',
      path,
      error: cause instanceof Error ? cause.name : 'unknown',
    }));
    return Response.json({ ok: false, code: 'AI_CONTROL_PLANE_UNAVAILABLE' }, { status: 503 });
  }
}
