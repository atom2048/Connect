import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../worker/auth', () => ({
  getViewer: vi.fn(async () => ({ auth: null, viewer: { id: 'synthetic-viewer', name: 'Synthetic viewer', email: '' } })),
}));

const { syncFirebasePost } = await import('../worker/index');

type SyncOptions = {
  ownerId?: string;
  visibility?: 'public' | 'friends' | 'private';
  existing?: { author_id: string; visibility: string; firestore_update_time: string | null; media_json?: string | null } | null;
  viewAllowed?: boolean;
  globalText?: string;
  globalMedia?: string;
  postText?: string;
  postMedia?: string;
  deleted?: boolean;
  body?: string;
  image?: boolean;
  r2Video?: boolean;
  r2Gif?: boolean;
};

function makeEnvironment(options: SyncOptions = {}) {
  let current = options.existing ? { ...options.existing } : null;
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    FIREBASE_PROJECT_ID: 'synthetic-project',
    MEDIA: { put: vi.fn(async () => undefined) },
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async first() {
                if (sql.includes('SELECT author_id,visibility,firestore_update_time,media_json FROM posts')) return current;
                if (sql.includes('SELECT 1 AS allowed')) return options.viewAllowed === false ? null : { allowed: 1 };
                if (sql.includes('SELECT accepted_policy_version,preference_version,text_analysis,media_analysis FROM ai_author_preferences')) {
                  return { accepted_policy_version: 'synthetic-policy', preference_version: 1, text_analysis: options.globalText || 'PUBLIC_ONLY', media_analysis: options.globalMedia || 'PUBLIC_ONLY' };
                }
                if (sql.includes('SELECT text_analysis,media_analysis FROM post_ai_consents')) {
                  return options.postText || options.postMedia
                    ? { text_analysis: options.postText || 'DISABLED', media_analysis: options.postMedia || 'DISABLED' }
                    : null;
                }
                return null;
              },
              async run() {
                writes.push({ sql, values });
                if (sql.includes('INSERT INTO posts(id, author_id, body')) {
                  current = {
                    author_id: String(values[1]),
                    visibility: String(values[3]),
                    media_json: String(values[4] ?? '[]'),
                    firestore_update_time: typeof values[15] === 'string' ? values[15] : null,
                  };
                }
                return { success: true, meta: { changes: 1 } };
              },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, writes, getCurrent: () => current };
}

function firestoreDocument(options: SyncOptions, includeBody: boolean) {
  const fields: Record<string, Record<string, unknown>> = {
    userId: { stringValue: options.ownerId || 'synthetic-author' },
    visibility: { stringValue: options.visibility || 'public' },
  };
  if (options.deleted) fields.deletedAt = { timestampValue: '2026-09-23T00:00:00Z' };
  if (includeBody) {
    fields.text = { stringValue: options.body || '合成テキスト投稿' };
    if (options.image) fields.imageURLs = { arrayValue: { values: [{ stringValue: 'https://firebasestorage.googleapis.com/v0/b/synthetic.invalid/o/synthetic.png' }] } };
    if (options.r2Video) {
      fields.videoURL = { stringValue: '/media/posts/synthetic-author/video-test.webm' };
      fields.attachments = { arrayValue: { values: [{ mapValue: { fields: {
        kind: { stringValue: 'video' },
        url: { stringValue: '/media/posts/synthetic-author/video-test.webm' },
        mimeType: { stringValue: 'video/webm' },
        storagePath: { stringValue: 'posts/synthetic-author/video-test.webm' },
      } } }] } };
    }
    if (options.r2Gif) {
      fields.imageURLs = { arrayValue: { values: [{ stringValue: '/media/posts/synthetic-author/animation.gif' }] } };
      fields.attachments = { arrayValue: { values: [{ mapValue: { fields: {
        kind: { stringValue: 'image' },
        url: { stringValue: '/media/posts/synthetic-author/animation.gif' },
        mimeType: { stringValue: 'image/gif' },
        storagePath: { stringValue: 'stale/client/key.gif' },
        previewUrl: { stringValue: '/media/posts/synthetic-author/animation_preview.webp' },
      } } }] } };
    }
  }
  return {
    name: 'projects/synthetic-project/databases/(default)/documents/posts/synthetic-post',
    updateTime: '2026-09-23T00:00:00.123456789Z',
    fields,
  };
}

