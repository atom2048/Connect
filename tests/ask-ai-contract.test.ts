import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { imagesForModel, MODEL_CHAINS, MODEL_CONFIG, resolveMediaUsage, reviewedNoTrainingEndpoint } from '../worker/ai/config';
import { interactionRateLimitKeys } from '../worker/ai/rate-limit';
import { consentFor, inferMediaMimeType } from '../worker/ai/context';
import { scanTextRisk, validateOutputRisk } from '../worker/ai/risk';
import { retryAfterSeconds } from '../worker/ai/retry-after';
import { endpointRefreshDecision } from '../worker/ai/policy-health';
import type { MaterializedImage } from '../worker/ai/types';

describe('Ask AI consent and risk contracts', () => {
  it('keeps public content available when a legacy policy row is stale', () => {
    expect(consentFor({ acceptedPolicyVersion: 'old', preferenceVersion: 4, textAnalysis: 'PUBLIC_ONLY', mediaAnalysis: 'PUBLIC_ONLY' }, 'public')).toEqual({ allowText: true, allowMedia: true });
    expect(consentFor({ acceptedPolicyVersion: 'old', preferenceVersion: 4, textAnalysis: 'PUBLIC_ONLY', mediaAnalysis: 'PUBLIC_ONLY' }, 'friends')).toEqual({ allowText: false, allowMedia: false });
  });

  it('defaults restricted posts to off until the author enables that post', () => {
    const missing = { acceptedPolicyVersion: null, preferenceVersion: 1, textAnalysis: 'PUBLIC_ONLY' as const, mediaAnalysis: 'PUBLIC_ONLY' as const };
    expect(consentFor(missing, 'public')).toEqual({ allowText: true, allowMedia: true });
    for (const visibility of ['friends', 'limited', 'private']) expect(consentFor(missing, visibility)).toEqual({ allowText: false, allowMedia: false });
    for (const visibility of ['friends', 'limited', 'private']) expect(consentFor(missing, visibility, { textAnalysis: 'AUTHORIZED_CONTEXT', mediaAnalysis: 'AUTHORIZED_CONTEXT' })).toEqual({ allowText: true, allowMedia: true });
  });

  it('keeps an explicit DISABLED opt-out disabled for every visibility', () => {
    expect(consentFor({ acceptedPolicyVersion: 'connect-ai-policy-v1', preferenceVersion: 1, textAnalysis: 'DISABLED', mediaAnalysis: 'DISABLED' }, 'public')).toEqual({ allowText: false, allowMedia: false });
    expect(consentFor({ acceptedPolicyVersion: 'connect-ai-policy-v1', preferenceVersion: 1, textAnalysis: 'DISABLED', mediaAnalysis: 'DISABLED' }, 'friends')).toEqual({ allowText: false, allowMedia: false });
    expect(consentFor({ acceptedPolicyVersion: 'connect-ai-policy-v1', preferenceVersion: 1, textAnalysis: 'DISABLED', mediaAnalysis: 'DISABLED' }, 'private')).toEqual({ allowText: false, allowMedia: false });
    expect(consentFor({ acceptedPolicyVersion: 'connect-ai-policy-v1', preferenceVersion: 1, textAnalysis: 'PUBLIC_ONLY', mediaAnalysis: 'PUBLIC_ONLY' }, 'public', { textAnalysis: 'DISABLED', mediaAnalysis: 'DISABLED' })).toEqual({ allowText: false, allowMedia: false });
  });

  it('separates public text and media consent', () => {
    expect(consentFor({ acceptedPolicyVersion: 'connect-ai-policy-v1', preferenceVersion: 1, textAnalysis: 'PUBLIC_ONLY', mediaAnalysis: 'DISABLED' }, 'public')).toEqual({ allowText: true, allowMedia: false });
  });

  it('recovers MIME metadata for migrated R2 image records without trusting client input', () => {
    expect(inferMediaMimeType('/media/migration/public/post.webp', null)).toBe('image/webp');
    expect(inferMediaMimeType('/media/migration/public/post.jpeg?cache=1', null)).toBe('image/jpeg');
    expect(inferMediaMimeType('/media/migration/public/post.avif', 'image/*')).toBe('image/avif');
    expect(inferMediaMimeType('/media/migration/public/post.webp', 'image/png')).toBe('image/png');
    expect(inferMediaMimeType('/media/migration/public/post.png', 'image')).toBe('image/png');
    expect(inferMediaMimeType('/media/migration/public/post.bin', null)).toBe('application/octet-stream');
  });

  it('lets a per-post author grant override the public-only default without overriding DISABLED', () => {
    const prefs = { acceptedPolicyVersion: 'connect-ai-policy-v1', preferenceVersion: 1, textAnalysis: 'PUBLIC_ONLY' as const, mediaAnalysis: 'PUBLIC_ONLY' as const };
    expect(consentFor(prefs, 'friends', { textAnalysis: 'AUTHORIZED_CONTEXT', mediaAnalysis: 'AUTHORIZED_CONTEXT' })).toEqual({ allowText: true, allowMedia: true });
    expect(consentFor({ ...prefs, textAnalysis: 'DISABLED' }, 'friends', { textAnalysis: 'AUTHORIZED_CONTEXT', mediaAnalysis: 'AUTHORIZED_CONTEXT' })).toEqual({ allowText: false, allowMedia: true });
    expect(consentFor(prefs, 'friends', { textAnalysis: 'DISABLED', mediaAnalysis: 'AUTHORIZED_CONTEXT' })).toEqual({ allowText: false, allowMedia: true });
  });

  it('defaults auto questions to text unless visual intent is explicit', () => {
    expect(resolveMediaUsage('どう思う？', 'auto').mode).toBe('TEXT_ONLY');
    expect(resolveMediaUsage('この画像には何が写っている？', 'auto')).toEqual({ mode: 'VISION_REQUIRED', target: 'CURRENT_POST' });
    expect(resolveMediaUsage('引用画像も含めて説明して', 'auto').target).toBe('ALL_RELEVANT');
  });

  it('never downgrades a required visual question to a text-only fallback model', () => {
    const image = { ref: 'I1', belongsTo: 'P0', position: 1, dataUrl: 'data:image/png;base64,AA==', binaryBytes: 1, animatedTruncated: false } satisfies MaterializedImage;
    expect(imagesForModel('dots', 'VISION_REQUIRED', [image])).toEqual([image]);
    expect(imagesForModel('glm52', 'VISION_REQUIRED', [image])).toBeNull();
    expect(imagesForModel('glm52', 'VISION_OPTIONAL', [image])).toEqual([]);
  });

  it('refreshes retained snapshots only after an explicit live no-training/zero-price check', () => {
    const retained = { retention: { type: 'retained' } } as Parameters<typeof endpointRefreshDecision>[0];
    const fixed = { retention: { type: 'fixed', days: 55 } } as Parameters<typeof endpointRefreshDecision>[0];
    expect(endpointRefreshDecision(retained, false, true, true)).toBe('REFRESH');
    expect(endpointRefreshDecision(retained, null, true, true)).toBe('SKIP');
    expect(endpointRefreshDecision(retained, false, false, true)).toBe('INVALIDATE');
    expect(endpointRefreshDecision(fixed, false, true, true)).toBe('SKIP');
  });

  it('only fills an omitted endpoint policy for an exact reviewed tuple', () => {
    expect(reviewedNoTrainingEndpoint(MODEL_CONFIG.dots.id, 'AtlasCloud', 'atlas-cloud/fp8')?.source).toBe('openrouter-provider-directory');
    expect(reviewedNoTrainingEndpoint(MODEL_CONFIG.gemma31.id, 'Google AI Studio', 'google-ai-studio')?.source).toBe('openrouter-provider-directory');
    expect(reviewedNoTrainingEndpoint(MODEL_CONFIG.gemma31.id, 'Nvidia', 'nvidia')).toBeNull();
    expect(reviewedNoTrainingEndpoint(MODEL_CONFIG.gemma31.id, 'Google AI Studio', 'other')).toBeNull();
  });

  it('blocks credentials and Luhn-valid payment cards', () => {
    expect(scanTextRisk('Bearer abcdefghijklmnopqrstuvwxyz123').risk).toBe('BLOCKED');
    expect(scanTextRisk('4111 1111 1111 1111').risk).toBe('BLOCKED');
  });

  it('does not classify a date as a phone number while retaining real phone detection', () => {
    expect(scanTextRisk('検証日 20260922').risk).toBe('CLEAR');
    expect(scanTextRisk('連絡先 090-1234-5678').risk).toBe('PERSONAL_DATA');
  });

  it('rejects hallucinated personal data and permits input-grounded values without caching', () => {
    expect(validateOutputRisk('連絡先はtest@example.comです', '入力に連絡先はない').allowed).toBe(false);
    expect(validateOutputRisk('連絡先はtest@example.comです', 'test@example.com').cacheable).toBe(false);
  });
});

