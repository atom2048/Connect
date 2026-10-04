import type { Env } from '../types';
import type { ApprovedEndpointSnapshot } from './types';
import { reviewedNoTrainingEndpoint } from './config';

type SnapshotRow = { snapshot_id: string; snapshot_json: string };

const SNAPSHOT_TTL_MS = 12 * 3_600_000;

/**
 * A scheduled refresh may extend a previously approved endpoint only when
 * the live metadata still proves the same zero-cost/no-training contract.
 * Retained endpoints are allowed for PUBLIC_AI by the original predeploy
 * policy, so they must not silently expire between cron runs. Fixed-duration
 * and unknown retention remain manual-review snapshots and are left alone.
 */
export function endpointRefreshDecision(
  snapshot: ApprovedEndpointSnapshot,
  trainingAllowed: boolean | null,
  pricingValid: boolean,
  zdrVerified: boolean,
): 'REFRESH' | 'INVALIDATE' | 'SKIP' {
  if (!pricingValid || !zdrVerified || trainingAllowed === true) return 'INVALIDATE';
  if (trainingAllowed !== false) return 'SKIP';
  return snapshot.retention.type === 'zdr' || snapshot.retention.type === 'retained' ? 'REFRESH' : 'SKIP';
}

export async function refreshEndpointPolicies(env: Env): Promise<void> {
  if (!env.DB || !env.OPENROUTER_API_KEY?.trim()) return;
  const zdrResponse = await fetch('https://openrouter.ai/api/v1/endpoints/zdr', { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } }).catch(() => null);
  const zdrPayload: { data?: Array<Record<string, unknown>> } = zdrResponse?.ok
    ? await zdrResponse.json<{ data?: Array<Record<string, unknown>> }>().catch(() => ({}))
    : {};
  const rows = await env.DB.prepare(`SELECT snapshot_id,snapshot_json FROM ai_endpoint_snapshots WHERE policy_state='VALID'`).all<SnapshotRow>();
  for (const row of rows.results || []) {
    let snapshot: ApprovedEndpointSnapshot;
    try { snapshot = JSON.parse(row.snapshot_json); } catch { await env.DB.prepare(`UPDATE ai_endpoint_snapshots SET policy_state='INVALID' WHERE snapshot_id=?`).bind(row.snapshot_id).run(); continue; }
    const [author, ...slugParts] = snapshot.requestedModel.split('/');
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/models/${author}/${slugParts.join('/')}/endpoints`, { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
      if (!response.ok) continue;
      const payload = await response.json() as { data?: { endpoints?: Array<Record<string, unknown>> } };
      const endpoint = payload.data?.endpoints?.find((candidate) => String(candidate.model_id || '') === snapshot.requestedModel
        && String(candidate.tag || candidate.provider_slug || '') === snapshot.providerEndpointSlug);
      if (!endpoint) { await env.DB.prepare(`UPDATE ai_endpoint_snapshots SET policy_state='INVALID' WHERE snapshot_id=?`).bind(row.snapshot_id).run(); continue; }
      const pricing = (endpoint.pricing || {}) as Record<string, string | null>;
      const allowedPricing = new Set(['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write', 'discount']);
      const pricingValid = Object.entries(pricing).every(([key, value]) => allowedPricing.has(key) && value !== null && Number(value) === 0)
        && ['prompt', 'completion'].every((key) => key in pricing);
      const dataPolicy = endpoint.data_policy && typeof endpoint.data_policy === 'object'
        ? endpoint.data_policy as Record<string, unknown>
        : null;
      const endpointTraining = typeof dataPolicy?.training === 'boolean'
        ? dataPolicy.training
        : typeof dataPolicy?.train === 'boolean'
          ? dataPolicy.train
          : typeof dataPolicy?.data_collection === 'string'
            ? dataPolicy.data_collection.toLowerCase() !== 'deny'
            : null;
      const reviewedPolicy = reviewedNoTrainingEndpoint(snapshot.requestedModel, String(endpoint.provider_name || endpoint.provider || ''), String(endpoint.tag || endpoint.provider_slug || ''));
      // The endpoint API currently omits data_policy for some endpoints. Do
      // not turn that omission into approval; only an exact tuple in the
      // separately reviewed provider-directory allowlist can fill the gap.
      const trainingAllowed = endpointTraining ?? (reviewedPolicy ? false : null);
      const zdrVerified = snapshot.retention.type !== 'zdr'
        || Boolean(zdrPayload.data?.some((candidate) => candidate.model_id === snapshot.requestedModel && candidate.tag === snapshot.providerEndpointSlug));
      const decision = endpointRefreshDecision(snapshot, trainingAllowed, pricingValid, zdrVerified);
      if (decision === 'INVALIDATE') { await env.DB.prepare(`UPDATE ai_endpoint_snapshots SET policy_state='INVALID' WHERE snapshot_id=?`).bind(row.snapshot_id).run(); continue; }
      if (decision === 'SKIP') continue;
      const verifiedAt = Date.now();
      snapshot = { ...snapshot, pricing, verifiedAt: new Date(verifiedAt).toISOString(), expiresAt: new Date(verifiedAt + SNAPSHOT_TTL_MS).toISOString() };
      await env.DB.prepare(`UPDATE ai_endpoint_snapshots SET snapshot_json=?,verified_at=?,expires_at=? WHERE snapshot_id=? AND policy_state='VALID'`).bind(JSON.stringify(snapshot), verifiedAt, verifiedAt + SNAPSHOT_TTL_MS, row.snapshot_id).run();
    } catch { /* A transient metadata outage does not overwrite the last accepted snapshot. */ }
  }
}
