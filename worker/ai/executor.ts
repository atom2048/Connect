import type { Env } from '../types';
import { commitGeneration, commitUserBurn, userBurnAvailable } from './quota';
import { revalidateManifest, serializeContext } from './context';
import { controlFetch } from './control-plane';
import { materializeImages } from './media';
import { AiUpstreamError, callOpenRouter, endpointSnapshot } from './openrouter';
import { validateOutputRisk } from './risk';
import type { AskAiResponse, GenerationRequest, GenerationResult, MaterializedImage, ModelAnswer, PrivacyClass } from './types';
import { AI_LIMITS, imagesForModel, LEGACY_MODEL_CHAINS, MODEL_CHAINS, type ModelKey } from './config';

const safeLog = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

async function hardStop(env: Env, reason: string, requestId: string): Promise<void> {
  await controlFetch(env, '/hard-stop', { reason });
  safeLog('ai_hard_stop', { reason, requestId });
}

function coverage(request: GenerationRequest, images: MaterializedImage[], modeUsed: 'text' | 'vision'): AskAiResponse['coverage'] {
  const supported = request.manifest.media.filter((item) => ['image/avif', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(item.mimeType)).length;
  return {
    modalityRequested: request.mediaUsageMode === 'TEXT_ONLY' ? 'text' : 'vision',
    modalityUsed: modeUsed,
    imagesTotal: request.manifest.media.length,
    imagesAnalyzed: images.length,
    animatedImagesTruncated: images.filter((image) => image.animatedTruncated).length,
    videosTotal: request.manifest.media.filter((item) => item.mimeType.startsWith('video/')).length,
    videosAnalyzed: 0,
    unsupportedImages: Math.max(0, request.manifest.media.length - supported),
    contextTruncated: request.manifest.contextTruncated,
    answerTruncated: false,
  };
}

function insufficient(request: GenerationRequest, reason: AskAiResponse['insufficientReason']): GenerationResult {
  return {
    generationId: crypto.randomUUID(), generationPolicyVersion: 'no-upstream', cacheable: false,
    response: { answer: '', insufficientContext: true, insufficientReason: reason, citations: [], coverage: coverage(request, [], 'text'), degraded: false },
  };
}

export function modelChain(request: GenerationRequest, images: MaterializedImage[], routeOverride?: 'text' | 'vision'): ModelKey[] {
  const route = routeOverride || (images.length ? 'vision' : 'text');
  // Requested chains are always attempted first. The prior free-only chain is
  // retained as a compatibility tail so a catalog refresh cannot strand an
  // already approved production snapshot while the new models are being
  // verified. No tail item can bypass endpoint, privacy, or zero-cost checks.
  // A model may be present in both the current and compatibility policy lists
  // during a catalog migration. Do not spend another upstream request on the
  // same failing model in one generation attempt.
  const requested = [...MODEL_CHAINS[route], ...LEGACY_MODEL_CHAINS[route]];
  // Optional vision is allowed to degrade to text. Keep the text chain in
  // the same bounded attempt list so a provider that rejects the image body,
  // times out, or returns a capability error can still answer from the post
  // text without requiring a second user request.
  const optionalTextFallback = request.mediaUsageMode === 'VISION_OPTIONAL' && route === 'vision'
    ? [...MODEL_CHAINS.text, ...LEGACY_MODEL_CHAINS.text]
    : [];
  return [...new Set([...requested, ...optionalTextFallback])];
}

type EndpointSnapshot = Awaited<ReturnType<typeof endpointSnapshot>>;

type SnapshotProbe = {
  model: ModelKey;
  snapshot?: EndpointSnapshot;
  reason?: string;
  status?: number;
  diagnostic?: string;
  durationMs: number;
};

async function preloadSnapshots(db: D1Database, requestId: string, modelKeys: ModelKey[], privacyClass: PrivacyClass): Promise<{
  snapshots: Map<ModelKey, EndpointSnapshot>;
  failures: Map<ModelKey, SnapshotProbe>;
}> {
  const probes = await Promise.all(modelKeys.map(async (model): Promise<SnapshotProbe> => {
    const startedAt = Date.now();
    try {
      const snapshot = await endpointSnapshot(db, model, privacyClass);
      const durationMs = Date.now() - startedAt;
      safeLog('ai_endpoint_snapshot_probe', {
        requestId,
        phase: 'snapshot',
        model,
        outcome: 'eligible',
        durationMs,
        attemptSeconds: Number((durationMs / 1_000).toFixed(3)),
      });
      return { model, snapshot, durationMs };
    } catch (cause) {
      const durationMs = Date.now() - startedAt;
      const reason = cause instanceof AiUpstreamError ? cause.code : 'SNAPSHOT_ERROR';
      const status = cause instanceof AiUpstreamError ? cause.status : undefined;
      const diagnostic = cause instanceof AiUpstreamError ? cause.diagnostic : undefined;
      safeLog('ai_endpoint_snapshot_probe', {
        requestId,
        phase: 'snapshot',
        model,
        outcome: 'unavailable',
        reason,
        status,
        diagnostic,
        durationMs,
        attemptSeconds: Number((durationMs / 1_000).toFixed(3)),
      });
      return { model, reason, status, diagnostic, durationMs };
    }
  }));
  return {
    snapshots: new Map(probes.filter((probe): probe is SnapshotProbe & { snapshot: EndpointSnapshot } => Boolean(probe.snapshot)).map((probe) => [probe.model, probe.snapshot])),
    failures: new Map(probes.filter((probe) => !probe.snapshot).map((probe) => [probe.model, probe])),
  };
}

function timeoutFor(key: ModelKey, direct: boolean): number {
  const configured = {
    minimaxM3: 30_000,
    nemotronUltra: 45_000,
    hy3: 30_000,
    minimaxM27: 30_000,
    lagunaS21: 30_000,
    inkling: 30_000,
    lingVl: 30_000,
    gemma31: 20_000,
    gemma26: 15_000,
    glm52: 20_000,
    dots: 40_000,
  } satisfies Record<ModelKey, number>;
  return configured[key] || (direct ? 20_000 : 10_000);
}

function validateGrounding(answer: ModelAnswer, request: GenerationRequest): { answer: ModelAnswer; status: 'VALID' | 'PARTIAL' | 'FAILED' } {
  const sources = new Set(request.manifest.sources.map((source) => source.ref));
  const media = new Set(request.selectedMedia.map((item) => item.ref));
  const validCitations = answer.citedRefs.filter((ref) => sources.has(ref));
  const validMedia = (answer.usedMediaRefs || []).filter((ref) => media.has(ref));
  const unknown = answer.citedRefs.length - validCitations.length + (answer.usedMediaRefs?.length || 0) - validMedia.length;
  const status = unknown === 0 ? 'VALID' : validCitations.length ? 'PARTIAL' : 'FAILED';
  return { answer: { ...answer, citedRefs: validCitations, usedMediaRefs: validMedia }, status };
}

export async function executeGeneration(env: Env, request: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
  const startedAt = Date.now();
  if (!env.DB) throw new AiUpstreamError('AI_DATABASE_UNAVAILABLE');
  const db = env.DB;
  const excludeProductionFixtures = env.AI_ENVIRONMENT === 'production';
  if (!await revalidateManifest(env.DB, request.viewerId, request.manifest, request.mediaUsageMode === 'TEXT_ONLY', excludeProductionFixtures)) throw new AiUpstreamError('CONTEXT_CHANGED_BEFORE_DISPATCH', 409);
  const runtime = await controlFetch(env, '/runtime');
  const runtimeState = await runtime.json<Record<string, unknown>>();
  if (!runtime.ok || !runtimeState.enabled || runtimeState.hardStopReason) throw new AiUpstreamError(String(runtimeState.hardStopReason || 'AI_DISABLED'), 503);
  const providerPrivacy: PrivacyClass = request.inputRisk === 'PERSONAL_DATA' && request.manifest.privacyClass === 'PUBLIC_AI' ? 'LIMITED_AI' : request.manifest.privacyClass;
  if (request.mediaUsageMode === 'VISION_REQUIRED' && (!request.selectedMedia.length || runtimeState.imagesAvailable === false)) {
    return insufficient(request, request.selectedMedia.length ? 'MEDIA_NOT_AVAILABLE' : 'MEDIA_ANALYSIS_NOT_ALLOWED');
  }
  const visionRequested = request.mediaUsageMode !== 'TEXT_ONLY'
    && request.selectedMedia.length > 0
    && runtimeState.imagesAvailable !== false;
  const textCandidates = modelChain(request, [], 'text');
  const visionCandidates = modelChain(request, [], 'vision');
  const snapshotCandidates = request.mediaUsageMode === 'VISION_REQUIRED' && visionRequested
    ? visionCandidates
    : visionRequested
      ? [...new Set([...visionCandidates, ...textCandidates])]
      : textCandidates;
  // Snapshot reads are independent. Probe the finite candidate set in
  // parallel, then prune unavailable models before any upstream attempt so a
  // missing/expired model cannot become a serial fallback delay.
  const { snapshots: prevalidatedSnapshots, failures: snapshotFailures } = await preloadSnapshots(env.DB, request.deliveryRequestId, snapshotCandidates, providerPrivacy);
  const visionSnapshotAvailable = visionCandidates.some((key) => prevalidatedSnapshots.has(key));
  if (request.mediaUsageMode === 'VISION_REQUIRED' && visionRequested && !visionSnapshotAvailable) {
    const firstVisionFailure = visionCandidates.map((key) => snapshotFailures.get(key)).find(Boolean);
    throw new AiUpstreamError(firstVisionFailure?.reason || 'PRIVACY_COMPATIBLE_PROVIDER_UNAVAILABLE', firstVisionFailure?.status || 503, false, undefined, firstVisionFailure?.diagnostic);
  }

  let images: MaterializedImage[] = [];
  if (request.mediaUsageMode !== 'TEXT_ONLY' && request.selectedMedia.length && (visionSnapshotAvailable || runtimeState.imagesAvailable === false)) {
    if (runtimeState.imagesAvailable === false) {
      if (request.mediaUsageMode === 'VISION_REQUIRED') return insufficient(request, 'MEDIA_NOT_AVAILABLE');
    } else {
      const mediaStartedAt = Date.now();
      try {
        images = await materializeImages(env, request.selectedMedia, providerPrivacy, request.deliveryRequestId);
        safeLog('ai_media_materialization', {
          requestId: request.deliveryRequestId,
          selectedCount: request.selectedMedia.length,
          materializedCount: images.length,
          totalBytes: images.reduce((sum, image) => sum + image.binaryBytes, 0),
          durationMs: Date.now() - mediaStartedAt,
          attemptSeconds: Number(((Date.now() - mediaStartedAt) / 1_000).toFixed(3)),
        });
      }
      catch (cause) {
        safeLog('ai_media_materialization_failed', {
          requestId: request.deliveryRequestId,
          required: request.mediaUsageMode === 'VISION_REQUIRED',
          selected: request.selectedMedia.length,
          durationMs: Date.now() - mediaStartedAt,
          attemptSeconds: Number(((Date.now() - mediaStartedAt) / 1_000).toFixed(3)),
          reason: cause instanceof Error ? cause.message.slice(0, 96) : 'unknown',
        });
        if (cause instanceof Error && cause.message === 'IMAGES_FREE_LIMIT_EXHAUSTED') await controlFetch(env, '/images/unavailable', {});
        if (request.mediaUsageMode === 'VISION_REQUIRED') return insufficient(request, 'MEDIA_NOT_AVAILABLE');
      }
    }
  }
  if (request.mediaUsageMode === 'VISION_REQUIRED' && !images.length) return insufficient(request, request.selectedMedia.length ? 'MEDIA_NOT_AVAILABLE' : 'MEDIA_ANALYSIS_NOT_ALLOWED');

  const contextJson = serializeContext(request.manifest);
  const candidateChain = modelChain(request, images);
  const chain = candidateChain.filter((key) => {
    if (prevalidatedSnapshots.has(key)) return true;
    const failure = snapshotFailures.get(key);
    safeLog('ai_endpoint_skipped', {
      requestId: request.deliveryRequestId,
      phase: 'snapshot-prune',
      model: key,
      reason: failure?.reason || 'SNAPSHOT_NOT_PROBED',
      status: failure?.status,
      diagnostic: failure?.diagnostic,
      durationMs: failure?.durationMs,
      attemptSeconds: failure ? Number((failure.durationMs / 1_000).toFixed(3)) : undefined,
    });
    return false;
  });
  const auditSources = request.manifest.sources.map((source) => ({
    ref: source.ref,
    type: source.type,
    id: source.type === 'profile' ? undefined : source.actualId,
    relation: source.relation,
    visibility: source.visibility,
  }));
  const visibilityCounts = auditSources.reduce<Record<string, number>>((counts, source) => {
    counts[source.visibility] = (counts[source.visibility] || 0) + 1;
    return counts;
  }, {});
  safeLog('ai_context_dispatch_audit', {
    requestId: request.deliveryRequestId,
    subjectType: request.manifest.subjectType || 'post',
    sourceCount: auditSources.length,
    sources: auditSources,
    sentPostIds: auditSources.filter((source) => source.type === 'post').map((source) => source.id),
    sentReplyIds: auditSources.filter((source) => source.type === 'comment').map((source) => source.id),
    visibilityCounts,
    selectedImageCount: request.selectedMedia.length,
    materializedImageCount: images.length,
    imageRefs: images.map((image) => ({ ref: image.ref, belongsTo: image.belongsTo, position: image.position })),
    contextTruncated: request.manifest.contextTruncated,
    bodyLogged: false,
    piiLogged: false,
  });
  let lastError: unknown;
  let firstUpstreamError: AiUpstreamError | null = null;
  let finalAnswer: ModelAnswer | null = null;
  let generationPolicyVersion = '';
  let generationId: string = crypto.randomUUID();
  let usedImages = images;
  let groundingStatus: 'VALID' | 'PARTIAL' | 'FAILED' = 'VALID';
  let usedModel: ModelKey = chain[0] || candidateChain[0] || 'dots';
  let finalRoutingAudit: Awaited<ReturnType<typeof callOpenRouter>>['routingAudit'] | null = null;
  let generationCommitted = false;
  let attemptedModelCount = 0;
  const recordAttemptAudit = async (attempt: {
    model: ModelKey;
    providerEndpoint: string;
    outcome: 'SUCCESS' | 'FAILED';
    durationMs: number;
    reason?: string | null;
    status?: number | null;
    fallbackEligible?: boolean;
    retryUsed?: boolean;
    finishReason?: string | null;
  }): Promise<void> => {
    try {
      await db.prepare(`INSERT OR REPLACE INTO ai_generation_attempt_audit(request_id,generation_id,attempt_ordinal,model_class,provider_endpoint,outcome,reason,status,fallback_eligible,retry_used,finish_reason,duration_ms,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        request.deliveryRequestId,
        generationId,
        attemptedModelCount,
        attempt.model,
        attempt.providerEndpoint,
        attempt.outcome,
        attempt.reason || null,
        attempt.status ?? null,
        attempt.fallbackEligible ? 1 : 0,
        attempt.retryUsed ? 1 : 0,
        attempt.finishReason || null,
        Math.max(0, Math.round(attempt.durationMs)),
        Date.now(),
        Date.now() + 7 * 86_400_000,
      ).run();
    } catch (cause) {
      safeLog('ai_generation_attempt_audit_write_failed', {
        requestId: request.deliveryRequestId,
        model: attempt.model,
        outcome: attempt.outcome,
        reason: cause instanceof Error ? cause.name : 'storage_error',
        bodyLogged: false,
        piiLogged: false,
      });
    }
  };
  const recordFailure = async (failure: AiUpstreamError): Promise<void> => {
    safeLog('ai_generation_failed', {
      requestId: request.deliveryRequestId,
      model: usedModel,
      reason: failure.code,
      status: failure.status,
      attemptedModelCount,
      fallbackAttempted: attemptedModelCount > 1,
    });
    try {
      const elapsed = Date.now() - startedAt;
      await db.prepare(`INSERT OR REPLACE INTO ai_generation_diagnostics(generation_id,model_class,route,modality,degraded,grounding_status,latency_bucket,prompt_version,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
        `failed-${generationId}`, usedModel, providerPrivacy, usedImages.length ? 'vision' : 'text', 1, 'FAILED',
        elapsed < 5_000 ? '<5s' : elapsed < 15_000 ? '5-15s' : elapsed < 30_000 ? '15-30s' : '30s+',
        `error:${failure.code}`, Date.now(), Date.now() + 86_400_000,
      ).run();
    } catch { /* diagnostics must never change the user-visible error path */ }
  };

  if (!chain.length) {
    const failure = [...snapshotFailures.values()][0];
    const error = new AiUpstreamError(failure?.reason || 'AI_PROVIDER_UNAVAILABLE', failure?.status || 503, false, undefined, failure?.diagnostic);
    await recordFailure(error);
    throw error;
  }

  let malformedRetryUsed = false;
  for (const [index, key] of chain.entries()) {
    const remaining = request.deadlineAt - Date.now() - AI_LIMITS.cleanupReserveMs;
    usedModel = key;
    if (remaining <= 3_000) { lastError = new AiUpstreamError('GLOBAL_TIMEOUT', 504); break; }
    const attemptImages = imagesForModel(key, request.mediaUsageMode, images);
    if (attemptImages === null) {
      lastError = new AiUpstreamError('VISION_MODEL_UNAVAILABLE', 503, true);
      continue;
    }
    const snapshot = prevalidatedSnapshots.get(key);
    if (!snapshot) {
      const probe = snapshotFailures.get(key);
      lastError = new AiUpstreamError(probe?.reason || 'AI_PROVIDER_UNAVAILABLE', probe?.status || 503, false, undefined, probe?.diagnostic);
      continue;
    }
    generationPolicyVersion = snapshot.generationPolicyVersion;
    const providerScope = `provider:${snapshot.providerEndpointSlug}`;
    const breakerStartedAt = Date.now();
    const breaker = await controlFetch(env, '/breaker/check', { scope: providerScope });
    if (!breaker.ok) {
      lastError = new AiUpstreamError('PROVIDER_BREAKER_OPEN', 503, true);
      safeLog('ai_endpoint_skipped', {
        requestId: request.deliveryRequestId,
        phase: 'breaker',
        model: key,
        reason: 'PROVIDER_BREAKER_OPEN',
        durationMs: Date.now() - breakerStartedAt,
        attemptSeconds: Number(((Date.now() - breakerStartedAt) / 1_000).toFixed(3)),
      });
      continue;
    }
    if (!await userBurnAvailable(env.DB, request.viewerId)) throw new AiUpstreamError('USER_UPSTREAM_BURN_LIMIT', 429);
    const reserve = await controlFetch(env, '/permit/reserve', { environment: env.AI_ENVIRONMENT || 'production' });
    const reservation = await reserve.json<{ ok: boolean; leaseId?: string; pressure?: number; code?: string }>();
    if (!reserve.ok || !reservation.leaseId) throw new AiUpstreamError(reservation.code || 'AI_CAPACITY_UNAVAILABLE');
    const leaseId = reservation.leaseId;
    if (!await revalidateManifest(env.DB, request.viewerId, request.manifest, request.mediaUsageMode === 'TEXT_ONLY', excludeProductionFixtures)) {
      await controlFetch(env, '/permit/release', { leaseId });
      throw new AiUpstreamError('CONTEXT_CHANGED_BEFORE_DISPATCH', 409);
    }
    const dispatched = await controlFetch(env, '/permit/dispatch', { leaseId });
    if (!dispatched.ok) {
      await controlFetch(env, '/permit/release', { leaseId });
      throw new AiUpstreamError('AI_CAPACITY_UNAVAILABLE');
    }
    const burnAllowed = await commitUserBurn(env.DB, request.viewerId);
    if (!burnAllowed) { await controlFetch(env, '/permit/finish', { leaseId }); throw new AiUpstreamError('USER_UPSTREAM_BURN_LIMIT', 429); }
    if (!generationCommitted) {
      await commitGeneration(env.DB, request.generationReservationId);
      generationCommitted = true;
    }
    const attemptStartedAt = Date.now();
    let attemptResult: Awaited<ReturnType<typeof callOpenRouter>> | null = null;
    let attemptFailure: unknown = null;
    let retryUsedForAttempt = false;
    attemptedModelCount += 1;
    try {
      try {
        attemptResult = await callOpenRouter({
          env, key, snapshot, privacyClass: providerPrivacy, question: request.question, contextJson, images: attemptImages,
          timeoutMs: Math.min(timeoutFor(key, chain.length === 1), remaining), signal, requestId: request.deliveryRequestId,
          compact: request.manifest.subjectType === 'profile',
          maxTokens: request.manifest.subjectType === 'profile'
            ? (attemptImages.length ? AI_LIMITS.profileVisionAnswerMaxTokens : AI_LIMITS.profileAnswerMaxTokens)
            : undefined,
        });
      } catch (firstCause) {
        if (!malformedRetryUsed && firstCause instanceof AiUpstreamError && firstCause.code === 'MODEL_OUTPUT_MALFORMED' && firstCause.finishReason === 'length') {
          malformedRetryUsed = true;
          retryUsedForAttempt = true;
          safeLog('ai_model_output_retry', {
            requestId: request.deliveryRequestId,
            model: key,
            reason: 'finish_reason:length',
            retry: 'one_concise_safe_retry',
          });
          const retryRemaining = request.deadlineAt - Date.now() - AI_LIMITS.cleanupReserveMs;
          if (retryRemaining <= 3_000) {
            attemptFailure = new AiUpstreamError('GLOBAL_TIMEOUT', 504);
          } else {
            try {
              attemptResult = await callOpenRouter({
                env, key, snapshot, privacyClass: providerPrivacy, question: request.question, contextJson, images: attemptImages,
                timeoutMs: Math.min(timeoutFor(key, chain.length === 1), retryRemaining), signal,
                requestId: request.deliveryRequestId, compact: true,
                maxTokens: request.manifest.subjectType === 'profile'
                  ? (attemptImages.length ? AI_LIMITS.profileVisionAnswerMaxTokens : AI_LIMITS.profileAnswerMaxTokens)
                  : undefined,
              });
              safeLog('ai_model_output_retry_succeeded', {
                requestId: request.deliveryRequestId,
                model: key,
                durationMs: Date.now() - attemptStartedAt,
                attemptSeconds: Number(((Date.now() - attemptStartedAt) / 1_000).toFixed(3)),
              });
            } catch (retryCause) {
              attemptFailure = retryCause;
              safeLog('ai_model_output_retry_failed', {
                requestId: request.deliveryRequestId,
                model: key,
                reason: retryCause instanceof AiUpstreamError ? retryCause.code : 'UPSTREAM_ERROR',
                finishReason: retryCause instanceof AiUpstreamError ? retryCause.finishReason || null : null,
                durationMs: Date.now() - attemptStartedAt,
                attemptSeconds: Number(((Date.now() - attemptStartedAt) / 1_000).toFixed(3)),
              });
            }
          }
        } else {
          attemptFailure = firstCause;
        }
      }
      if (attemptFailure) throw attemptFailure;
      if (!attemptResult) throw new AiUpstreamError('OPENROUTER_INVALID_RESPONSE', 503, true);
      const result = attemptResult;
      await controlFetch(env, '/breaker/sample', { scope: providerScope, category: 'provider', failed: false });
      await controlFetch(env, '/permit/finish', { leaseId });
      generationId = result.generationId || generationId;
      finalRoutingAudit = result.routingAudit;
      await recordAttemptAudit({
        model: key,
        providerEndpoint: snapshot.providerEndpointSlug,
        outcome: 'SUCCESS',
        status: 200,
        durationMs: Date.now() - attemptStartedAt,
        retryUsed: retryUsedForAttempt,
      });
      const grounded = validateGrounding(result.answer, request);
      safeLog('ai_upstream_verified', {
        requestId: request.deliveryRequestId,
        generationId,
        requestedModel: snapshot.requestedModel,
        actualModel: result.routingAudit.actualModel,
        provider: result.routingAudit.actualProvider,
        providerEndpoint: snapshot.providerEndpointSlug,
        byok: result.routingAudit.byok,
        attempt: result.routingAudit.attempt,
        fallback: index > 0,
        attemptDurationMs: Date.now() - attemptStartedAt,
        attemptSeconds: Number(((Date.now() - attemptStartedAt) / 1_000).toFixed(3)),
        retryUsed: retryUsedForAttempt,
        sentPostIds: request.manifest.sources.filter((source) => source.type === 'post').map((source) => source.actualId),
        sentReplyIds: request.manifest.sources.filter((source) => source.type === 'comment').map((source) => source.actualId),
        sentVisibility: [...new Set(request.manifest.sources.map((source) => source.visibility))],
        sentImageCount: attemptImages.length,
        reportedCost: result.routingAudit.reportedCost,
        costVerification: result.routingAudit.costVerification,
        generationPolicyVersion,
      });
      finalAnswer = grounded.answer;
      usedImages = attemptImages;
      groundingStatus = grounded.status;
      if (grounded.status === 'FAILED' && Number(reservation.pressure || 1) < 0.6 && index < chain.length - 1) { lastError = new AiUpstreamError('GROUNDING_FAILED', 503, true); continue; }
      break;
    } catch (cause) {
      await controlFetch(env, '/permit/finish', { leaseId });
      lastError = cause;
      if (!firstUpstreamError && cause instanceof AiUpstreamError) firstUpstreamError = cause;
      await recordAttemptAudit({
        model: key,
        providerEndpoint: snapshot.providerEndpointSlug,
        outcome: 'FAILED',
        reason: cause instanceof AiUpstreamError ? cause.code : 'UPSTREAM_ERROR',
        status: cause instanceof AiUpstreamError ? cause.status : 503,
        durationMs: Date.now() - attemptStartedAt,
        fallbackEligible: cause instanceof AiUpstreamError ? cause.fallbackEligible : false,
        retryUsed: retryUsedForAttempt,
        finishReason: cause instanceof AiUpstreamError ? cause.finishReason || null : null,
      });
      safeLog('ai_upstream_failed', {
        requestId: request.deliveryRequestId,
        model: key,
        reason: cause instanceof AiUpstreamError ? cause.code : 'UPSTREAM_ERROR',
        status: cause instanceof AiUpstreamError ? cause.status : 503,
        fallbackEligible: cause instanceof AiUpstreamError ? cause.fallbackEligible : false,
        retryAfter: cause instanceof AiUpstreamError ? cause.retryAfter || null : null,
        diagnostic: cause instanceof AiUpstreamError ? cause.diagnostic || null : null,
        finishReason: cause instanceof AiUpstreamError ? cause.finishReason || null : null,
        attemptDurationMs: Date.now() - attemptStartedAt,
        attemptSeconds: Number(((Date.now() - attemptStartedAt) / 1_000).toFixed(3)),
        retryUsed: retryUsedForAttempt,
        sentPostIds: request.manifest.sources.filter((source) => source.type === 'post').map((source) => source.actualId),
        sentReplyIds: request.manifest.sources.filter((source) => source.type === 'comment').map((source) => source.actualId),
        sentImageCount: attemptImages.length,
      });
      if (cause instanceof AiUpstreamError && cause.code === 'OPENROUTER_RATE_LIMIT') {
        await controlFetch(env, '/breaker/open', { scope: providerScope, until: Date.now() + Math.max(60, cause.retryAfter || 60) * 1_000 });
        // A pinned provider 429 is scoped to this endpoint. Cool it down and
        // continue to the next already-approved endpoint so one busy free
        // provider does not make the whole Ask AI request fail.
        if (index < chain.length - 1) continue;
        break;
      }
      if (cause instanceof AiUpstreamError && ['AI_BILLING_POLICY_VIOLATION'].includes(cause.code)) { await hardStop(env, 'BILLING_INVARIANT', request.deliveryRequestId); throw cause; }
      if (cause instanceof AiUpstreamError && ['AI_PROVIDER_POLICY_VIOLATION', 'AI_MODEL_POLICY_VIOLATION', 'AI_ROUTER_PIPELINE_VIOLATION'].includes(cause.code)) {
        // A single endpoint can become privacy-incompatible or return an
        // unexpected router stage after its snapshot was approved. Treat that
        // endpoint as unavailable and continue to the next already-approved
        // free endpoint; do not take the entire Ask AI service offline.
        safeLog('ai_model_skipped', { requestId: request.deliveryRequestId, model: key, reason: cause.code });
        if (index < chain.length - 1) continue;
        break;
      }
      if (cause instanceof AiUpstreamError && [
        'PROVIDER_TRANSIENT',
        'MODEL_TIMEOUT',
        'OPENROUTER_TIMEOUT',
        'OPENROUTER_SERVER_ERROR',
        'OPENROUTER_TRANSPORT_FAILURE',
        'OPENROUTER_INVALID_RESPONSE',
        'AI_PROVIDER_UNAVAILABLE',
        'NO_ELIGIBLE_ENDPOINT',
        'AI_ROUTER_METADATA_MISSING',
        'AI_INPUT_TOO_LARGE',
        'MEDIA_NOT_AVAILABLE',
        'MODEL_OUTPUT_MALFORMED',
      ].includes(cause.code)) {
        // Feed transient endpoint failures into the provider breaker. This
        // keeps a degraded model from being selected repeatedly across
        // requests while still allowing the finite fallback chain to run.
        await controlFetch(env, '/breaker/sample', { scope: providerScope, category: 'provider', failed: true });
      }
      if (!(cause instanceof AiUpstreamError) || !cause.fallbackEligible || index === chain.length - 1) break;
    }
  }
  if (!finalAnswer) {
    // If every later candidate was unavailable because its snapshot is
    // missing, preserve the first concrete upstream failure instead of
    // masking it as a generic policy error. The returned code remains a
    // bounded, secret-free operational code and lets the UI explain whether
    // the provider timed out, returned 5xx, or supplied malformed output.
    const failure = firstUpstreamError || (lastError instanceof AiUpstreamError ? lastError : null) || new AiUpstreamError('AI_PROVIDER_UNAVAILABLE');
    await recordFailure(failure);
    throw failure;
  }
  const authorizedInput = `${request.question}\n${contextJson}`;
  const outputRisk = validateOutputRisk(finalAnswer.answer, authorizedInput);
  if (!outputRisk.allowed) throw new AiUpstreamError('OUTPUT_RISK_BLOCKED', 422);
  if (!await revalidateManifest(env.DB, request.viewerId, request.manifest, request.mediaUsageMode === 'TEXT_ONLY', excludeProductionFixtures)) throw new AiUpstreamError('CONTEXT_CHANGED_AFTER_DISPATCH', 409);
  const citations = finalAnswer.citedRefs.flatMap((ref) => {
    const source = request.manifest.sources.find((item) => item.ref === ref);
    return source ? [{ ref, type: source.type, id: source.actualId, relation: source.relation }] : [];
  });
  const degraded = request.mediaUsageMode === 'VISION_OPTIONAL' && !usedImages.length;
  const latency = Date.now() - startedAt;
  await env.DB.prepare(`INSERT OR REPLACE INTO ai_generation_diagnostics(generation_id,model_class,route,modality,degraded,grounding_status,latency_bucket,prompt_version,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(generationId, usedModel, providerPrivacy, usedImages.length ? 'vision' : 'text', degraded ? 1 : 0, groundingStatus, latency < 5_000 ? '<5s' : latency < 15_000 ? '5-15s' : latency < 30_000 ? '15-30s' : '30s+', 'v1', Date.now(), Date.now() + 7 * 86_400_000).run();
  if (!finalRoutingAudit) throw new AiUpstreamError('AI_ROUTING_AUDIT_MISSING', 503);
  try {
    await env.DB.prepare(`INSERT OR REPLACE INTO ai_generation_routing_audit(generation_id,model_class,actual_model,actual_provider,byok,attempt,fallback,reported_cost,cost_verification,modality,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      generationId,
      usedModel,
      finalRoutingAudit.actualModel,
      finalRoutingAudit.actualProvider,
      finalRoutingAudit.byok ? 1 : 0,
      finalRoutingAudit.attempt,
      chain.indexOf(usedModel) > 0 ? 1 : 0,
      finalRoutingAudit.reportedCost,
      finalRoutingAudit.costVerification,
      usedImages.length ? 'vision' : 'text',
      Date.now(),
      Date.now() + 7 * 86_400_000,
    ).run();
  } catch (cause) {
    // A failed audit write must never leak an upstream error or make the
    // answer path retry. The response remains safe because callOpenRouter
    // already validated model, provider, attempt, BYOK, and cost.
    safeLog('ai_routing_audit_write_failed', { requestId: request.deliveryRequestId, model: usedModel, reason: cause instanceof Error ? cause.name : 'storage_error' });
  }
  return {
    generationId,
    generationPolicyVersion,
    cacheable: request.manifest.privacyClass === 'PUBLIC_AI' && request.inputRisk === 'CLEAR' && outputRisk.cacheable && !degraded && groundingStatus !== 'FAILED',
    response: {
      answer: finalAnswer.answer,
      insufficientContext: finalAnswer.insufficientContext,
      citations,
      coverage: coverage(request, usedImages, usedImages.length ? 'vision' : 'text'),
      degraded,
      degradedReason: degraded ? 'vision_unavailable' : undefined,
    },
  };
}