describe('Ask AI deployment invariants', () => {
  const worker = readFileSync(new URL('../worker/ai/openrouter.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../drizzle/0001_ask_ai_control.sql', import.meta.url), 'utf8');
  const coordinator = readFileSync(new URL('../worker/ai/coordinator.ts', import.meta.url), 'utf8');
  const routes = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const predeploy = readFileSync(new URL('../worker/ai/predeploy.ts', import.meta.url), 'utf8');
  const policyHealth = readFileSync(new URL('../worker/ai/policy-health.ts', import.meta.url), 'utf8');
  const executor = readFileSync(new URL('../worker/ai/executor.ts', import.meta.url), 'utf8');
  const handler = readFileSync(new URL('../worker/ai/handler.ts', import.meta.url), 'utf8');
  const coordinatorSource = readFileSync(new URL('../worker/ai/coordinator.ts', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../worker/auth.ts', import.meta.url), 'utf8');
  const envTypes = readFileSync(new URL('../worker/types.ts', import.meta.url), 'utf8');
  const standaloneConfig = readFileSync(new URL('../wrangler.standalone.jsonc', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/askAi.ts', import.meta.url), 'utf8');
  const productionGuard = readFileSync(new URL('../scripts/verify-production-ai-config.mjs', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const reactApp = readFileSync(new URL('../src/react/App.tsx', import.meta.url), 'utf8');
  const exploreClient = readFileSync(new URL('../src/pageModules/explore.ts', import.meta.url), 'utf8');
  const profileClient = readFileSync(new URL('../src/pageModules/profile.ts', import.meta.url), 'utf8');
  const context = readFileSync(new URL('../worker/ai/context.ts', import.meta.url), 'utf8');
  const quota = readFileSync(new URL('../worker/ai/quota.ts', import.meta.url), 'utf8');
  const rateLimit = readFileSync(new URL('../worker/ai/rate-limit.ts', import.meta.url), 'utf8');
  const routingAuditMigration = readFileSync(new URL('../drizzle/0005_ai_routing_audit.sql', import.meta.url), 'utf8');
  const postConsentMigration = readFileSync(new URL('../drizzle/0006_post_ai_consents.sql', import.meta.url), 'utf8');
  const attemptAuditMigration = readFileSync(new URL('../drizzle/0007_ai_attempt_audit.sql', import.meta.url), 'utf8');
  const cache = readFileSync(new URL('../worker/ai/cache.ts', import.meta.url), 'utf8');

  it('keeps the requested free model order for each route', () => {
    expect(MODEL_CHAINS.text).toEqual(['minimaxM3', 'nemotronUltra', 'hy3']);
    expect(MODEL_CHAINS.coding).toEqual(['nemotronUltra', 'minimaxM3', 'minimaxM27', 'lagunaS21']);
    expect(MODEL_CHAINS.vision).toEqual(['minimaxM3', 'inkling', 'gemma31', 'gemma26']);
    for (const key of Object.values(MODEL_CHAINS).flat()) expect(MODEL_CONFIG[key].id.endsWith(':free')).toBe(true);
  });

  it('does not retry a duplicate model from the compatibility tail', () => {
    expect(executor).toContain('const requested = [...MODEL_CHAINS[route], ...LEGACY_MODEL_CHAINS[route]];');
    expect(executor).toContain('return [...new Set([...requested, ...optionalTextFallback])];');
    expect(executor).toContain("request.mediaUsageMode === 'VISION_OPTIONAL'");
  });

  it('selects profile media from recent profile context, not the post-only current target', () => {
    expect(handler).toContain('selectMedia(candidateManifest, mode, profileMediaTarget)');
  });

  it('does not let shared IPs consume authenticated users’ burst budgets', () => {
    expect(interactionRateLimitKeys(false, 'firebase-user', 'ip:shared')).toEqual(['firebase-user']);
    expect(interactionRateLimitKeys(true, 'anon:hash', 'ip:hash')).toEqual(['ip:hash']);
  });

  it('forces router metadata, disables router cache and pins one provider', () => {
    expect(worker).toContain("const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions'");
    expect(worker).toContain("'X-OpenRouter-Metadata': 'enabled'");
    expect(worker).toContain("'X-OpenRouter-Cache': 'false'");
    expect(worker).toContain("'X-OpenRouter-Title': 'Connect Ask AI'");
    expect(worker).toContain('allow_fallbacks: false');
    expect(worker).toContain('only: [snapshot.providerEndpointSlug]');
  });

  it('uses one secret name, never accepts an alternate endpoint, and fails closed for unknown cost', () => {
    expect(envTypes).toContain('OPENROUTER_API_KEY: string;');
    for (const source of [worker, predeploy, policyHealth, handler, envTypes]) {
      expect(source).not.toContain('OPENROUTER_HEALTHCHECK_API_KEY');
      expect(source).not.toContain('OPENROUTER_BASE_URL');
    }
    expect(worker).toContain("throw new AiUpstreamError('AI_PROVIDER_CONFIGURATION_MISSING')");
    expect(worker).toContain('if (reportedCost === null || reportedCost !== 0)');
  });

  it('cools down a provider 429 and falls back to the next approved model', () => {
    expect(executor).toContain("cause.code === 'OPENROUTER_RATE_LIMIT'");
    expect(executor).toContain('// A pinned provider 429 is scoped to this endpoint.');
    expect(executor).toContain('if (index < chain.length - 1) continue;');
    expect(worker).toContain("new AiUpstreamError('OPENROUTER_RATE_LIMIT', 429, true");
  });

  it('skips one privacy-incompatible model without stopping the whole service', () => {
    expect(executor).toContain("safeLog('ai_model_skipped'");
    expect(executor).toContain("['AI_PROVIDER_POLICY_VIOLATION', 'AI_MODEL_POLICY_VIOLATION', 'AI_ROUTER_PIPELINE_VIOLATION']");
    expect(executor).toContain("'OPENROUTER_TRANSPORT_FAILURE'");
    expect(executor).toContain("'/breaker/sample'");
    expect(executor).not.toContain("hardStop(env, 'PROVIDER_PRIVACY_INVARIANT'");
  });

  it('records risk classification without logging context bodies', () => {
    expect(handler).toContain("event: 'ai_context_risk_classified'");
    expect(handler).toContain('findingCount: risk.findings.length');
    expect(handler).toContain('bodyLogged: false');
    expect(handler).toContain('piiLogged: false');
  });

  it('keeps public generation independent from alert webhook delivery', () => {
    expect(handler).toContain("event: 'ai_alert_webhook_unconfigured'");
    expect(handler).not.toContain('!adminTestConfigurationReady(env) || !env.AI_ALERT_WEBHOOK_URL');
    expect(auth).toContain('getViewerOrAnonymous');
    expect(auth).toContain('cf-connecting-ip');
    expect(standaloneConfig).toContain('"AI_ADMIN_ONLY": "false"');
    expect(standaloneConfig).toContain('"AI_ROLLOUT_PERCENT": "100"');
    expect(handler).toContain('return !env.AI_ALERT_WEBHOOK_URL || Boolean(env.AI_ALERT_SIGNING_SECRET);');
  });

  it('uses non-null version columns and separate consent dimensions', () => {
    for (const column of ['content_version', 'access_version', 'media_version', 'structure_version']) expect(migration).toContain(`${column} integer NOT NULL DEFAULT 1`);
    expect(migration).toContain('text_analysis');
    expect(migration).toContain('media_analysis');
  });

  it('keeps fingerprint coordinators storage-free', () => {
    expect(coordinator).not.toContain('storage.sql');
    expect(coordinator).not.toContain('storage.put');
    expect(coordinator).not.toContain('setAlarm');
  });

  it('keeps versioned content mutations out of route handlers', () => {
    expect(routes).not.toMatch(/(?:UPDATE|INSERT INTO)\s+(?:posts|comments|ai_author_preferences)/i);
  });

  it('shows Ask AI on every rendered card and delegates generation permission to the Worker', () => {
    expect(client).toContain('button.hidden = false');
    expect(client).toContain("button.parentElement?.classList.add('has-ask-ai')");
    expect(client).not.toContain("status.visible && status.isAdmin && status.authenticated && button.dataset.visibility === 'public'");
    expect(client).not.toContain("button.dataset.visibility === 'public'");
    expect(client).not.toContain('button.hidden = !');
    expect(client).toContain("AI_NOT_IN_ROLLOUT: 'このアカウントは現在Ask AIの利用対象外です。'");
    expect(client).toContain('response = await fetch(path');
    expect(client).toContain('Vercel rewrites it to this same Worker');
    expect(client).not.toContain('while (true)');
    expect(routes).toContain("normalizeVisibility(record) !== 'public'");
    expect(routes).not.toContain('authorId !== viewer.id');
    expect(reactApp).toContain("viewer ? setAskOpen(true) : onToast({ message: 'Ask AIを使うにはログインしてください'");
    expect(client).toContain("window.addEventListener('hashchange'");
    expect(client).toContain("window.addEventListener('pagehide'");
    expect(client).toContain('controller?.abort()');
  });

  it('checks legacy restricted content with metadata and D1 ACL before fetching its body', () => {
    expect(context).not.toContain("p.id=? AND p.visibility IN ('friends','private')");
    expect(handler).toContain('logPostAccessDiagnostic(env, viewer.id, postId, requestId, anonymous');
    expect(handler).toContain('normalViewAllowed');
    expect(handler).toContain('PRODUCTION_FIXTURE_EXCLUDED');
    expect(handler).toContain("event: 'ai_post_access_diagnostic'");
    for (const field of ['correlationId', 'viewerHash', 'postId', 'ownerMatch', 'aiAllowed', 'imageConsentAllowed', 'denyReason']) expect(handler).toContain(field);
    expect(context).not.toContain('authorizedLegacyPostId');
    expect(routes).toContain('async function syncFirebasePost');
    expect(routes).toContain("headers.set('Authorization', authorization)");
    expect(routes).toContain("metadataUrl.searchParams.append('mask.fieldPaths', fieldPath)");
    expect(routes).toContain('async function legacyPostViewerCanRead');
    expect(routes).toContain('acl_denied_before_content_fetch');
    expect(routes).toContain("?='public' OR ?=? OR (");
    expect(routes).toContain('SELECT 1 AS allowed\n    WHERE NOT EXISTS');
    expect(routes).toContain('firestore_update_time');
    expect(routes).toContain('existing?.firestore_update_time === metadataUpdateTime');
    expect(routes).toContain('ai_consent_denied_before_content_fetch');
    expect(routes).toContain("existing.visibility !== 'public' && !canForwardBearer");
    expect(routes).not.toContain('authorizedLegacyPostId');
    expect(routes).not.toContain('restrictedProof');
  });

  it('requires explicit author consent for restricted posts without weakening the ACL', () => {
    expect(postConsentMigration).toContain('CREATE TABLE post_ai_consents');
    expect(postConsentMigration).toContain("text_analysis text NOT NULL DEFAULT 'DISABLED'");
    expect(context).toContain('LEFT JOIN post_ai_consents consent');
    expect(context).toContain("postText === 'AUTHORIZED_CONTEXT'");
    expect(context).toContain("const restricted = visibility !== 'public'");
    expect(routes).toContain('/ai-consent');
    expect(handler).toContain('post.author_id !== viewer.id');
    expect(handler).toContain('updatePostAiConsent');
    expect(context).toContain("visibilityPredicate(viewerId, 'p')");
    expect(readFileSync(new URL('../worker/lib.ts', import.meta.url), 'utf8')).toContain("${tableAlias}.visibility = 'public' OR ${tableAlias}.author_id = ?");
    expect(readFileSync(new URL('../worker/lib.ts', import.meta.url), 'utf8')).toContain('FROM blocks bl');
    expect(context).toContain('productionFixturePredicate');
    expect(context).not.toContain("p.id=? AND p.visibility IN ('friends','private')");
    expect(client).toContain('getPostAiConsent');
    expect(client).toContain('setPostAiConsent');
    expect(readFileSync(new URL('../src/pageModules/home.ts', import.meta.url), 'utf8')).toContain('この投稿をAIで分析できるようにする');
    expect(readFileSync(new URL('../src/pageModules/home.ts', import.meta.url), 'utf8')).toContain('OpenRouterへ送信されます');
  });

  it('guards the public production flags before a standalone Worker deploy', () => {
    for (const flag of ['AI_GENERATION_ENABLED', 'AI_TEXT_READY', 'AI_VISION_READY', 'AI_ADMIN_ONLY', 'AI_ROLLOUT_PERCENT', 'AI_ENVIRONMENT']) expect(productionGuard).toContain(flag);
    expect(productionGuard).toContain("config.name !== 'connect-social-standalone'");
    expect(packageJson).toContain('npm run ai:production:check && wrangler deploy --config wrangler.standalone.jsonc');
  });

  it('self-heals an expired production snapshot with one durable scheduled cooldown', () => {
    expect(routes).toContain("const SCHEDULED_PREDEPLOY_RESOURCE = 'scheduled-auto-predeploy-v2'");
    expect(routes).toContain("json_extract(snapshot_json, '$.retention.type')='zdr'");
    expect(routes).toContain("throw new Error('NO_VALID_ZDR_TEXT_ENDPOINT')");
    expect(routes).toContain('WHERE ai_predeploy_progress.expires_at<=?');
    expect(routes).toContain("JSON.stringify({ outcome: 'running' })");
    expect(routes).toContain('Math.max(cooldown, Math.max(60, cause.retryAfterSeconds) * 1_000)');
    expect(routes).toContain("event: 'ai_scheduled_predeploy'");
  });

  it('keeps profile Ask AI public-only and routes profile search to the shared Explore screen', () => {
    const profileContext = context.slice(context.indexOf('export async function buildProfileContextManifest'), context.indexOf('\nexport function selectMedia'));
    expect(routes).toContain("const profileAskAiMatch = path.match(/^\\/api\\/profiles\\/([^/]+)\\/ask-ai$/)");
    expect(profileContext).toContain("WHERE p.author_id=? AND p.visibility='public' AND p.deleted_at IS NULL");
    expect(profileContext).toContain('p.id IN (${postIdPlaceholders})');
    expect(profileContext).toContain('verifiedPostIdSet.has(row.id)');
    expect(profileContext).toContain('const [profilePreference, posts] = await Promise.all([');
    expect(profileContext).not.toContain('FROM comments c');
    expect(profileContext).not.toContain('ProfileCommentRow');
    expect(profileContext).toContain('p.media_json');
    expect(profileContext).toContain('post_ai_media_analysis');
    expect(profileContext).toContain('mediaFrom(row, ref, item.relation)');
    expect(profileContext).toContain('media, privacyClass');
    expect(profileContext).not.toContain('media: []');
    expect(profileContext).not.toContain("visibility='friends'");
    expect(profileClient).toContain('.post-card[data-post-id][data-author-id][data-visibility="public"]');
    expect(profileClient).toContain('card.dataset.authorId === profileId');
    expect(profileClient).toContain('openProfileAskAiDialog(profileId, contextPostIds)');
    expect(client).toContain('requestBody.contextPostIds = options.profileContextPostIds.slice(0, 12)');
    expect(handler).toContain("contextPostIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)).max(12).optional()");
    expect(routes).toContain('syncFirebaseProfileContext(request, env, input)');
    expect(routes).toContain('expectedAuthorId && metadataVisibility !== \'public\'');
    expect(routes).toContain('verifiedPostIds.push(...synced.map((entry) => entry.postId))');
    expect(handler).toContain('verifiedPostIds = syncedPostIds');
    expect(routes).toContain("mask.fieldPaths', fieldPath");
    expect(profileClient).toContain("buildExploreRouteHash(`@${username.replace(/^@/, '')} `, 'posts', profileId)");
    expect(profileClient).not.toContain('profile-search-panel');
    expect(profileClient).not.toContain('aiWorkerFetch(`/api/profiles/${encodeURIComponent(profileId)}?query=${encodeURIComponent(query)}`)');
  });

  it('records bounded fallback, upstream timing, and redacted context audit evidence', () => {
    expect(executor).toContain('preloadSnapshots');
    expect(executor).toContain('ai_endpoint_snapshot_probe');
    expect(executor).toContain('attemptSeconds');
    expect(executor).toContain('ai_context_dispatch_audit');
    expect(executor).toContain('bodyLogged: false');
    expect(executor).toContain('malformedRetryUsed');
    expect(executor).toContain('one_concise_safe_retry');
    expect(worker).toContain("event: 'ai_openrouter_timing'");
    expect(worker).toContain('headersMs');
    expect(worker).toContain('bodyReadMs');
    expect(worker).toContain('finishReason');
  });

  it('persists redacted per-attempt fallback evidence with an expiry', () => {
    expect(attemptAuditMigration).toContain('CREATE TABLE IF NOT EXISTS ai_generation_attempt_audit');
    expect(attemptAuditMigration).toContain('PRIMARY KEY(request_id, attempt_ordinal)');
    expect(attemptAuditMigration).toContain('expires_at');
    expect(executor).toContain('recordAttemptAudit');
    expect(executor).toContain('ai_generation_attempt_audit');
    expect(executor).toContain('attempt.fallbackEligible ? 1 : 0');
    expect(executor).toContain('bodyLogged: false');
    expect(executor).toContain('piiLogged: false');
    expect(cache).toContain('DELETE FROM ai_generation_attempt_audit WHERE expires_at < ?');
  });

  it('does not inject synthetic/test posts or expose test-only E2E controls in production UI', () => {
    expect(exploreClient).not.toContain('getSyntheticAskAiSmokePost');
    expect(exploreClient).not.toContain('SYNTHETIC_ASK_AI_SMOKE_POST_ID');
    expect(client).not.toContain("openAskAiDialog('ask_ai_smoke_public_20260831'");
    expect(profileClient).not.toContain('Synthetic Text E2E');
    expect(profileClient).not.toContain('Synthetic Vision E2E');
    expect(handler).not.toContain('adminVisionSmoke');
    expect(handler).toContain("event: 'ai_rate_limit_checked'");
    expect(handler).toContain("event: 'ai_rate_limit_binding_unavailable'");
    expect(handler).toContain("event: 'ai_rate_limit_persistence_unavailable'");
    expect(handler).not.toContain('rateLimitKey });');
    expect(rateLimit).toContain('ai_interaction_rate_limits');
    expect(rateLimit).toContain('RETURNING request_count');
    expect(rateLimit).toContain('hmacSha256');
  });

  it('persists only redacted zero-cost routing evidence after a real upstream response', () => {
    expect(routingAuditMigration).toContain('CREATE TABLE IF NOT EXISTS ai_generation_routing_audit');
    expect(routingAuditMigration).toContain('CHECK (byok = 0)');
    expect(routingAuditMigration).toContain('CHECK (attempt = 1)');
    expect(routingAuditMigration).toContain('CHECK (reported_cost = 0)');
    expect(routingAuditMigration).toContain("CHECK (cost_verification = 'ZERO')");
    expect(executor).toContain("INSERT OR REPLACE INTO ai_generation_routing_audit");
    expect(executor).toContain('finalRoutingAudit.actualModel');
    expect(executor).toContain('finalRoutingAudit.actualProvider');
    expect(executor).toContain('finalRoutingAudit.reportedCost');
    expect(executor).toContain("ai_routing_audit_write_failed");
    const auditBlock = executor.slice(executor.indexOf('INSERT OR REPLACE INTO ai_generation_routing_audit'), executor.indexOf('return {', executor.indexOf('INSERT OR REPLACE INTO ai_generation_routing_audit')));
    expect(auditBlock).not.toContain('question');
    expect(auditBlock).not.toContain('contextJson');
  });

  it('preserves coordinator error codes and logs a correlation-safe failure event', () => {
    expect(handler).toContain("event: 'ai_generation_request_failed'");
    expect(handler).toContain('return coordinatorFailure({ route: \'post\'');
    expect(handler).toContain('return coordinatorFailure({ route: \'profile\'');
    expect(coordinatorSource).toContain("event: 'ai_coordinator_generation_failed'");
    expect(coordinatorSource).toContain('retryAfter: value.retryAfter');
  });

  it('never creates an eleventh daily generation reservation', () => {
    expect(quota).toContain('WHERE generation_reserved + generation_committed < 10');
    expect(quota).toContain("SELECT ?,?,?, 'RESERVED',?,? WHERE changes() = 1");
    expect(quota).not.toContain('bucket_start=?) <= 10');
  });

  it('persists predeploy progress, publishes safe 429 diagnostics, and bounds sequential retries', () => {
    expect(predeploy).toContain("response.status === 429");
    expect(predeploy).toContain("controlFetch(env, '/breaker/open'");
    expect(predeploy).toContain("const TEXT_POLICY_KEYS: readonly ModelKey[] = ['lingVl', 'glm52', 'dots', 'gemma31', 'gemma26']");
    expect(predeploy).toContain('attemptedEndpoints.has(tag)');
    expect(predeploy).toContain('await saveSnapshot(db, snapshotId');
    expect(predeploy).toContain('const REQUESTED_TEXT_POLICY_KEYS: readonly ModelKey[] = [...MODEL_CHAINS.text]');
    expect(predeploy).not.toContain('await env.DB.batch(snapshots.map');
    expect(predeploy).toContain('await smoke(context, env.OPENROUTER_API_KEY');
    expect(predeploy).toContain("openRouterFetch(context, `${OPENROUTER_BASE}/key`");
    expect(predeploy).not.toContain("data['label']");
    expect(predeploy).not.toContain("data['creator_user_id']");
    expect(routes).toContain("headers['Retry-After']");
    expect(predeploy).toContain('ai_predeploy_progress');
    expect(predeploy).toContain('requestOrdinal');
    expect(predeploy).toContain('rateLimitHeaders');
    expect(predeploy).toContain('async function requiredJson');
    expect(predeploy).toContain("throw new AiPredeployError(`${operation}_INVALID_JSON`)");
    expect(predeploy).toContain("state: 'SKIPPED_ENDPOINT_API_UNAVAILABLE'");
    expect(predeploy).toContain("state: 'SKIPPED_ENDPOINT_API_MALFORMED'");
    expect(predeploy).toContain("if ([401, 402, 403].includes(response.status))");
    expect(predeploy).toContain('// A 429 is a chain stop.');
    expect(predeploy).toContain("state: 'SKIPPED_SMOKE_FAILURE'");
    expect(predeploy).toContain('while the runtime key or provider is explicitly cooling down.');
    expect(predeploy).toMatch(/while the runtime key or provider is explicitly cooling down\.[\s\S]*throw cause;/);
    expect(predeploy).not.toContain("state: 'CIRCUIT_OPEN_RATE_LIMITED', diagnostic: cause.diagnostic });\n        continue;");
    expect(client).not.toContain('const maximumRetries');
    expect(client).not.toContain('while (true)');
    expect(client).toContain("authorizedFetch('/api/admin/ai/predeploy', { method: 'POST' })");
    expect(client).toContain("authorizedFetch('/api/admin/ai/predeploy', { method: 'POST' })");
  });
});

describe('Ask AI predeploy cooldown parsing', () => {
  it('respects seconds and HTTP-date Retry-After values with a safe minimum', () => {
    expect(retryAfterSeconds('120', 0)).toBe(120);
    expect(retryAfterSeconds('0', 0)).toBe(60);
    expect(retryAfterSeconds('Thu, 01 Jan 1970 00:05:00 GMT', 0)).toBe(300);
    expect(retryAfterSeconds('invalid', 0)).toBeNull();
  });
});
