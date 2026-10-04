import { id, now } from '../lib';

const dayBucket = (stamp = now()) => Math.floor(stamp / 86_400_000) * 86_400_000;

export async function reserveGeneration(db: D1Database, userId: string): Promise<string | null> {
  const reservationId = id();
  const bucket = dayBucket();
  const stamp = now();
  const result = await db.batch([
    db.prepare(`INSERT INTO ai_user_daily_quota(user_id,bucket_start,generation_reserved,generation_committed,upstream_dispatched,updated_at)
      VALUES(?,?,1,0,0,?) ON CONFLICT(user_id,bucket_start) DO UPDATE SET generation_reserved=generation_reserved+1,updated_at=excluded.updated_at
      WHERE generation_reserved + generation_committed < 10`).bind(userId, bucket, stamp),
    db.prepare(`INSERT INTO ai_generation_reservations(reservation_id,user_id,bucket_start,state,created_at,updated_at)
      SELECT ?,?,?, 'RESERVED',?,? WHERE changes() = 1`)
      .bind(reservationId, userId, bucket, stamp, stamp),
  ]);
  return Number(result[1]?.meta.changes || 0) === 1 ? reservationId : null;
}

export async function commitGeneration(db: D1Database, reservationId: string): Promise<boolean> {
  const row = await db.prepare('SELECT user_id,bucket_start,state FROM ai_generation_reservations WHERE reservation_id=?').bind(reservationId).first<{ user_id: string; bucket_start: number; state: string }>();
  if (!row || row.state !== 'RESERVED') return row?.state === 'COMMITTED';
  const stamp = now();
  const result = await db.batch([
    db.prepare(`UPDATE ai_generation_reservations SET state='COMMITTED',updated_at=? WHERE reservation_id=? AND state='RESERVED'`).bind(stamp, reservationId),
    db.prepare(`UPDATE ai_user_daily_quota SET generation_reserved=max(0,generation_reserved-1),generation_committed=generation_committed+1,updated_at=? WHERE user_id=? AND bucket_start=?`).bind(stamp, row.user_id, row.bucket_start),
  ]);
  return Number(result[0]?.meta.changes || 0) === 1;
}

export async function releaseGeneration(db: D1Database, reservationId: string): Promise<void> {
  const row = await db.prepare('SELECT user_id,bucket_start,state FROM ai_generation_reservations WHERE reservation_id=?').bind(reservationId).first<{ user_id: string; bucket_start: number; state: string }>();
  if (!row || row.state !== 'RESERVED') return;
  const stamp = now();
  await db.batch([
    db.prepare(`UPDATE ai_generation_reservations SET state='RELEASED',updated_at=? WHERE reservation_id=? AND state='RESERVED'`).bind(stamp, reservationId),
    db.prepare(`UPDATE ai_user_daily_quota SET generation_reserved=max(0,generation_reserved-1),updated_at=? WHERE user_id=? AND bucket_start=?`).bind(stamp, row.user_id, row.bucket_start),
  ]);
}

export async function commitUserBurn(db: D1Database, userId: string): Promise<boolean> {
  const bucket = dayBucket();
  const stamp = now();
  const result = await db.prepare(`INSERT INTO ai_user_daily_quota(user_id,bucket_start,generation_reserved,generation_committed,upstream_dispatched,updated_at)
    VALUES(?,?,0,0,1,?) ON CONFLICT(user_id,bucket_start) DO UPDATE SET upstream_dispatched=upstream_dispatched+1,updated_at=excluded.updated_at
    WHERE upstream_dispatched < 20 RETURNING upstream_dispatched`).bind(userId, bucket, stamp).first<{ upstream_dispatched: number }>();
  return Boolean(result && result.upstream_dispatched <= 20);
}

export async function userBurnAvailable(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT upstream_dispatched FROM ai_user_daily_quota WHERE user_id=? AND bucket_start=?').bind(userId, dayBucket()).first<{ upstream_dispatched: number }>();
  return Number(row?.upstream_dispatched || 0) < 20;
}
