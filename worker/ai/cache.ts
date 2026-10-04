import type { AskAiResponse, VersionedContextManifest } from './types';

type CacheRow = { response_json: string; generation_id: string; generation_policy_version: string; source_versions_json: string; expires_at: number };

export async function readPublicCache(db: D1Database, cacheKey: string): Promise<{ response: Omit<AskAiResponse, 'requestId' | 'feedbackToken'>; generationId: string; generationPolicyVersion: string; manifest: VersionedContextManifest } | null> {
  const row = await db.prepare(`SELECT response_json,generation_id,generation_policy_version,source_versions_json,expires_at FROM ai_cache
    WHERE cache_key=? AND expires_at>? AND NOT EXISTS (SELECT 1 FROM ai_invalid_generation_policies i WHERE i.generation_policy_version=ai_cache.generation_policy_version)`)
    .bind(cacheKey, Date.now()).first<CacheRow>();
  if (!row) return null;
  try { return { response: JSON.parse(row.response_json), generationId: row.generation_id, generationPolicyVersion: row.generation_policy_version, manifest: JSON.parse(row.source_versions_json) }; }
  catch { return null; }
}

export async function savePublicCache(db: D1Database, input: { cacheKey: string; semanticFingerprint: string; generationId: string; generationPolicyVersion: string; response: Omit<AskAiResponse, 'requestId' | 'feedbackToken'>; manifest: VersionedContextManifest }): Promise<void> {
  const createdAt = Date.now();
  await db.prepare(`INSERT INTO ai_cache(cache_key,semantic_fingerprint,generation_id,generation_policy_version,response_json,source_versions_json,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET semantic_fingerprint=excluded.semantic_fingerprint,generation_id=excluded.generation_id,
    generation_policy_version=excluded.generation_policy_version,response_json=excluded.response_json,source_versions_json=excluded.source_versions_json,
    created_at=excluded.created_at,expires_at=excluded.expires_at`)
    .bind(input.cacheKey, input.semanticFingerprint, input.generationId, input.generationPolicyVersion, JSON.stringify(input.response), JSON.stringify(input.manifest), createdAt, createdAt + 300_000).run();
}

export async function cleanupAiStorage(db: D1Database): Promise<void> {
  const stamp = Date.now();
  await db.batch([
    db.prepare('DELETE FROM ai_cache WHERE expires_at < ?').bind(stamp),
    db.prepare('DELETE FROM ai_feedback WHERE expires_at < ?').bind(stamp),
    db.prepare('DELETE FROM ai_generation_diagnostics WHERE expires_at < ?').bind(stamp),
    db.prepare('DELETE FROM ai_generation_routing_audit WHERE expires_at < ?').bind(stamp),
    db.prepare('DELETE FROM ai_generation_attempt_audit WHERE expires_at < ?').bind(stamp),
    db.prepare('DELETE FROM ai_idempotency WHERE expires_at < ?').bind(stamp),
    db.prepare(`DELETE FROM ai_generation_reservations WHERE updated_at < ? AND state != 'RESERVED'`).bind(stamp - 86_400_000),
  ]);
}
