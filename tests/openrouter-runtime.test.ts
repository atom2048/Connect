import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiUpstreamError, callOpenRouter } from '../worker/ai/openrouter';
import type { ApprovedEndpointSnapshot } from '../worker/ai/types';
import type { Env } from '../worker/types';
import { answerMatchesQuestionLanguage, buildSystemPrompt, detectQuestionLanguage, systemPromptDigest } from '../worker/ai/prompt';

const snapshot: ApprovedEndpointSnapshot = {
  requestedModel: 'z-ai/glm-5.2:free',
  canonicalModel: 'z-ai/glm-5.2:free',
  providerModel: 'z-ai/glm-5.2:free',
  providerBaseSlug: 'Decart',
  providerEndpointSlug: 'decart/fp4',
  trainingAllowed: false,
  retention: { type: 'zdr' },
  pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
  supportedParameters: ['response_format', 'structured_outputs', 'max_tokens'],
  verifiedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T12:00:00.000Z',
  generationPolicyVersion: 'unit-test',
};

function input(overrides: Partial<Parameters<typeof callOpenRouter>[0]> = {}): Parameters<typeof callOpenRouter>[0] {
  return {
    env: { OPENROUTER_API_KEY: 'unit-test-worker-secret' } as Env,
    key: 'glm52',
    snapshot,
    privacyClass: 'PUBLIC_AI',
    question: '要点を教えてください。',
    contextJson: '{"sources":[]}',
    images: [],
    timeoutMs: 100,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: 'unit-generation',
    model: 'z-ai/glm-5.2:free',
    choices: [{ message: { content: JSON.stringify({ answer: '安全なテスト回答', citedRefs: [], insufficientContext: false }) } }],
    usage: { cost: 0 },
    openrouter_metadata: {
      attempt: 1,
      is_byok: false,
      provider_slug: 'decart/fp4',
      endpoints: { available: [{ selected: true, provider_slug: 'decart/fp4' }] },
    },
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter Worker request boundary', () => {
  it('detects question language without being confused by quoted source text or code', () => {
    expect(detectQuestionLanguage('この投稿の内容を要約してください。')).toBe('ja');
    expect(detectQuestionLanguage('OpenRouterでこの投稿を要約してください。')).toBe('ja');
    expect(detectQuestionLanguage('What does “こんにちは” mean?')).toBe('en');
    expect(detectQuestionLanguage('What does こんにちは mean?')).toBe('en');
    expect(detectQuestionLanguage('```日本語のコードコメント``` Explain this post.')).toBe('en');
    expect(detectQuestionLanguage('概要?')).toBe('ja');
  });

  it('creates language-specific system instructions and includes them in the prompt digest', async () => {
    expect(buildSystemPrompt('この投稿を説明してください。')).toContain('RESPONSE_LANGUAGE: Japanese (ja)');
    expect(buildSystemPrompt('What does this post say?')).toContain('RESPONSE_LANGUAGE: English (en)');
    expect(buildSystemPrompt('この投稿を説明してください。')).toContain('自然で読みやすい日本語');
    expect(await systemPromptDigest()).toHaveLength(64);
  });

  it('rejects English prose for Japanese questions while allowing Japanese, code, and verbatim quotes', () => {
    expect(answerMatchesQuestionLanguage('この投稿を要約してください。', 'この投稿は青い三角形について説明しています。')).toBe(true);
    expect(answerMatchesQuestionLanguage('この投稿を要約してください。', 'The post describes a blue triangle.')).toBe(false);
    expect(answerMatchesQuestionLanguage('この投稿を要約してください。', '「Blue triangle」という表現が使われています。')).toBe(true);
    expect(answerMatchesQuestionLanguage('この投稿を要約してください。', '`POST /api/profile`')).toBe(true);
    expect(answerMatchesQuestionLanguage('What is shown in the post?', 'The post describes a blue triangle.')).toBe(true);
    expect(answerMatchesQuestionLanguage('What is shown in the post?', '投稿には青い三角形があります。')).toBe(false);
  });

  it('uses the canonical server endpoint and returns only explicitly zero-cost answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenRouter(input());

    expect(result.answer.answer).toBe('安全なテスト回答');
    expect(result.routingAudit).toMatchObject({ actualModel: 'z-ai/glm-5.2:free', actualProvider: 'decart/fp4', byok: false, attempt: 1, reportedCost: 0, costVerification: 'ZERO' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer unit-test-worker-secret');
    expect(headers.get('Content-Type')).toBe('application/json');
    const body = JSON.parse(String(init.body)) as { provider: { allow_fallbacks: boolean; max_price: Record<string, number> } };
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0, request: 0, image: 0 });
  });

  it('recovers one missing inline router metadata response from the generation record', async () => {
    const completion = Response.json({
      id: 'unit-generation-fallback-audit',
      model: 'z-ai/glm-5.2:free',
      choices: [{ message: { content: JSON.stringify({ answer: '監査復旧回答', citedRefs: [], insufficientContext: false }) } }],
      usage: { cost: 0 },
    });
    const generation = Response.json({
      data: {
        id: 'unit-generation-fallback-audit',
        model: 'z-ai/glm-5.2:free',
        provider_name: 'Decart',
        is_byok: false,
        total_cost: 0,
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion)
      .mockResolvedValueOnce(generation);
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenRouter(input());

    expect(result.answer.answer).toBe('監査復旧回答');
    expect(result.routingAudit).toMatchObject({ actualModel: 'z-ai/glm-5.2:free', actualProvider: 'Decart', byok: false, attempt: 1, reportedCost: 0, costVerification: 'ZERO' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[1] as [string])[0])).toBe('https://openrouter.ai/api/v1/generation?id=unit-generation-fallback-audit');
  });

  it('normalizes provider content parts and fenced JSON before schema validation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse({
      choices: [{ message: { content: [{ type: 'text', text: '```json\n{"answer":"Vision形式の回答","citedRefs":[],"insufficientContext":false}\n```' }] } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenRouter(input());

    expect(result.answer.answer).toBe('Vision形式の回答');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adapts a completed non-JSON assistant sentence without retrying it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse({
      choices: [{ message: { content: '画像からは旅行先の風景が読み取れます。' }, finish_reason: 'stop' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenRouter(input());

    expect(result.answer).toMatchObject({ answer: '画像からは旅行先の風景が読み取れます。', citedRefs: [], insufficientContext: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the Japanese question language in compact request bodies too', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);

    await callOpenRouter(input({ question: 'この投稿の要点を日本語で説明してください。', compact: true }));

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].content).toContain('RESPONSE_LANGUAGE: Japanese (ja)');
    expect(body.messages[0].content).toContain('RETRY_INSTRUCTION');
    expect(body.messages[0].content).toContain('Continue to obey the RESPONSE_LANGUAGE rule above');
  });

  it('keeps Japanese as the response language when the post context is English', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse({
      choices: [{ message: { content: JSON.stringify({ answer: 'この投稿は、地域の図書館について説明しています。', citedRefs: [], insufficientContext: false }) } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await callOpenRouter(input({
      question: 'この投稿の内容を要約してください。',
      contextJson: JSON.stringify({ posts: [{ ref: 'P0', text: 'The community library will open at 10 AM on Saturday.' }] }),
    }));

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].content).toContain('RESPONSE_LANGUAGE: Japanese (ja)');
    expect(JSON.stringify(body.messages[1].content)).toContain('The community library will open at 10 AM on Saturday.');
  });

  it('uses English for English questions and accepts an English model answer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse({
      choices: [{ message: { content: JSON.stringify({ answer: 'The post describes a blue triangle.', citedRefs: [], insufficientContext: false }) } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenRouter(input({ question: 'What shape is described in this post?' }));

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0].content).toContain('RESPONSE_LANGUAGE: English (en)');
    expect(result.answer.answer).toBe('The post describes a blue triangle.');
  });

  it.each([
    ['json', JSON.stringify({ answer: 'The post describes a blue triangle.', citedRefs: [], insufficientContext: false })],
    ['plain text', 'The post describes a blue triangle.'],
  ])('rejects a %s English answer to a Japanese question so the executor can fallback', async (_format, content) => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse({
      choices: [{ message: { content }, finish_reason: 'stop' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenRouter(input({ question: 'この投稿には何が写っていますか？' }))).rejects.toMatchObject({
      code: 'MODEL_LANGUAGE_MISMATCH',
      fallbackEligible: true,
      diagnostic: 'QUESTION_LANGUAGE_MISMATCH',
    });
  });

  it.each([
    ['json', JSON.stringify({ answer: 'この画像には、以下の図形と文字があります：', citedRefs: [], insufficientContext: false })],
    ['plain text', 'この画像には、以下の図形と文字があります：'],
  ])('routes a visually incomplete %s answer through the finite fallback chain', async (_format, content) => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse({
      choices: [{ message: { content }, finish_reason: 'stop' }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenRouter(input({
      images: [{ ref: 'm1', belongsTo: 'p1', position: 0, dataUrl: 'data:image/webp;base64,AA==', binaryBytes: 1, animatedTruncated: false }],
    }))).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_MALFORMED',
      fallbackEligible: true,
      diagnostic: 'TRAILING_COLON',
      finishReason: 'stop',
    });
  });

  it('uses the pinned zero-cost request contract when free multimodal metadata is 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successResponse({ openrouter_metadata: undefined }))
      .mockResolvedValueOnce(new Response('{"error":{"message":"Resource not found"}}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenRouter(input());

    expect(result.routingAudit).toMatchObject({ actualModel: 'z-ai/glm-5.2:free', actualProvider: 'decart/fp4', byok: false, attempt: 1, reportedCost: 0, costVerification: 'ZERO' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, 'OPENROUTER_UNAUTHORIZED', 502],
    [402, 'OPENROUTER_PAYMENT_REQUIRED', 503],
    [403, 'OPENROUTER_FORBIDDEN', 502],
    [429, 'OPENROUTER_RATE_LIMIT', 429],
    [503, 'OPENROUTER_SERVER_ERROR', 503],
  ])('classifies OpenRouter HTTP %i without exposing upstream bodies', async (status, code, expectedStatus) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"upstream failure"}}', { status, headers: { 'content-type': 'application/json', 'retry-after': '5' } })));

    await expect(callOpenRouter(input())).rejects.toMatchObject({
      code,
      status: expectedStatus,
      ...(status === 503 ? { fallbackEligible: true } : {}),
      ...(status === 429 ? { fallbackEligible: true, retryAfter: 60 } : {}),
    });
  });

  it('distinguishes an empty Worker Secret, transport failure, malformed choices, and unknown cost', async () => {
    await expect(callOpenRouter(input({ env: { OPENROUTER_API_KEY: '' } as Env }))).rejects.toMatchObject({ code: 'AI_PROVIDER_CONFIGURATION_MISSING' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
    await expect(callOpenRouter(input())).rejects.toMatchObject({ code: 'OPENROUTER_TRANSPORT_FAILURE', fallbackEligible: true });
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({ choices: [] })));
    await expect(callOpenRouter(input())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_MALFORMED', fallbackEligible: true });
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({
      choices: [{ message: { content: '{"answer":"truncated"' }, finish_reason: 'length' }],
    })));
    await expect(callOpenRouter(input())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_MALFORMED', finishReason: 'length' });
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({ usage: {} })));
    await expect(callOpenRouter(input())).rejects.toMatchObject({ code: 'AI_BILLING_POLICY_VIOLATION' });
  });

  it('uses a bounded concise JSON retry body when explicitly requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    await callOpenRouter(input({ compact: true }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { messages: Array<{ content: string }>; max_tokens: number };
    expect(body.max_tokens).toBe(1_200);
    expect(body.messages[0].content).toContain('RETRY_INSTRUCTION');
  });

  it('honors an explicit model-bounded multimodal profile token budget in compact mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    vi.stubGlobal('fetch', fetchMock);
    await callOpenRouter(input({ compact: true, maxTokens: 1_600 }));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(1_600);
  });

  it('turns an elapsed AbortSignal deadline into a timeout code', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
    })));

    await expect(callOpenRouter(input({ timeoutMs: 5 }))).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', status: 504 });
  });

  it('keeps the error payload to a safe classification code', () => {
    const error = new AiUpstreamError('OPENROUTER_UNAUTHORIZED', 502);
    expect(error.message).toBe('OPENROUTER_UNAUTHORIZED');
  });
});