function syntheticRequest(withBearer = true): Request {
  return new Request('https://worker.example.invalid/api/posts/synthetic-post/ask-ai', {
    headers: withBearer ? { Authorization: 'Bearer synthetic-firebase-token' } : {},
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Firestore post sync authorization and consent', () => {
  it.each([
    { name: 'other private post without ACL', visibility: 'private' as const, ownerId: 'synthetic-author', viewAllowed: false },
    { name: 'other limited post without friendship', visibility: 'friends' as const, ownerId: 'synthetic-author', viewAllowed: false },
    { name: 'public post blocked by ACL', visibility: 'public' as const, ownerId: 'synthetic-author', viewAllowed: false },
  ])('checks the D1 view ACL before fetching the full source for $name', async ({ visibility, ownerId, viewAllowed }) => {
    const { env } = makeEnvironment({ visibility, ownerId, viewAllowed });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(firestoreDocument({ visibility, ownerId }, false)), { status: 200 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-1', undefined, 4, true);

    expect(result.synced).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce(); // Masked metadata only; body/media are not fetched.
    expect(String(fetchSpy.mock.calls[0][0])).toContain('mask.fieldPaths=userId');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"correlationId":"correlation-synthetic-1"'));
  });

  it('refuses restricted source reads without a validated bearer', async () => {
    const { env } = makeEnvironment({ visibility: 'private', ownerId: 'synthetic-author' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(firestoreDocument({ visibility: 'private' }, false)), { status: 200 }));

    const result = await syncFirebasePost(syntheticRequest(false), env, 'synthetic-post', 'correlation-synthetic-2', undefined, 4, true);

    expect(result.synced).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('denies an author-owner mismatch without fetching content', async () => {
    const { env } = makeEnvironment({ visibility: 'public', ownerId: 'source-owner', existing: { author_id: 'different-owner', visibility: 'public', firestore_update_time: null } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(firestoreDocument({ visibility: 'public', ownerId: 'source-owner' }, false)), { status: 200 }));

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-3', undefined, 4, true);

    expect(result.synced).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('requires explicit author consent for private/limited context', async () => {
    const { env } = makeEnvironment({ visibility: 'private', ownerId: 'synthetic-viewer', viewAllowed: true, globalText: 'DISABLED', globalMedia: 'DISABLED' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(firestoreDocument({ visibility: 'private', ownerId: 'synthetic-viewer' }, false)), { status: 200 }));

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-4', undefined, 4, true);

    expect(result.synced).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    { visibility: 'friends' as const, ownerId: 'synthetic-author' },
    { visibility: 'private' as const, ownerId: 'synthetic-viewer' },
  ])('syncs a restricted post only when view ACL and explicit consent both pass ($visibility)', async ({ visibility, ownerId }) => {
    const { env, writes } = makeEnvironment({
      visibility, ownerId, viewAllowed: true,
      postText: 'AUTHORIZED_CONTEXT', postMedia: 'DISABLED',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const includeBody = !new URL(String(input)).searchParams.has('mask.fieldPaths');
      return new Response(JSON.stringify(firestoreDocument({ visibility, ownerId }, includeBody)), { status: 200 });
    });

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-8', undefined, 4, true);

    expect(result.synced).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(writes.some((write) => write.sql.includes('INSERT INTO posts(id, author_id, body'))).toBe(true);
  });

  it('marks a previously synchronized source deleted and never fetches its body', async () => {
    const { env, writes } = makeEnvironment({
      visibility: 'public', ownerId: 'synthetic-author', viewAllowed: true, deleted: true,
      existing: { author_id: 'synthetic-author', visibility: 'public', firestore_update_time: '2026-09-22T00:00:00Z' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(firestoreDocument({ deleted: true }, false)), { status: 200 }));

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-9', undefined, 4, true);

    expect(result.synced).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(writes.some((write) => write.sql.includes('UPDATE posts SET deleted_at'))).toBe(true);
  });

  it('preserves display media when the image consent is disabled for AI', async () => {
    const { env, writes } = makeEnvironment({
      visibility: 'public', ownerId: 'synthetic-author', globalText: 'PUBLIC_ONLY', globalMedia: 'DISABLED',
      existing: { author_id: 'synthetic-author', visibility: 'public', firestore_update_time: null, media_json: '[{"url":"/media/migration/synthetic-post/0.png"}]' },
      image: true,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('firestore.googleapis.com')) {
        const url = new URL(String(input));
        const includeBody = !url.searchParams.has('mask.fieldPaths');
        return new Response(JSON.stringify(firestoreDocument({ image: true }, includeBody)), { status: 200 });
      }
      throw new Error('image fetch must not occur without consent');
    });

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-5', undefined, 4, true);

    expect(result.synced).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.every(([input]) => String(input).includes('firestore.googleapis.com'))).toBe(true);
    expect(env.MEDIA?.put).not.toHaveBeenCalled();
    const postUpsert = writes.find((write) => write.sql.includes('INSERT INTO posts(id, author_id, body'));
    expect(postUpsert?.values[4]).toBe('[{"url":"/media/migration/synthetic-post/0.png"}]');
  });

  it('syncs uploaded R2 video URLs and their exact storage keys for normal playback', async () => {
    const { env, writes } = makeEnvironment({ visibility: 'public', ownerId: 'synthetic-author', r2Video: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const includeBody = !new URL(String(input)).searchParams.has('mask.fieldPaths');
      return new Response(JSON.stringify(firestoreDocument({ r2Video: true }, includeBody)), { status: 200 });
    });

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', undefined, undefined, 20, false);

    expect(result.synced).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const postUpsert = writes.find((write) => write.sql.includes('INSERT INTO posts(id, author_id, body'));
    expect(JSON.parse(String(postUpsert?.values[4]))).toEqual([{
      url: '/media/posts/synthetic-author/video-test.webm',
      kind: 'video',
      mimeType: 'video/webm',
      storagePath: 'posts/synthetic-author/video-test.webm',
      objectKey: 'posts/synthetic-author/video-test.webm',
    }]);
  });

  it('persists uploaded GIF metadata and source key alongside its preview', async () => {
    const { env, writes } = makeEnvironment({ visibility: 'public', ownerId: 'synthetic-author', r2Gif: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const includeBody = !new URL(String(input)).searchParams.has('mask.fieldPaths');
      return new Response(JSON.stringify(firestoreDocument({ r2Gif: true }, includeBody)), { status: 200 });
    });

    const result = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', undefined, undefined, 20, false);

    expect(result.synced).toBe(true);
    const postUpsert = writes.find((write) => write.sql.includes('INSERT INTO posts(id, author_id, body'));
    expect(JSON.parse(String(postUpsert?.values[4]))).toEqual([{
      url: '/media/posts/synthetic-author/animation.gif',
      kind: 'image',
      mimeType: 'image/gif',
      storagePath: 'posts/synthetic-author/animation.gif',
      objectKey: 'posts/synthetic-author/animation.gif',
      previewUrl: '/media/posts/synthetic-author/animation_preview.webp',
      previewStoragePath: 'posts/synthetic-author/animation_preview.webp',
    }]);
  });

  it('is idempotent for an unchanged Firestore updateTime', async () => {
    const { env, writes } = makeEnvironment({ visibility: 'public', ownerId: 'synthetic-author', viewAllowed: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const includeBody = !new URL(String(input)).searchParams.has('mask.fieldPaths');
      return new Response(JSON.stringify(firestoreDocument({}, includeBody)), { status: 200 });
    });

    const first = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-6', undefined, 4, true);
    const writesAfterFirstSync = writes.length;
    const second = await syncFirebasePost(syntheticRequest(), env, 'synthetic-post', 'correlation-synthetic-7', undefined, 4, true);

    expect(first.synced).toBe(true);
    expect(second.synced).toBe(true);
    expect(writes.length).toBe(writesAfterFirstSync);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // First metadata+body, second metadata only.
  });
});
