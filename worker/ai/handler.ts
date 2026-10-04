import { z } from 'zod';
import { getViewer, getViewerOrAnonymous } from '../auth';
import { createQueryContext, isProductionFixturePost, json, visibilityPredicate } from '../lib';
import type { Env } from '../types';
import { CURRENT_AI_POLICY_VERSION, AI_LIMITS, LEGACY_MODEL_CHAINS, MODEL_CHAINS, resolveMediaUsage, type ModelKey } from './config';
import { buildContextManifest, buildProfileContextManifest, consentFor, revalidateManifest, scopeManifestForRequest, selectMedia, serializeContext } from './context';
import { controlFetch } from './control-plane';
import { readPublicCache, savePublicCache } from './cache';
import { hmacSha256, semanticFingerprint, sha256 } from './fingerprint';
import { releaseGeneration, reserveGeneration, commitGeneration, userBurnAvailable } from './quota';
import { scanTextRisk } from './risk';
import type { AskAiResponse, GenerationRequest, GenerationResult } from './types';
import { updateAuthorAiPreferences, updatePostAiConsent } from '../repositories/content';
import { interactionRateLimitKeys, persistentInteractionRateLimit } from './rate-limit';
export { interactionRateLimitKeys } from './rate-limit';

const askAiBodySchema = z.object({ question: z.string(), mediaMode: z.enum(['auto', 'include', 'exclude']).default('auto') }).strict();
const profileAskAiBodySchema = z.object({
  question: z.string(),
  mediaMode: z.enum(['auto', 'include', 'exclude']).optional(),
  contextPostIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)).max(12).optional(),
}).strict();
const preferencesSchema = z.object({ textAnalysis: z.enum(['DISABLED', 'PUBLIC_ONLY', 'AUTHORIZED_CONTEXT']), mediaAnalysis: z.enum(['DISABLED', 'PUBLIC_ONLY', 'AUTHORIZED_CONTEXT']), acceptCurrentPolicy: z.literal(true) }).strict();
const postAiConsentSchema = z.object({ enabled: z.boolean(), acceptCurrentPolicy: z.literal(true) }).strict();

const apiError = (code: string, status: number, requestId?: string, retryAfterSeconds?: number) => {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (retryAfterSeconds && Number.isFinite(retryAfterSeconds)) headers.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  return json({ error: code, code, requestId }, { status, headers });
};

type CoordinatorPayload = Partial<GenerationResult> & { error?: unknown; code?: unknown; retryAfter?: unknown; requestId?: unknown };

function safeCoordinatorCode(payload: CoordinatorPayload | null, status: number): string {
  const raw = typeof payload?.code === 'string' ? payload.code : typeof payload?.error === 'string' ? payload.error : '';
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(raw) ? raw : status === 429 ? 'OPENROUTER_RATE_LIMIT' : 'AI_COORDINATOR_UNAVAILABLE';
}

function coordinatorFailure(input: {
  route: 'post' | 'profile';
  requestId: string;
  response?: Response;
  payload?: CoordinatorPayload | null;
  cause?: unknown;
  explicitCode?: string;
}): Response {
  const status = input.response
    ? Math.min(599, Math.max(400, input.response.status))
    : input.cause instanceof DOMException && input.cause.name === 'TimeoutError' ? 504 : 503;
  const code = input.explicitCode || (!input.response && input.cause instanceof DOMException && input.cause.name === 'TimeoutError'
    ? 'AI_COORDINATOR_TIMEOUT'
    : safeCoordinatorCode(input.payload || null, status));
  const retryAfter = typeof input.payload?.retryAfter === 'number' && Number.isFinite(input.payload.retryAfter)
    ? input.payload.retryAfter
    : undefined;
  console.error(JSON.stringify({
    event: 'ai_generation_request_failed',
    route: input.route,
    requestId: input.requestId,
    status,
    code,
    downstreamRequestId: typeof input.payload?.requestId === 'string' ? input.payload.requestId : undefined,
    error: input.cause instanceof Error ? input.cause.name : undefined,
  }));
  return apiError(code, status, input.requestId, retryAfter);
}

function validGenerationPayload(payload: CoordinatorPayload | null): payload is GenerationResult {
  return Boolean(payload && typeof payload.generationId === 'string' && typeof payload.generationPolicyVersion === 'string'
    && payload.response && typeof payload.response === 'object' && typeof payload.response.answer === 'string');
}

async function readCoordinatorPayload(response: Response): Promise<CoordinatorPayload | null> {
  try { return await response.json<CoordinatorPayload>(); } catch { return null; }
}

let alertFallbackLogged = false;

const SNAPSHOT_KEYS: Record<'text' | 'vision', readonly ModelKey[]> = {
  text: [...MODEL_CHAINS.text, ...LEGACY_MODEL_CHAINS.text],
  vision: [...MODEL_CHAINS.vision, ...LEGACY_MODEL_CHAINS.vision],
};

/**
 * Flags describe an intended capability, but an expired or missing endpoint
 * snapshot must never be reported as ready. Keeping this check in the Worker
 * also prevents reserving a user generation when policy validation cannot
 * possibly succeed.
 */
async function hasCurrentSnapshot(db: D1Database | undefined, route: 'text' | 'vision'): Promise<boolean> {
  if (!db) return false;
  const keys = [...new Set(SNAPSHOT_KEYS[route])];
  const placeholders = keys.map(() => '?').join(',');
  try {
    const row = await db.prepare(`SELECT 1 AS ready FROM ai_endpoint_snapshots
      WHERE policy_state='VALID' AND expires_at>? AND model_key IN (${placeholders}) LIMIT 1`)
      .bind(Date.now(), ...keys).first<{ ready: number }>();
    return row?.ready === 1;
  } catch (cause) {
    console.error(JSON.stringify({
      event: 'ai_snapshot_check_failed',
      route,
      error: cause instanceof Error ? cause.message.slice(0, 160) : 'unknown',
    }));
    return false;
  }
}

// Rate-limit diagnostics contain no account, address, token, or request text.
// They make a production 429 observable without creating a privacy log.
function logAiRateLimit(route: 'post' | 'profile', success: boolean): void {
  console.log(JSON.stringify({ event: 'ai_rate_limit_checked', route, success }));
}

