import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';
import type { VersionedContextManifest } from '../worker/ai/types';

vi.mock('../worker/auth', () => ({
  getViewer: vi.fn(),
  getViewerOrAnonymous: vi.fn(async () => ({
    viewer: { id: 'synthetic-viewer', name: 'Synthetic viewer', email: 'viewer@example.invalid' },
    rateLimitKey: 'synthetic-rate-key',
    anonymous: false,
  })),
}));

vi.mock('../worker/ai/context', async () => {
  const actual = await vi.importActual<typeof import('../worker/ai/context')>('../worker/ai/context');
  return {
    ...actual,
    buildContextManifest: vi.fn(),
    buildProfileContextManifest: vi.fn(),
    revalidateManifest: vi.fn(),
  };
});

vi.mock('../worker/ai/control-plane', () => ({ controlFetch: vi.fn() }));
vi.mock('../worker/ai/cache', () => ({ readPublicCache: vi.fn(async () => null), savePublicCache: vi.fn(), cleanupAiStorage: vi.fn() }));
vi.mock('../worker/ai/quota', () => ({
  releaseGeneration: vi.fn(async () => undefined),
  reserveGeneration: vi.fn(async () => 'synthetic-reservation'),
  commitGeneration: vi.fn(async () => true),
  userBurnAvailable: vi.fn(async () => true),
}));
vi.mock('../worker/ai/rate-limit', () => ({
  interactionRateLimitKeys: vi.fn(() => ['synthetic-viewer']),
  persistentInteractionRateLimit: vi.fn(async () => true),
}));

const { askAi, profileAskAi } = await import('../worker/ai/handler');
const { buildContextManifest, buildProfileContextManifest } = await import('../worker/ai/context');
const { controlFetch } = await import('../worker/ai/control-plane');
const { reserveGeneration } = await import('../worker/ai/quota');

type ApiCase = {
  name: string;
  status: number;
  visibility: string;
  ownerId: string;
  viewAllowed: boolean;
  deletedAt?: number | null;
  textAllowed?: boolean;
  mediaAllowed?: boolean;
  mediaMode?: 'exclude' | 'include';
  firestoreVerified?: boolean;
};

function fakeDb(testCase: ApiCase): Env['DB'] {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('INSERT INTO ai_interaction_rate_limits')) return { request_count: 1 };
              if (sql.includes('SELECT 1 AS ready FROM ai_endpoint_snapshots')) return { ready: 1 };
              if (sql.includes('SELECT p.author_id,p.visibility,p.deleted_at,p.body')) return {
                author_id: testCase.ownerId,
                visibility: testCase.visibility,
                deleted_at: testCase.deletedAt ?? null,
                body: `synthetic-${testCase.name}`,
                text_analysis: testCase.textAllowed === false ? 'DISABLED' : 'PUBLIC_ONLY',
                media_analysis: testCase.mediaAllowed === false ? 'DISABLED' : 'PUBLIC_ONLY',
                post_text_analysis: testCase.textAllowed === false ? 'DISABLED' : null,
                post_media_analysis: testCase.mediaAllowed === false ? 'DISABLED' : null,
              };
              if (sql.includes('SELECT 1 AS allowed FROM posts p WHERE p.id=?')) return testCase.viewAllowed ? { allowed: 1 } : null;
              return null;
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
}

function manifest(testCase: ApiCase): VersionedContextManifest {
  return {
    subjectType: 'post',
    subjectId: 'synthetic-post',
    currentPostId: 'synthetic-post',
    currentAuthorId: testCase.ownerId,
    sources: [{
      ref: 'P0', actualId: 'synthetic-post', type: 'post', relation: 'current', authorId: testCase.ownerId,
      visibility: testCase.visibility, text: testCase.textAllowed === false ? '' : '合成投稿の本文', order: 0,
      allowText: testCase.textAllowed !== false, allowMedia: testCase.mediaAllowed !== false,
      contentVersion: 1, accessVersion: 1, mediaVersion: 1, structureVersion: 1,
      authorPreferenceVersion: 1, postConsentVersion: 1, acceptedPolicyVersion: 'synthetic-policy',
    }],
    media: testCase.mediaAllowed === false ? [] : [{
      ref: 'I0_0', belongsTo: 'P0', position: 1, objectKey: 'synthetic/image.webp', sha256: null,
      mimeType: 'image/webp', bytes: 1, animated: false, sourceRelation: 'current', sourceVisibility: testCase.visibility,
      mediaVersion: 1, allowedByConsent: true,
    }],
    privacyClass: testCase.visibility === 'private' ? 'PRIVATE_AI' : testCase.visibility === 'friends' ? 'LIMITED_AI' : 'PUBLIC_AI',
    contextTruncated: false,
    authorConsentVector: 'synthetic-consent-vector',
  };
}

