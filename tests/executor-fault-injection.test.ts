import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../worker/types';
import type { ApprovedEndpointSnapshot, GenerationRequest } from '../worker/ai/types';

vi.mock('../worker/ai/context', () => ({
  revalidateManifest: vi.fn(),
  serializeContext: vi.fn(),
}));

vi.mock('../worker/ai/control-plane', () => ({
  controlFetch: vi.fn(),
}));

vi.mock('../worker/ai/media', () => ({
  materializeImages: vi.fn(),
}));

vi.mock('../worker/ai/quota', () => ({
  commitGeneration: vi.fn(),
  commitUserBurn: vi.fn(),
  userBurnAvailable: vi.fn(),
}));

vi.mock('../worker/ai/openrouter', async () => {
  const actual = await vi.importActual<typeof import('../worker/ai/openrouter')>('../worker/ai/openrouter');
  return { ...actual, callOpenRouter: vi.fn(), endpointSnapshot: vi.fn() };
});

const { executeGeneration } = await import('../worker/ai/executor');
const { revalidateManifest, serializeContext } = await import('../worker/ai/context');
const { controlFetch } = await import('../worker/ai/control-plane');
const { materializeImages } = await import('../worker/ai/media');
const { commitGeneration, commitUserBurn, userBurnAvailable } = await import('../worker/ai/quota');
const { AiUpstreamError, callOpenRouter, endpointSnapshot } = await import('../worker/ai/openrouter');

const mockedRevalidate = vi.mocked(revalidateManifest);
const mockedSerialize = vi.mocked(serializeContext);
const mockedControlFetch = vi.mocked(controlFetch);
const mockedMaterialize = vi.mocked(materializeImages);
const mockedCommitGeneration = vi.mocked(commitGeneration);
const mockedCommitUserBurn = vi.mocked(commitUserBurn);
const mockedUserBurnAvailable = vi.mocked(userBurnAvailable);
const mockedCallOpenRouter = vi.mocked(callOpenRouter);
const mockedEndpointSnapshot = vi.mocked(endpointSnapshot);

function fakeDb(): D1Database {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  return {
    prepare: vi.fn(() => statement),
  } as unknown as D1Database;
}

function snapshot(model: string): ApprovedEndpointSnapshot {
  return {
    requestedModel: `${model}/model:free`,
    canonicalModel: `${model}/model:free`,
    providerModel: `${model}/model:free`,
    providerBaseSlug: `${model}-provider`,
    providerEndpointSlug: `${model}/fp8`,
    trainingAllowed: false,
    retention: model === 'lingVl' ? { type: 'zdr' as const } : { type: 'retained' as const },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    supportedParameters: ['max_tokens'],
    verifiedAt: '2026-09-22T00:00:00.000Z',
    expiresAt: '2026-09-23T00:00:00.000Z',
    generationPolicyVersion: `unit-${model}`,
  };
}

const image = {
  ref: 'I0_0',
  belongsTo: 'P0',
  position: 1,
  dataUrl: 'data:image/webp;base64,AA==',
  binaryBytes: 1,
  animatedTruncated: false,
};

const request = {
  viewerId: 'synthetic-viewer',
  deliveryRequestId: 'fault-injection-request',
  generationReservationId: 'reservation-1',
  question: '画像を含めて要点を教えてください。',
  locale: 'ja-JP',
  semanticFingerprint: 'fingerprint-1',
  mediaUsageMode: 'VISION_REQUIRED',
  mediaTarget: 'CURRENT_POST',
  inputRisk: 'CLEAR',
  selectedMedia: [{
    ref: 'I0_0', belongsTo: 'P0', position: 1, objectKey: 'synthetic/image.webp', sha256: null,
    mimeType: 'image/webp', bytes: 1, animated: false, sourceRelation: 'current', sourceVisibility: 'public',
    mediaVersion: 1, allowedByConsent: true,
  }],
  deadlineAt: Date.now() + 60_000,
  manifest: {
    subjectType: 'post', subjectId: 'post-1', currentPostId: 'post-1', currentAuthorId: 'author-1',
    sources: [{
      ref: 'P0', actualId: 'post-1', type: 'post', relation: 'current', authorId: 'author-1', visibility: 'public',
      text: '安全な合成本文', order: 0, allowText: true, allowMedia: true,
      contentVersion: 1, accessVersion: 1, mediaVersion: 1, structureVersion: 1,
      authorPreferenceVersion: 1, postConsentVersion: 1, acceptedPolicyVersion: 'connect-ai-policy-v1',
    }],
    media: [{
      ref: 'I0_0', belongsTo: 'P0', position: 1, objectKey: 'synthetic/image.webp', sha256: null,
      mimeType: 'image/webp', bytes: 1, animated: false, sourceRelation: 'current', sourceVisibility: 'public',
      mediaVersion: 1, allowedByConsent: true,
    }],
    privacyClass: 'PUBLIC_AI', contextTruncated: false, authorConsentVector: 'consent-vector',
  },
} satisfies GenerationRequest;

function successResult(generationId = 'generation-fallback') {
  return {
    answer: { answer: 'fallback後の安全な回答', citedRefs: ['P0'], insufficientContext: false },
    routingAudit: {
      actualModel: 'lingVl/model:free', actualProvider: 'lingVl-provider', byok: false as const,
      attempt: 1 as const, reportedCost: 0, costVerification: 'ZERO' as const,
    },
    generationId,
  };
}

function testEnv(): Env {
  return { DB: fakeDb(), AI_ENVIRONMENT: 'test', OPENROUTER_API_KEY: 'synthetic-key' } as unknown as Env;
}