async function interactionAllowed(env: Env, route: 'post' | 'profile', viewerId: string, rateLimitKey: string, anonymous: boolean): Promise<boolean> {
  const keys = interactionRateLimitKeys(anonymous, viewerId, rateLimitKey);
  const secret = env.AI_ROLLOUT_HASH_SECRET || env.AI_CONSENT_FINGERPRINT_SECRET || 'connect-anonymous-rate-v1';
  for (const key of keys) {
    if (env.AI_INTERACTION_LIMITER) {
      try {
        const outcome = await env.AI_INTERACTION_LIMITER.limit({ key });
        logAiRateLimit(route, outcome.success);
        if (!outcome.success) return false;
      } catch {
        // The D1 counter below is the durable fallback when the edge binding
        // is unavailable or transiently fails. Never log the binding error,
        // key, address, or identity.
        console.log(JSON.stringify({ event: 'ai_rate_limit_binding_unavailable', route }));
      }
    }
    try {
      const persistent = await persistentInteractionRateLimit(env.DB as D1Database, secret, key);
      logAiRateLimit(route, persistent);
      if (!persistent) return false;
    } catch {
      // Rate limiting is fail-closed if the durable fallback itself is
      // unavailable; this prevents an outage from silently disabling abuse
      // controls or triggering an unbounded retry loop.
      console.log(JSON.stringify({ event: 'ai_rate_limit_persistence_unavailable', route }));
      return false;
    }
  }
  return true;
}

function validOrigin(request: Request, env: Env): boolean {
  const raw = request.headers.get('origin');
  if (!raw || raw === 'null') return false;
  try {
    const origin = new URL(raw).origin;
    const allowed = (env.CONNECT_ALLOWED_ORIGINS || new URL(request.url).origin).split(',').map((value) => new URL(value.trim()).origin);
    return allowed.includes(origin);
  } catch { return false; }
}