function testEnv(testCase: ApiCase): Env {
  return {
    DB: fakeDb(testCase),
    AI_GENERATION_ENABLED: 'true', AI_TEXT_READY: 'true', AI_VISION_READY: 'true',
    AI_ADMIN_ONLY: 'true', AI_ADMIN_USER_IDS: 'synthetic-viewer', AI_ENVIRONMENT: 'test',
    CONNECT_ALLOWED_ORIGINS: 'https://app.example.invalid', AI_ROLLOUT_PERCENT: '100',
    OPENROUTER_API_KEY: 'synthetic-only', AI_CONSENT_FINGERPRINT_SECRET: 'synthetic-only',
    AI_COORDINATOR_KEY_SECRET: 'synthetic-only', AI_FEEDBACK_SIGNING_SECRET: 'synthetic-only',
    AI_ROLLOUT_HASH_SECRET: 'synthetic-only', LOG_PSEUDONYM_MASTER_SECRET: 'synthetic-only',
  } as unknown as Env;
}

function request(body: { question: string; mediaMode?: 'exclude' | 'include' }, path = '/api/posts/synthetic-post/ask-ai'): Request {
  return new Request(`https://worker.example.invalid${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer synthetic-only',
      Origin: 'https://app.example.invalid',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildContextManifest).mockResolvedValue(null);
  vi.mocked(buildProfileContextManifest).mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe('Ask AI API authorization does not dispatch denied context', () => {
  it.each<ApiCase>([
    { name: 'other-public-blocked', status: 404, visibility: 'public', ownerId: 'other-user', viewAllowed: false, firestoreVerified: false },
    { name: 'other-private', status: 404, visibility: 'private', ownerId: 'other-user', viewAllowed: false, firestoreVerified: false },
    { name: 'other-limited-without-consent', status: 403, visibility: 'friends', ownerId: 'other-user', viewAllowed: true, firestoreVerified: false, textAllowed: false, mediaAllowed: false },
    { name: 'self-private-without-consent', status: 403, visibility: 'private', ownerId: 'synthetic-viewer', viewAllowed: true, firestoreVerified: false, textAllowed: false, mediaAllowed: false },
    { name: 'deleted-public', status: 404, visibility: 'public', ownerId: 'synthetic-viewer', viewAllowed: false, deletedAt: 123, firestoreVerified: false },
  ])('returns $status for $name and sends nothing upstream', async (testCase) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const accessLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostic = { visibility: testCase.visibility, ownerMatch: testCase.ownerId === 'synthetic-viewer', normalViewAllowed: testCase.viewAllowed, aiAllowed: false, imageConsentAllowed: false, denyReason: testCase.name };
    const ensurePost = vi.fn(async () => ({ synced: false, diagnostic }));

    const response = await askAi(request({ question: '合成投稿について教えて' }), testEnv(testCase), 'synthetic-post', 0, ensurePost);
    const payload = await response.json() as { requestId: string };

    expect(response.status).toBe(testCase.status);
    expect(payload.requestId).toBeTruthy();
    expect(ensurePost).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(buildContextManifest)).not.toHaveBeenCalled();
    expect(vi.mocked(controlFetch)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveGeneration)).not.toHaveBeenCalled();
    expect(accessLog).toHaveBeenCalledWith(expect.stringContaining(`"correlationId":"${payload.requestId}"`));
  });

  it('does not fall back to a stale public D1 row when Firestore freshness fails', async () => {
    const testCase: ApiCase = { name: 'stale-public', status: 403, visibility: 'public', ownerId: 'other-user', viewAllowed: true };
    vi.mocked(buildContextManifest).mockResolvedValue(manifest(testCase));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await askAi(request({ question: '古い合成投稿を要約して' }), testEnv(testCase), 'synthetic-post', 0, async () => ({ synced: false }));

    expect(response.status).toBe(403);
    expect(vi.mocked(buildContextManifest)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the Firestore source cannot be verified', async () => {
    const testCase: ApiCase = { name: 'source-timeout', status: 503, visibility: 'public', ownerId: 'other-user', viewAllowed: true };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await askAi(request({ question: '合成投稿について教えて' }), testEnv(testCase), 'synthetic-post', 0, async () => ({ synced: false, sourceUnavailable: true }));

    expect(response.status).toBe(503);
    expect(vi.mocked(buildContextManifest)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each<ApiCase>([
    { name: 'self-public', status: 503, visibility: 'public', ownerId: 'synthetic-viewer', viewAllowed: true, firestoreVerified: true },
    { name: 'other-public', status: 503, visibility: 'public', ownerId: 'other-user', viewAllowed: true, firestoreVerified: true },
    { name: 'friend-limited-with-explicit-consent', status: 503, visibility: 'friends', ownerId: 'other-user', viewAllowed: true, firestoreVerified: true },
    { name: 'self-private-with-explicit-consent', status: 503, visibility: 'private', ownerId: 'synthetic-viewer', viewAllowed: true, firestoreVerified: true },
  ])('passes permitted $name context through policy checks without sending in this unit test', async (testCase) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const currentManifest = manifest(testCase);
    vi.mocked(buildContextManifest).mockResolvedValue(currentManifest);

    const response = await askAi(request({ question: '合成投稿について教えて' }), testEnv(testCase), 'synthetic-post', 0, async () => ({ synced: true }));

    expect(response.status).toBe(testCase.status); // No coordinator binding is installed, so dispatch is refused.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns insufficient context, not an upstream request, when image consent is off', async () => {
    const testCase: ApiCase = { name: 'public-image-opt-out', status: 200, visibility: 'public', ownerId: 'other-user', viewAllowed: true, mediaAllowed: false };
    vi.mocked(buildContextManifest).mockResolvedValue(manifest(testCase));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await askAi(request({ question: 'この画像を説明して', mediaMode: 'include' }), testEnv(testCase), 'synthetic-post', 0, async () => ({ synced: true }));
    const payload = await response.json() as { insufficientContext: boolean; insufficientReason: string; requestId: string };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ insufficientContext: true, insufficientReason: 'MEDIA_ANALYSIS_NOT_ALLOWED' });
    expect(payload.requestId).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not analyze another profile when profile context is inaccessible', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await profileAskAi(request({ question: '合成プロフィールを要約して' }, '/api/profiles/synthetic-profile/ask-ai'), testEnv({ name: 'other-profile', status: 404, visibility: 'public', ownerId: 'other-profile', viewAllowed: false } ), 'synthetic-profile');
    const payload = await response.json() as { requestId: string };

    expect(response.status).toBe(404);
    expect(payload.requestId).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(buildProfileContextManifest)).toHaveBeenCalledOnce();
  });

  it.each([
    { sourceUnavailable: true, status: 503 },
    { sourceUnavailable: false, status: 404 },
  ])('fails closed for an unverified profile source ($status)', async ({ sourceUnavailable, status }) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await profileAskAi(
      request({ question: '合成プロフィールを要約して' }, '/api/profiles/synthetic-profile/ask-ai'),
      testEnv({ name: 'other-profile', status: 404, visibility: 'public', ownerId: 'other-profile', viewAllowed: false }),
      'synthetic-profile',
      0,
      async () => ({
        profileSynced: false,
        profileVerified: false,
        profileDenied: !sourceUnavailable,
        sourceUnavailable,
        requestedPostCount: 0,
        attemptedPostCount: 0,
        syncedPostCount: 0,
        skippedPostCount: 0,
        verifiedPostIds: [],
      }),
    );

    expect(response.status).toBe(status);
    expect(vi.mocked(buildProfileContextManifest)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