function controlPathCalls(): string[] {
  return mockedControlFetch.mock.calls.map(([, path]) => path);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRevalidate.mockResolvedValue(true);
  mockedSerialize.mockReturnValue('{"posts":[{"ref":"P0","text":"safe"}]}');
  mockedMaterialize.mockResolvedValue([image]);
  mockedCommitGeneration.mockResolvedValue(true);
  mockedCommitUserBurn.mockResolvedValue(true);
  mockedUserBurnAvailable.mockResolvedValue(true);
  mockedEndpointSnapshot.mockImplementation(async (_db, model) => {
    if (model === 'dots' || model === 'lingVl') return snapshot(model);
    throw new AiUpstreamError('AI_MODEL_UNAVAILABLE', 503, false, undefined, 'SNAPSHOT_MISSING');
  });
  let lease = 0;
  mockedControlFetch.mockImplementation(async (_env, path) => {
    if (path === '/runtime') return Response.json({ enabled: true, hardStopReason: null, imagesAvailable: true });
    if (path === '/permit/reserve') return Response.json({ ok: true, leaseId: `lease-${++lease}`, pressure: 0.1 });
    return Response.json({ ok: true });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executor provider fault injection', () => {
  it.each([
    ['OPENROUTER_RATE_LIMIT', 429, 60],
    ['OPENROUTER_SERVER_ERROR', 503, undefined],
    ['MODEL_TIMEOUT', 504, undefined],
  ] as const)('falls back once after %s and records the breaker path', async (code, status, retryAfter) => {
    mockedCallOpenRouter
      .mockRejectedValueOnce(new AiUpstreamError(code, status, true, retryAfter))
      .mockResolvedValueOnce(successResult());

    const result = await executeGeneration(testEnv(), request, new AbortController().signal);

    expect(result.response.answer).toBe('fallback後の安全な回答');
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(2);
    expect(mockedCommitGeneration).toHaveBeenCalledTimes(1);
    expect(controlPathCalls()).toContain('/breaker/sample');
    const failedSamples = mockedControlFetch.mock.calls.filter(([, path, body]) => path === '/breaker/sample' && (body as { failed?: boolean }).failed === true);
    if (code === 'OPENROUTER_RATE_LIMIT') {
      expect(failedSamples).toHaveLength(0);
      expect(controlPathCalls()).toContain('/breaker/open');
    } else {
      expect(failedSamples).toHaveLength(1);
      expect(controlPathCalls()).not.toContain('/breaker/open');
    }
  });

  it.each(['text', 'vision', 'profile'] as const)('preserves the Japanese question through a language-mismatch fallback for %s', async (route) => {
    const question = 'この投稿の内容を日本語で説明してください。';
    const routeRequest: GenerationRequest = route === 'text'
      ? { ...request, question, mediaUsageMode: 'TEXT_ONLY', selectedMedia: [], manifest: { ...request.manifest, media: [] } }
      : route === 'profile'
        ? { ...request, question, manifest: { ...request.manifest, subjectType: 'profile', subjectId: 'profile-1', currentPostId: 'profile-1' }, mediaTarget: 'ALL_RELEVANT' }
        : { ...request, question };
    mockedCallOpenRouter
      .mockRejectedValueOnce(new AiUpstreamError('MODEL_LANGUAGE_MISMATCH', 503, true, undefined, 'QUESTION_LANGUAGE_MISMATCH'))
      .mockResolvedValueOnce(successResult(`generation-language-${route}`));

    const result = await executeGeneration(testEnv(), routeRequest, new AbortController().signal);

    expect(result.response.answer).toBe('fallback後の安全な回答');
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(2);
    expect(mockedCallOpenRouter.mock.calls.map(([call]) => call.question)).toEqual([question, question]);
  });

  it('retries finish_reason:length once in concise mode without entering a retry loop', async () => {
    mockedCallOpenRouter
      .mockRejectedValueOnce(new AiUpstreamError('MODEL_OUTPUT_MALFORMED', 503, true, undefined, undefined, 'length'))
      .mockResolvedValueOnce(successResult('generation-concise-retry'));

    const result = await executeGeneration(testEnv(), request, new AbortController().signal);

    expect(result.response.answer).toBe('fallback後の安全な回答');
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(2);
    expect(mockedCallOpenRouter.mock.calls[0][0]).toMatchObject({ key: 'dots', compact: false });
    expect(mockedCallOpenRouter.mock.calls[1][0]).toMatchObject({ key: 'dots', compact: true });
  });

  it('gives profile vision the bounded multimodal completion budget instead of the text cap', async () => {
    mockedCallOpenRouter.mockResolvedValueOnce(successResult('generation-profile-vision'));
    const profileVisionRequest: GenerationRequest = {
      ...request,
      manifest: { ...request.manifest, subjectType: 'profile', subjectId: 'profile-1', currentPostId: 'profile-1' },
      mediaTarget: 'ALL_RELEVANT',
    };

    const result = await executeGeneration(testEnv(), profileVisionRequest, new AbortController().signal);

    expect(result.response.answer).toBe('fallback後の安全な回答');
    expect(mockedCallOpenRouter.mock.calls[0][0]).toMatchObject({ key: 'dots', compact: true, maxTokens: 3_200 });
  });

  it('stops after the finite approved chain when every provider fails', async () => {
    mockedCallOpenRouter.mockRejectedValue(new AiUpstreamError('OPENROUTER_SERVER_ERROR', 503, true));

    await expect(executeGeneration(testEnv(), request, new AbortController().signal)).rejects.toMatchObject({ code: 'OPENROUTER_SERVER_ERROR' });
    expect(mockedCallOpenRouter).toHaveBeenCalledTimes(2);
  });
});