async function boundedJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > AI_LIMITS.bodyBytes) throw new Error('REQUEST_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_QUESTION');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > AI_LIMITS.bodyBytes) { await reader.cancel(); throw new Error('REQUEST_TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('INVALID_JSON'); }
}

function canonicalQuestion(raw: string): string {
  const value = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const points = [...value].length;
  const bytes = new TextEncoder().encode(value).byteLength;
  if (!points || points > AI_LIMITS.questionCodePoints || bytes > AI_LIMITS.questionBytes) throw new Error('INVALID_QUESTION');
  return value;
}

async function feedbackToken(env: Env, viewerId: string, generationId: string, requestId: string): Promise<string | undefined> {
  if (!env.AI_FEEDBACK_SIGNING_SECRET) return undefined;
  const payload = btoa(JSON.stringify({ viewerId, generationId, requestId, exp: Date.now() + 7 * 86_400_000 })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${payload}.${await hmacSha256(env.AI_FEEDBACK_SIGNING_SECRET, payload)}`;
}

async function rolloutAllowed(env: Env, viewerId: string): Promise<boolean> {
  const percent = Math.min(100, Math.max(0, Number(env.AI_ROLLOUT_PERCENT || 0)));
  if (percent >= 100) return true;
  if (percent <= 0 || !env.AI_ROLLOUT_HASH_SECRET) return false;
  const digest = await hmacSha256(env.AI_ROLLOUT_HASH_SECRET, viewerId);
  return Number.parseInt(digest.slice(0, 8), 16) % 100 < percent;
}

function coreAiConfigurationReady(env: Env): boolean {
  return Boolean(
    env.OPENROUTER_API_KEY
    && env.AI_CONSENT_FINGERPRINT_SECRET
    && env.AI_COORDINATOR_KEY_SECRET
    && env.AI_FEEDBACK_SIGNING_SECRET
    && env.AI_ROLLOUT_HASH_SECRET
    && env.LOG_PSEUDONYM_MASTER_SECRET
  );
}

function alertConfigurationReady(env: Env): boolean {
  // Alert delivery is optional for generation. If an alert webhook is
  // configured, its signing secret is still mandatory so delivery cannot be
  // spoofed; with no webhook we use the safe log-only fallback.
  return !env.AI_ALERT_WEBHOOK_URL || Boolean(env.AI_ALERT_SIGNING_SECRET);
}

function adminTestConfigurationReady(env: Env): boolean {
  return coreAiConfigurationReady(env) && alertConfigurationReady(env);
}

async function publicRolloutConfigurationReady(env: Env): Promise<boolean> {
  if (!adminTestConfigurationReady(env)) return false;
  const response = await controlFetch(env, '/runtime');
  if (!response.ok) return false;
  const runtime: { enabled?: boolean; hardStopReason?: string | null; alertVerifiedAt?: number } = await response.json<{ enabled?: boolean; hardStopReason?: string | null; alertVerifiedAt?: number }>().catch(() => ({}));
  if (runtime.enabled !== true || runtime.hardStopReason) return false;
  // Alert delivery is an operational enhancement, not a prerequisite for a
  // public generation. When it is absent, retain a safe log-only fallback;
  // never include the URL, signing material, prompt, or response in that log.
  if (!env.AI_ALERT_WEBHOOK_URL && !alertFallbackLogged) {
    alertFallbackLogged = true;
    console.log(JSON.stringify({ event: 'ai_alert_webhook_unconfigured', mode: 'log_only' }));
  }
  if (env.AI_ALERT_WEBHOOK_URL && !runtime.alertVerifiedAt && !alertFallbackLogged) {
    alertFallbackLogged = true;
    console.log(JSON.stringify({ event: 'ai_alert_webhook_unverified', mode: 'log_only' }));
  }
  return true;
}

function adminAllowed(env: Env, viewerId: string): boolean {
  return (env.AI_ADMIN_USER_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(viewerId);
}

async function accessDecision(env: Env, viewerId: string | null): Promise<{ visible: boolean; generationEnabled: boolean; adminOnly: boolean; isAdmin: boolean }> {
  const uiEnabled = env.AI_UI_ENABLED === 'true';
  const adminOnly = env.AI_ADMIN_ONLY !== 'false';
  const isAdmin = Boolean(viewerId && adminAllowed(env, viewerId));
  const rollout = Boolean(viewerId && await rolloutAllowed(env, viewerId));
  const readiness = isAdmin
    ? adminTestConfigurationReady(env)
    : await publicRolloutConfigurationReady(env);
  const generationConfigured = env.AI_GENERATION_ENABLED === 'true' && readiness;
  return {
    visible: uiEnabled && (adminOnly ? isAdmin : Boolean(viewerId)),
    generationEnabled: generationConfigured && (isAdmin || (!adminOnly && rollout)),
    adminOnly,
    isAdmin,
  };
}

export async function aiStatus(request: Request, env: Env): Promise<Response> {
  const identity = await getViewerOrAnonymous(env, request);
  const { viewer } = identity;
  const decision = await accessDecision(env, viewer.id);
  const [textSnapshotReady, visionSnapshotReady] = await Promise.all([
    hasCurrentSnapshot(env.DB, 'text'),
    hasCurrentSnapshot(env.DB, 'vision'),
  ]);
  const configurationReady = decision.isAdmin ? adminTestConfigurationReady(env) : await publicRolloutConfigurationReady(env);
  return json({
    uiEnabled: env.AI_UI_ENABLED === 'true',
    visible: decision.visible,
    generationEnabled: decision.generationEnabled && textSnapshotReady,
    adminOnly: decision.adminOnly,
    authenticated: !identity.anonymous,
    configurationReady,
    adminTestConfigurationReady: adminTestConfigurationReady(env),
    publicRolloutConfigurationReady: await publicRolloutConfigurationReady(env),
    isAdmin: decision.isAdmin,
    textReady: env.AI_TEXT_READY === 'true' && configurationReady && textSnapshotReady,
    visionReady: env.AI_VISION_READY === 'true' && configurationReady && visionSnapshotReady,
    textSnapshotReady,
    visionSnapshotReady,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function runtimeAllowsCached(env: Env, generationPolicyVersion: string): Promise<boolean> {
  const response = await controlFetch(env, '/runtime');
  if (!response.ok) return false;
  const state = await response.json<{ enabled: boolean; hardStopReason?: string | null }>();
  if (state.enabled && !state.hardStopReason) return true;
  if (state.hardStopReason === 'UPSTREAM_OUTAGE') return true;
  if (state.hardStopReason === 'PROVIDER_PRIVACY_INVARIANT' && env.DB) {
    const invalid = await env.DB.prepare('SELECT 1 FROM ai_invalid_generation_policies WHERE generation_policy_version=?').bind(generationPolicyVersion).first();
    return !invalid;
  }
  return false;
}

function immediateInsufficient(manifest: NonNullable<Awaited<ReturnType<typeof buildContextManifest>>>, requestId: string, reason: AskAiResponse['insufficientReason']): Response {
  return json({
    answer: '', insufficientContext: true, insufficientReason: reason, citations: [],
    coverage: { modalityRequested: 'vision', modalityUsed: 'text', imagesTotal: manifest.media.length, imagesAnalyzed: 0, animatedImagesTruncated: 0, videosTotal: manifest.media.filter((item) => item.mimeType.startsWith('video/')).length, videosAnalyzed: 0, unsupportedImages: 0, contextTruncated: manifest.contextTruncated, answerTruncated: false },
    degraded: false, requestId,
  } satisfies AskAiResponse, { headers: { 'Cache-Control': 'private, no-store' } });
}

type PostAccessDiagnostic = {
  visibility: string | null;
  ownerMatch: boolean | null;
  normalViewAllowed: boolean | null;
  aiAllowed: boolean;
  imageConsentAllowed: boolean | null;
  denyReason: string;
};
type EnsurePostResult = { synced: boolean; sourceUnavailable?: boolean; diagnostic?: PostAccessDiagnostic };

type PostAccessRow = {
  author_id: string;
  visibility: string;
  deleted_at: number | null;
  body: string;
  text_analysis: string | null;
  media_analysis: string | null;
  post_text_analysis: string | null;
  post_media_analysis: string | null;
};

async function logPostAccessDiagnostic(env: Env, viewerId: string, postId: string, correlationId: string, anonymous: boolean, syncAttempted: boolean, fallback?: PostAccessDiagnostic): Promise<boolean> {
  let knownPost: PostAccessRow | null = null;
  let normalViewAllowed = false;
  try {
    knownPost = await env.DB!.prepare(`SELECT p.author_id,p.visibility,p.deleted_at,p.body,
        pref.text_analysis,pref.media_analysis,
        consent.text_analysis AS post_text_analysis,consent.media_analysis AS post_media_analysis
      FROM posts p LEFT JOIN ai_author_preferences pref ON pref.user_id=p.author_id
        LEFT JOIN post_ai_consents consent ON consent.post_id=p.id AND consent.author_id=p.author_id
      WHERE p.id=? LIMIT 1`).bind(postId).first<PostAccessRow>();
    if (knownPost) {
      const view = visibilityPredicate(viewerId, 'p');
      normalViewAllowed = Boolean(await env.DB!.prepare(`SELECT 1 AS allowed FROM posts p WHERE p.id=? AND ${view.sql} LIMIT 1`)
        .bind(postId, ...view.bindings).first<{ allowed: number }>());
    }
  } catch (cause) {
    console.error(JSON.stringify({ event: 'ai_post_access_diagnostic_failed', correlationId, phase: 'acl_lookup', error: cause instanceof Error ? cause.name : 'unknown' }));
  }

  const preferences = knownPost ? {
    acceptedPolicyVersion: null,
    preferenceVersion: 1,
    textAnalysis: (knownPost.text_analysis || 'PUBLIC_ONLY') as 'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT',
    mediaAnalysis: (knownPost.media_analysis || 'PUBLIC_ONLY') as 'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT',
  } : null;
  const consent = knownPost && preferences ? consentFor(preferences, knownPost.visibility, {
    textAnalysis: knownPost.post_text_analysis,
    mediaAnalysis: knownPost.post_media_analysis,
  }) : null;
  const ownerMatch = Boolean(knownPost && knownPost.author_id === viewerId);
  const fixtureExcluded = Boolean(knownPost && env.AI_ENVIRONMENT === 'production' && isProductionFixturePost(postId, knownPost.body));
  const aiAllowed = Boolean(normalViewAllowed && !fixtureExcluded && consent && (consent.allowText || consent.allowMedia));
  const imageConsentAllowed = knownPost ? Boolean(normalViewAllowed && consent?.allowMedia) : fallback?.imageConsentAllowed ?? null;
  const denyReason = !knownPost
    ? syncAttempted ? 'SOURCE_NOT_SYNCED_OR_FIXTURE_EXCLUDED' : 'POST_NOT_FOUND'
    : knownPost.deleted_at !== null ? 'POST_DELETED'
      : !normalViewAllowed ? 'VIEW_ACL_DENIED'
        : fixtureExcluded ? 'PRODUCTION_FIXTURE_EXCLUDED'
          : !consent?.allowText && !consent?.allowMedia ? 'AUTHOR_AI_CONSENT_DISABLED'
            : 'CONTEXT_NOT_ELIGIBLE';
  let viewerHash: string | null = null;
  const pseudonymSecret = env.LOG_PSEUDONYM_MASTER_SECRET || env.AI_CONSENT_FINGERPRINT_SECRET;
  if (pseudonymSecret) {
    try { viewerHash = await hmacSha256(pseudonymSecret, viewerId); }
    catch { /* no raw viewer identifier is ever used as a fallback */ }
  }
  const diagnostic = {
    event: 'ai_post_access_diagnostic',
    correlationId,
    viewerHash,
    postId,
    visibility: knownPost?.visibility || fallback?.visibility || null,
    ownerMatch: knownPost ? ownerMatch : fallback?.ownerMatch ?? null,
    normalViewAllowed: knownPost ? normalViewAllowed : fallback?.normalViewAllowed ?? null,
    aiAllowed: knownPost ? aiAllowed : fallback?.aiAllowed ?? false,
    imageConsentAllowed,
    denyReason: knownPost ? denyReason : fallback?.denyReason || (syncAttempted ? 'SOURCE_NOT_SYNCED_OR_FIXTURE_EXCLUDED' : 'POST_NOT_FOUND'),
    bodyLogged: false,
    piiLogged: false,
  };
  console.warn(JSON.stringify(diagnostic));
  return Boolean(knownPost && normalViewAllowed && !fixtureExcluded && !anonymous);
}

export async function askAi(request: Request, env: Env, postId: string, replanCount = 0, ensurePost?: (correlationId: string) => Promise<EnsurePostResult>): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (request.method === 'OPTIONS') return validOrigin(request, env) ? new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': request.headers.get('origin') || '', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key' } }) : apiError('ORIGIN_NOT_ALLOWED', 403, requestId);
  if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405, requestId);
  if (!env.DB) return apiError('AI_DATABASE_UNAVAILABLE', 503, requestId);
  if (env.AI_GENERATION_ENABLED !== 'true') return apiError('AI_PREPARING', 503, requestId);
  if (!adminTestConfigurationReady(env)) return apiError('AI_PREPARING', 503, requestId);
  if (env.AI_TEXT_READY !== 'true') return apiError('AI_PREPARING', 503, requestId);
  const mime = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mime !== 'application/json') return apiError('UNSUPPORTED_MEDIA_TYPE', 415, requestId);
  if (!validOrigin(request, env)) return apiError('ORIGIN_NOT_ALLOWED', 403, requestId);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return apiError('POST_NOT_FOUND_OR_INACCESSIBLE', 404, requestId);
  const idempotency = request.headers.get('idempotency-key');
  if (idempotency && !/^[\x21-\x7E]{16,128}$/.test(idempotency)) return apiError('INVALID_IDEMPOTENCY_KEY', 422, requestId);
  const { viewer, rateLimitKey, anonymous } = await getViewerOrAnonymous(env, request);
  const access = await accessDecision(env, viewer.id);
  if (!access.generationEnabled) {
    if (!access.adminOnly && !access.isAdmin) return apiError('AI_PUBLIC_ROLLOUT_NOT_READY', 503, requestId);
    return apiError(access.adminOnly && !access.isAdmin ? 'AI_NOT_IN_ROLLOUT' : 'AI_PREPARING', access.adminOnly && !access.isAdmin ? 404 : 503, requestId);
  }
  if (!await interactionAllowed(env, 'post', viewer.id, rateLimitKey, anonymous)) return apiError('USER_RATE_LIMIT', 429, requestId);
  let parsed: z.infer<typeof askAiBodySchema>;
  try { parsed = askAiBodySchema.parse(await boundedJson(request)); }
  catch (cause) { const code = cause instanceof Error && cause.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_QUESTION'; return apiError(code, code === 'REQUEST_TOO_LARGE' ? 413 : 422, requestId); }
  let question: string;
  try { question = canonicalQuestion(parsed.question); } catch { return apiError('INVALID_QUESTION', 422, requestId); }

  const excludeProductionFixtures = env.AI_ENVIRONMENT === 'production';
  let candidateManifest;
  let syncDiagnostic: PostAccessDiagnostic | undefined;
  try {
    // Revalidate the canonical Firestore document even when D1 already has a
    // row. Firestore remains the source of visibility/deletion changes for
    // legacy feed posts; stale public D1 snapshots must never reach a model.
    if (ensurePost) {
      const ensured = await ensurePost(requestId);
      syncDiagnostic = ensured.diagnostic;
      if (ensured.sourceUnavailable) return apiError('AI_SOURCE_UNAVAILABLE', 503, requestId);
      if (ensured.synced) candidateManifest = await buildContextManifest(env.DB, viewer.id, postId, env.AI_CONSENT_FINGERPRINT_SECRET!, excludeProductionFixtures);
    } else {
      candidateManifest = await buildContextManifest(env.DB, viewer.id, postId, env.AI_CONSENT_FINGERPRINT_SECRET!, excludeProductionFixtures);
    }
  } catch (cause) {
    console.error(JSON.stringify({ event: 'ai_context_build_failed', route: 'post', requestId, error: cause instanceof Error ? cause.message.slice(0, 160) : 'unknown' }));
    return apiError('AI_DATABASE_UNAVAILABLE', 503, requestId);
  }
  if (!candidateManifest) {
    // Keep the response privacy-safe while logging enough access state to
    // distinguish a real ACL denial from a stale/missing/filtered source.
    const viewAllowed = await logPostAccessDiagnostic(env, viewer.id, postId, requestId, anonymous, Boolean(ensurePost), syncDiagnostic);
    const deniedStatus = viewAllowed ? 403 : 404;
    return apiError('POST_NOT_FOUND_OR_INACCESSIBLE', deniedStatus, requestId);
  }
  const resolved = resolveMediaUsage(question, parsed.mediaMode);
  const current = candidateManifest.sources.find((source) => source.relation === 'current');
  if (!current) return apiError('POST_NOT_FOUND_OR_INACCESSIBLE', 404, requestId);
  // Vision readiness is a production capability flag. Test-only/admin smoke
  // bypasses are intentionally not part of the request path.
  const visionAvailable = env.AI_VISION_READY === 'true';
  if (!current.allowText && !current.allowMedia) return apiError('AI_DISABLED_BY_AUTHOR', 403, requestId);
  if (resolved.mode === 'TEXT_ONLY' && !current.allowText) return apiError('AI_DISABLED_BY_AUTHOR', 403, requestId);
  let mode = resolved.mode;
  if (mode === 'VISION_REQUIRED' && !current.allowMedia) return immediateInsufficient(candidateManifest, requestId, 'MEDIA_ANALYSIS_NOT_ALLOWED');
  if (mode === 'VISION_REQUIRED' && !visionAvailable) return immediateInsufficient(candidateManifest, requestId, 'MEDIA_NOT_AVAILABLE');
  if (mode === 'VISION_OPTIONAL' && !visionAvailable) mode = 'TEXT_ONLY';
  if (mode === 'VISION_OPTIONAL' && !current.allowMedia && current.allowText) mode = 'TEXT_ONLY';
  if (!await hasCurrentSnapshot(env.DB, mode === 'VISION_REQUIRED' ? 'vision' : 'text')) {
    return apiError('AI_POLICY_OR_CAPABILITY_UNAVAILABLE', 503, requestId);
  }
  const selectedMedia = selectMedia(candidateManifest, mode, resolved.target);
  if (mode === 'VISION_REQUIRED' && !selectedMedia.length) return immediateInsufficient(candidateManifest, requestId, current.allowMedia ? 'MEDIA_NOT_AVAILABLE' : 'MEDIA_ANALYSIS_NOT_ALLOWED');
  const manifest = scopeManifestForRequest(candidateManifest, mode, selectedMedia);
  const serializedContext = serializeContext(manifest);
  const risk = scanTextRisk(`${question}\n${serializedContext}`);
  console.log(JSON.stringify({ event: 'ai_context_risk_classified', route: 'post', requestId, risk: risk.risk, findingCount: risk.findings.length, bodyLogged: false, piiLogged: false }));
  if (risk.risk === 'SCAN_FAILED') { await controlFetch(env, '/scan-failure'); return apiError('AI_RISK_SCAN_UNAVAILABLE', 503, requestId); }
  if (risk.risk === 'BLOCKED') return apiError('SENSITIVE_DATA_BLOCKED', 422, requestId);
  const fingerprint = await semanticFingerprint({ question, manifest, mode, target: resolved.target, selectedMedia, risk: risk.risk, locale: 'ja-JP' });
  if (idempotency) {
    const bindingHash = await sha256(`${viewer.id}:${postId}:${fingerprint}`);
    const existing = await env.DB.prepare('SELECT binding_hash FROM ai_idempotency WHERE viewer_id=? AND idempotency_key=? AND expires_at>?').bind(viewer.id, idempotency, Date.now()).first<{ binding_hash: string }>();
    if (existing && existing.binding_hash !== bindingHash) return apiError('IDEMPOTENCY_CONFLICT', 409, requestId);
    await env.DB.prepare(`INSERT OR IGNORE INTO ai_idempotency(viewer_id,idempotency_key,binding_hash,created_at,expires_at) VALUES(?,?,?,?,?)`).bind(viewer.id, idempotency, bindingHash, Date.now(), Date.now() + 300_000).run();
  }
  const cacheKey = await sha256(`PUBLIC:${fingerprint}`);
  if (manifest.privacyClass === 'PUBLIC_AI' && risk.risk === 'CLEAR') {
    const cached = await readPublicCache(env.DB, cacheKey);
    if (cached && await runtimeAllowsCached(env, cached.generationPolicyVersion) && await revalidateManifest(env.DB, viewer.id, cached.manifest, cached.response.coverage.modalityRequested === 'text', excludeProductionFixtures)) {
      return json({ ...cached.response, requestId, feedbackToken: await feedbackToken(env, viewer.id, cached.generationId, requestId) } satisfies AskAiResponse, { headers: { 'Cache-Control': 'private, no-store' } });
    }
  }
  if (!await userBurnAvailable(env.DB, viewer.id)) return apiError('USER_UPSTREAM_BURN_LIMIT', 429, requestId);
  const generationReservationId = await reserveGeneration(env.DB, viewer.id);
  if (!generationReservationId) return apiError('USER_GENERATION_LIMIT', 429, requestId);
  if (!env.AI_COORDINATOR || !env.AI_COORDINATOR_KEY_SECRET) { await releaseGeneration(env.DB, generationReservationId); return apiError('AI_COORDINATOR_UNAVAILABLE', 503, requestId); }
  const scope = manifest.privacyClass === 'PUBLIC_AI' ? fingerprint : `${viewer.id}:${fingerprint}`;
  const coordinatorKey = await hmacSha256(env.AI_COORDINATOR_KEY_SECRET, scope);
  const generationRequest: GenerationRequest = {
    viewerId: viewer.id, deliveryRequestId: requestId, generationReservationId, question, locale: 'ja-JP', semanticFingerprint: fingerprint,
    manifest, mediaUsageMode: mode, mediaTarget: resolved.target, inputRisk: risk.risk, selectedMedia, deadlineAt: Date.now() + AI_LIMITS.globalDeadlineMs,
  };
  let committed = false;
  try {
    const coordinator = env.AI_COORDINATOR.getByName(coordinatorKey);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(AI_LIMITS.globalDeadlineMs + 2_000)]);
    const upstream = await coordinator.fetch('https://coordinator.internal/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(generationRequest), signal });
    const payload = await readCoordinatorPayload(upstream);
    if (!upstream.ok) {
      await releaseGeneration(env.DB, generationReservationId);
      const changed = payload?.error === 'CONTEXT_CHANGED_BEFORE_DISPATCH' && replanCount < 1;
      if (changed) {
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        headers.delete('idempotency-key');
        return askAi(new Request(request.url, { method: 'POST', headers, body: JSON.stringify(parsed), signal: request.signal }), env, postId, replanCount + 1, ensurePost);
      }
      return coordinatorFailure({ route: 'post', requestId, response: upstream, payload });
    }
    if (!validGenerationPayload(payload)) {
      await releaseGeneration(env.DB, generationReservationId);
      return coordinatorFailure({ route: 'post', requestId, response: upstream, payload, cause: new Error('invalid_coordinator_payload'), explicitCode: 'AI_COORDINATOR_INVALID_RESPONSE' });
    }
    await commitGeneration(env.DB, generationReservationId);
    committed = true;
    if (payload.cacheable) {
      try {
        await savePublicCache(env.DB, { cacheKey, semanticFingerprint: fingerprint, generationId: payload.generationId, generationPolicyVersion: payload.generationPolicyVersion, response: payload.response, manifest });
      } catch (cause) {
        console.error(JSON.stringify({ event: 'ai_cache_write_failed', route: 'post', requestId, error: cause instanceof Error ? cause.name : 'unknown' }));
      }
    }
    return json({ ...payload.response, requestId, feedbackToken: await feedbackToken(env, viewer.id, payload.generationId, requestId) } satisfies AskAiResponse, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (cause) {
    if (!committed) await releaseGeneration(env.DB, generationReservationId).catch(() => undefined);
    return coordinatorFailure({ route: 'post', requestId, cause });
  }
}

/**
 * Ask AI about one public profile. The profile manifest is deliberately
 * separate from post context: it contains only the public profile record and
 * public posts/replies/quotes authored by that account, filtered by each
 * author's current AI text-consent setting. Generation permission still comes
 * exclusively from the Worker access decision above.
 */
type EnsureProfileContext = (input: {
  viewerId: string;
  profileId: string;
  contextPostIds: string[];
  requestId: string;
}) => Promise<{
  profileSynced: boolean;
  profileVerified: boolean;
  profileDenied: boolean;
  sourceUnavailable: boolean;
  requestedPostCount: number;
  attemptedPostCount: number;
  syncedPostCount: number;
  skippedPostCount: number;
  verifiedPostIds: string[];
}>;

export async function profileAskAi(request: Request, env: Env, profileId: string, replanCount = 0, ensureProfileContext?: EnsureProfileContext): Promise<Response> {
  const requestId = crypto.randomUUID();
  if (request.method === 'OPTIONS') return validOrigin(request, env) ? new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': request.headers.get('origin') || '', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key' } }) : apiError('ORIGIN_NOT_ALLOWED', 403, requestId);
  if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405, requestId);
  if (!env.DB) return apiError('AI_DATABASE_UNAVAILABLE', 503, requestId);
  if (env.AI_GENERATION_ENABLED !== 'true' || !adminTestConfigurationReady(env) || env.AI_TEXT_READY !== 'true') return apiError('AI_PREPARING', 503, requestId);
  const mime = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mime !== 'application/json') return apiError('UNSUPPORTED_MEDIA_TYPE', 415, requestId);
  if (!validOrigin(request, env)) return apiError('ORIGIN_NOT_ALLOWED', 403, requestId);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(profileId)) return apiError('PROFILE_NOT_FOUND_OR_INACCESSIBLE', 404, requestId);
  const idempotency = request.headers.get('idempotency-key');
  if (idempotency && !/^[\x21-\x7E]{16,128}$/.test(idempotency)) return apiError('INVALID_IDEMPOTENCY_KEY', 422, requestId);
  const { viewer, rateLimitKey, anonymous } = await getViewerOrAnonymous(env, request);
  const access = await accessDecision(env, viewer.id);
  if (!access.generationEnabled) {
    if (!access.adminOnly && !access.isAdmin) return apiError('AI_PUBLIC_ROLLOUT_NOT_READY', 503, requestId);
    return apiError(access.adminOnly && !access.isAdmin ? 'AI_NOT_IN_ROLLOUT' : 'AI_PREPARING', access.adminOnly && !access.isAdmin ? 404 : 503, requestId);
  }
  if (!await interactionAllowed(env, 'profile', viewer.id, rateLimitKey, anonymous)) return apiError('USER_RATE_LIMIT', 429, requestId);
  let parsed: z.infer<typeof profileAskAiBodySchema>;
  try { parsed = profileAskAiBodySchema.parse(await boundedJson(request)); }
  catch (cause) { const code = cause instanceof Error && cause.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_QUESTION'; return apiError(code, code === 'REQUEST_TOO_LARGE' ? 413 : 422, requestId); }
  let question: string;
  try { question = canonicalQuestion(parsed.question); } catch { return apiError('INVALID_QUESTION', 422, requestId); }

  let verifiedPostIds: string[] = [];
  if (ensureProfileContext) {
    const syncStartedAt = Date.now();
    try {
      const sync = await ensureProfileContext({
        viewerId: viewer.id,
        profileId,
        contextPostIds: parsed.contextPostIds || [],
        requestId,
      });
      const { verifiedPostIds: syncedPostIds, ...syncStats } = sync;
      verifiedPostIds = syncedPostIds;
      console.log(JSON.stringify({
        event: 'ai_profile_context_backfill',
        requestId,
        durationMs: Date.now() - syncStartedAt,
        ...syncStats,
        bodyLogged: false,
        piiLogged: false,
      }));
      if (!sync.profileVerified) {
        return sync.sourceUnavailable
          ? apiError('AI_SOURCE_UNAVAILABLE', 503, requestId)
          : apiError('PROFILE_NOT_FOUND_OR_INACCESSIBLE', 404, requestId);
      }
    } catch (cause) {
      console.error(JSON.stringify({
        event: 'ai_profile_context_backfill_failed',
        requestId,
        durationMs: Date.now() - syncStartedAt,
        error: cause instanceof Error ? cause.name : 'unknown',
        bodyLogged: false,
        piiLogged: false,
      }));
      return apiError('AI_SOURCE_UNAVAILABLE', 503, requestId);
    }
  }

  const excludeProductionFixtures = env.AI_ENVIRONMENT === 'production';
  const profileContextStartedAt = Date.now();
  let candidateManifest;
  try {
    candidateManifest = await buildProfileContextManifest(env.DB, viewer.id, profileId, env.AI_CONSENT_FINGERPRINT_SECRET!, excludeProductionFixtures, verifiedPostIds);
  } catch (cause) {
    console.error(JSON.stringify({ event: 'ai_profile_context_timing', requestId, phase: 'acquisition_failed', durationMs: Date.now() - profileContextStartedAt, bodyLogged: false, piiLogged: false }));
    console.error(JSON.stringify({ event: 'ai_context_build_failed', route: 'profile', requestId, error: cause instanceof Error ? cause.message.slice(0, 160) : 'unknown' }));
    return apiError('AI_DATABASE_UNAVAILABLE', 503, requestId);
  }
  if (!candidateManifest) return apiError('PROFILE_NOT_FOUND_OR_INACCESSIBLE', 404, requestId);
  console.log(JSON.stringify({
    event: 'ai_profile_context_timing',
    requestId,
    phase: 'acquired',
    durationMs: Date.now() - profileContextStartedAt,
    sourceCount: candidateManifest.sources.length,
    postCount: candidateManifest.sources.filter((source) => source.type === 'post').length,
    replyCount: candidateManifest.sources.filter((source) => source.type === 'comment').length,
    mediaCount: candidateManifest.media.length,
    contextTruncated: candidateManifest.contextTruncated,
    bodyLogged: false,
    piiLogged: false,
  }));
  const current = candidateManifest.sources.find((source) => source.relation === 'current');
  if (!current || !current.allowText) return apiError('PROFILE_NOT_FOUND_OR_INACCESSIBLE', 404, requestId);
  const resolved = resolveMediaUsage(question, parsed.mediaMode || 'auto');
  const visionAvailable = env.AI_VISION_READY === 'true';
  const allowedMedia = candidateManifest.media.some((item) => item.allowedByConsent);
  let mode = resolved.mode;
  // A generic profile question stays text-only even when recent posts have
  // eligible images. Image analysis is explicit for profiles (include or a
  // visual-intent question), which keeps the common path fast and avoids
  // sending more media than the user asked the model to inspect.
  const profileMediaTarget = mode === 'TEXT_ONLY' ? 'CURRENT_POST' : 'ALL_RELEVANT';
  if (mode === 'VISION_REQUIRED' && !visionAvailable) return immediateInsufficient(candidateManifest, requestId, 'MEDIA_NOT_AVAILABLE');
  const eligibleMedia = selectMedia(candidateManifest, 'VISION_REQUIRED', profileMediaTarget);
  if (mode === 'VISION_REQUIRED' && !eligibleMedia.length) {
    return immediateInsufficient(candidateManifest, requestId, allowedMedia ? 'MEDIA_NOT_AVAILABLE' : 'MEDIA_ANALYSIS_NOT_ALLOWED');
  }
  if (mode === 'VISION_OPTIONAL' && (!visionAvailable || !eligibleMedia.length)) mode = 'TEXT_ONLY';
  if (!await hasCurrentSnapshot(env.DB, mode === 'VISION_REQUIRED' ? 'vision' : 'text')) return apiError('AI_POLICY_OR_CAPABILITY_UNAVAILABLE', 503, requestId);
  // Profiles do not have a single current post. Once visual analysis is
  // enabled, always select from the recent profile context rather than using
  // the post-oriented target returned by resolveMediaUsage().
  const selectedMedia: GenerationRequest['selectedMedia'] = selectMedia(candidateManifest, mode, profileMediaTarget);
  const manifest = scopeManifestForRequest(candidateManifest, mode, selectedMedia);
  const serializeStartedAt = Date.now();
  const serializedContext = serializeContext(manifest);
  console.log(JSON.stringify({
    event: 'ai_profile_context_timing',
    requestId,
    phase: 'serialized',
    durationMs: Date.now() - serializeStartedAt,
    sourceCount: manifest.sources.length,
    postCount: manifest.sources.filter((source) => source.type === 'post').length,
    replyCount: manifest.sources.filter((source) => source.type === 'comment').length,
    mediaCount: manifest.media.length,
    contextChars: serializedContext.length,
    contextTruncated: manifest.contextTruncated,
    bodyLogged: false,
    piiLogged: false,
  }));
  const risk = scanTextRisk(`${question}\n${serializedContext}`);
  console.log(JSON.stringify({ event: 'ai_context_risk_classified', route: 'profile', requestId, risk: risk.risk, findingCount: risk.findings.length, bodyLogged: false, piiLogged: false }));
  if (risk.risk === 'SCAN_FAILED') { await controlFetch(env, '/scan-failure'); return apiError('AI_RISK_SCAN_UNAVAILABLE', 503, requestId); }
  if (risk.risk === 'BLOCKED') return apiError('SENSITIVE_DATA_BLOCKED', 422, requestId);
  const fingerprint = await semanticFingerprint({ question, manifest, mode, target: profileMediaTarget, selectedMedia, risk: risk.risk, locale: 'ja-JP' });
  if (idempotency) {
    const bindingHash = await sha256(`${viewer.id}:profile:${profileId}:${fingerprint}`);
    const existing = await env.DB.prepare('SELECT binding_hash FROM ai_idempotency WHERE viewer_id=? AND idempotency_key=? AND expires_at>?').bind(viewer.id, idempotency, Date.now()).first<{ binding_hash: string }>();
    if (existing && existing.binding_hash !== bindingHash) return apiError('IDEMPOTENCY_CONFLICT', 409, requestId);
    await env.DB.prepare(`INSERT OR IGNORE INTO ai_idempotency(viewer_id,idempotency_key,binding_hash,created_at,expires_at) VALUES(?,?,?,?,?)`).bind(viewer.id, idempotency, bindingHash, Date.now(), Date.now() + 300_000).run();
  }
  const cacheKey = await sha256(`PROFILE:${fingerprint}`);
  if (manifest.privacyClass === 'PUBLIC_AI' && risk.risk === 'CLEAR') {
    const cached = await readPublicCache(env.DB, cacheKey);
    if (cached && await runtimeAllowsCached(env, cached.generationPolicyVersion) && await revalidateManifest(env.DB, viewer.id, cached.manifest, mode === 'TEXT_ONLY', excludeProductionFixtures)) {
      return json({ ...cached.response, requestId, feedbackToken: await feedbackToken(env, viewer.id, cached.generationId, requestId) } satisfies AskAiResponse, { headers: { 'Cache-Control': 'private, no-store' } });
    }
  }
  if (!await userBurnAvailable(env.DB, viewer.id)) return apiError('USER_UPSTREAM_BURN_LIMIT', 429, requestId);
  const generationReservationId = await reserveGeneration(env.DB, viewer.id);
  if (!generationReservationId) return apiError('USER_GENERATION_LIMIT', 429, requestId);
  if (!env.AI_COORDINATOR || !env.AI_COORDINATOR_KEY_SECRET) { await releaseGeneration(env.DB, generationReservationId); return apiError('AI_COORDINATOR_UNAVAILABLE', 503, requestId); }
  const scope = manifest.privacyClass === 'PUBLIC_AI' ? fingerprint : `${viewer.id}:${fingerprint}`;
  const coordinatorKey = await hmacSha256(env.AI_COORDINATOR_KEY_SECRET, scope);
  const generationRequest: GenerationRequest = {
    viewerId: viewer.id, deliveryRequestId: requestId, generationReservationId, question, locale: 'ja-JP', semanticFingerprint: fingerprint,
    manifest, mediaUsageMode: mode, mediaTarget: profileMediaTarget, inputRisk: risk.risk, selectedMedia, deadlineAt: Date.now() + AI_LIMITS.globalDeadlineMs,
  };
  let committed = false;
  try {
    const coordinator = env.AI_COORDINATOR.getByName(coordinatorKey);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(AI_LIMITS.globalDeadlineMs + 2_000)]);
    const upstream = await coordinator.fetch('https://coordinator.internal/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(generationRequest), signal });
    const payload = await readCoordinatorPayload(upstream);
    if (!upstream.ok) {
      await releaseGeneration(env.DB, generationReservationId);
      if (payload?.error === 'CONTEXT_CHANGED_BEFORE_DISPATCH' && replanCount < 1) {
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        headers.delete('idempotency-key');
        return profileAskAi(new Request(request.url, { method: 'POST', headers, body: JSON.stringify(parsed), signal: request.signal }), env, profileId, replanCount + 1, ensureProfileContext);
      }
      return coordinatorFailure({ route: 'profile', requestId, response: upstream, payload });
    }
    if (!validGenerationPayload(payload)) {
      await releaseGeneration(env.DB, generationReservationId);
      return coordinatorFailure({ route: 'profile', requestId, response: upstream, payload, cause: new Error('invalid_coordinator_payload'), explicitCode: 'AI_COORDINATOR_INVALID_RESPONSE' });
    }
    await commitGeneration(env.DB, generationReservationId);
    committed = true;
    if (payload.cacheable) {
      try {
        await savePublicCache(env.DB, { cacheKey, semanticFingerprint: fingerprint, generationId: payload.generationId, generationPolicyVersion: payload.generationPolicyVersion, response: payload.response, manifest });
      } catch (cause) {
        console.error(JSON.stringify({ event: 'ai_cache_write_failed', route: 'profile', requestId, error: cause instanceof Error ? cause.name : 'unknown' }));
      }
    }
    return json({ ...payload.response, requestId, feedbackToken: await feedbackToken(env, viewer.id, payload.generationId, requestId) } satisfies AskAiResponse, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (cause) {
    if (!committed) await releaseGeneration(env.DB, generationReservationId).catch(() => undefined);
    return coordinatorFailure({ route: 'profile', requestId, cause });
  }
}

export async function aiPreferences(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return apiError('AI_DATABASE_UNAVAILABLE', 503);
  const { viewer } = await getViewer(env, request);
  if (!viewer) return apiError('AUTH_REQUIRED', 401);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT accepted_policy_version,preference_version,text_analysis,media_analysis FROM ai_author_preferences WHERE user_id=?').bind(viewer.id).first<Record<string, unknown>>();
    return json({ currentPolicyVersion: CURRENT_AI_POLICY_VERSION, preferences: row ? { acceptedPolicyVersion: row.accepted_policy_version, preferenceVersion: row.preference_version, textAnalysis: row.text_analysis || 'PUBLIC_ONLY', mediaAnalysis: row.media_analysis || 'PUBLIC_ONLY' } : { acceptedPolicyVersion: null, preferenceVersion: 1, textAnalysis: 'PUBLIC_ONLY', mediaAnalysis: 'PUBLIC_ONLY' } });
  }
  if (request.method !== 'PUT') return apiError('METHOD_NOT_ALLOWED', 405);
  if (!validOrigin(request, env)) return apiError('ORIGIN_NOT_ALLOWED', 403);
  try {
    const input = preferencesSchema.parse(await boundedJson(request));
    await updateAuthorAiPreferences(createQueryContext(env), viewer.id, { acceptedPolicyVersion: CURRENT_AI_POLICY_VERSION, textAnalysis: input.textAnalysis, mediaAnalysis: input.mediaAnalysis });
    return json({ ok: true, acceptedPolicyVersion: CURRENT_AI_POLICY_VERSION });
  } catch { return apiError('INVALID_AI_PREFERENCES', 422); }
}

/**
 * Author-only, per-post consent for restricted content.  The endpoint never
 * accepts an author id from the client and never broadens the viewer ACL;
 * it only records whether the owning author explicitly enabled AI analysis
 * for this particular post.
 */
export async function postAiConsent(request: Request, env: Env, postId: string, ensurePost?: () => Promise<{ synced: boolean }>): Promise<Response> {
  if (!env.DB) return apiError('AI_DATABASE_UNAVAILABLE', 503);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return apiError('POST_NOT_FOUND_OR_INACCESSIBLE', 404);
  const { viewer } = await getViewer(env, request);
  if (!viewer) return apiError('AUTH_REQUIRED', 401);
  if (request.method === 'PUT' && !validOrigin(request, env)) return apiError('ORIGIN_NOT_ALLOWED', 403);
  try {
    let post = await env.DB.prepare('SELECT author_id,visibility FROM posts WHERE id=? AND deleted_at IS NULL LIMIT 1').bind(postId).first<{ author_id: string; visibility: string }>();
    if (!post && ensurePost) {
      const ensured = await ensurePost();
      if (ensured.synced) post = await env.DB.prepare('SELECT author_id,visibility FROM posts WHERE id=? AND deleted_at IS NULL LIMIT 1').bind(postId).first<{ author_id: string; visibility: string }>();
    }
    if (!post || post.author_id !== viewer.id) return apiError('POST_NOT_FOUND_OR_INACCESSIBLE', 404);
    const preference = await env.DB.prepare('SELECT text_analysis,media_analysis FROM ai_author_preferences WHERE user_id=? LIMIT 1').bind(viewer.id).first<{ text_analysis: string | null; media_analysis: string | null }>();
    const row = await env.DB.prepare('SELECT accepted_policy_version,text_analysis,media_analysis,consent_version,updated_at FROM post_ai_consents WHERE post_id=? AND author_id=? LIMIT 1').bind(postId, viewer.id).first<{ accepted_policy_version: string | null; text_analysis: string; media_analysis: string; consent_version: number; updated_at: number }>();
    if (request.method === 'GET') {
      const globalDisabled = preference?.text_analysis === 'DISABLED' || preference?.media_analysis === 'DISABLED';
      const enabled = !globalDisabled && (row ? row.text_analysis === 'AUTHORIZED_CONTEXT' && row.media_analysis === 'AUTHORIZED_CONTEXT' : post.visibility === 'public');
      return json({ ok: true, postId, visibility: post.visibility, enabled, explicit: Boolean(row), acceptedPolicyVersion: row?.accepted_policy_version || null, consentVersion: row?.consent_version || 0, updatedAt: row?.updated_at || null, globalDisabled });
    }
    if (request.method !== 'PUT') return apiError('METHOD_NOT_ALLOWED', 405);
    const input = postAiConsentSchema.parse(await boundedJson(request));
    await updatePostAiConsent(createQueryContext(env), postId, viewer.id, { acceptedPolicyVersion: CURRENT_AI_POLICY_VERSION, enabled: input.enabled });
    return json({ ok: true, postId, enabled: input.enabled, acceptedPolicyVersion: CURRENT_AI_POLICY_VERSION });
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'post_not_found') return apiError('POST_NOT_FOUND_OR_INACCESSIBLE', 404);
    if (cause instanceof z.ZodError) return apiError('INVALID_AI_CONSENT', 422);
    return apiError('AI_DATABASE_UNAVAILABLE', 503);
  }
}

export async function aiFeedback(request: Request, env: Env): Promise<Response> {
  if (!env.DB || !env.AI_FEEDBACK_SIGNING_SECRET) return apiError('AI_FEEDBACK_UNAVAILABLE', 503);
  const { viewer } = await getViewer(env, request);
  if (!viewer) return apiError('AUTH_REQUIRED', 401);
  if (request.method !== 'POST' || !validOrigin(request, env)) return apiError('METHOD_NOT_ALLOWED', request.method === 'POST' ? 403 : 405);
  const schema = z.object({ feedbackToken: z.string().max(2048), rating: z.union([z.literal(-1), z.literal(1)]) }).strict();
  try {
    const input = schema.parse(await boundedJson(request));
    const [payloadPart, signature] = input.feedbackToken.split('.');
    if (!payloadPart || !signature) throw new Error('invalid_token');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AI_FEEDBACK_SIGNING_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signatureBytes = new Uint8Array(signature.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) || []);
    if (!await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(payloadPart))) throw new Error('invalid_token');
    const padded = payloadPart.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - payloadPart.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as { viewerId: string; generationId: string; exp: number };
    if (payload.viewerId !== viewer.id || payload.exp < Date.now()) throw new Error('invalid_token');
    const diagnostic = await env.DB.prepare('SELECT model_class,route,modality,degraded,latency_bucket,prompt_version FROM ai_generation_diagnostics WHERE generation_id=? AND expires_at>?').bind(payload.generationId, Date.now()).first<Record<string, unknown>>();
    const viewerHash = await hmacSha256(env.LOG_PSEUDONYM_MASTER_SECRET || env.AI_FEEDBACK_SIGNING_SECRET, `${new Date().toISOString().slice(0, 7)}:${viewer.id}`);
    await env.DB.prepare(`INSERT INTO ai_feedback(generation_id,viewer_hash,rating,diagnostic_json,created_at,expires_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(generation_id,viewer_hash) DO UPDATE SET rating=excluded.rating,diagnostic_json=excluded.diagnostic_json,created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .bind(payload.generationId, viewerHash, input.rating, JSON.stringify(diagnostic || {}), Date.now(), Date.now() + 7 * 86_400_000).run();
    return json({ ok: true });
  } catch { return apiError('INVALID_FEEDBACK_TOKEN', 422); }
}
