import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';
import { canonicalPostMediaKey, resolveLegacyMediaObjects } from '../worker/legacyMedia';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../worker/auth', () => ({ getViewer: vi.fn(async () => ({ viewer: null })) }));
const { media, syncFirebasePost } = await import('../worker/index');
afterEach(() => vi.restoreAllMocks());
const source = 'https://firebasestorage.googleapis.com/v0/b/synthetic-project.firebasestorage.app/o/posts%2Fowner%2Fimage.png?alt=media&token=old';
const metadata = { size: 64, httpMetadata: { contentType: 'image/png' }, httpEtag: 'etag', writeHttpMetadata(h: Headers) { h.set('Content-Type', 'image/png'); } };

describe('legacy media recovery', () => {
  it('normalizes both namespaces without trusting another owner or path traversal', () => {
    expect(canonicalPostMediaKey('owner/image.png', 'owner')).toBe('posts/owner/image.png');
    expect(canonicalPostMediaKey('posts/owner/image.png', 'owner')).toBe('posts/owner/image.png');
    for (const key of ['other/image.png', 'posts/other/image.png', 'owner/../image.png', 'owner//image.png', 'profiles/owner/avatar.png', 'migration/post/0.png']) expect(canonicalPostMediaKey(key, 'owner')).toBeNull();
  });
  it('resolves a retired Firebase URL through an exact R2 object and discards a missing preview', async () => {
    const head = vi.fn(async (key: string) => key === 'posts/owner/image.png' ? metadata : null);
    const env = { FIREBASE_PROJECT_ID: 'synthetic-project', MEDIA: { head } } as unknown as Env;
    const result = await resolveLegacyMediaObjects(env, 'owner', [{ url: source, kind: 'image', previewUrl: source.replace('image.png', 'missing.webp') }]);
    expect(result[0]).toMatchObject({ url: '/media/posts/owner/image.png', originalUrl: source, objectKey: 'posts/owner/image.png', mimeType: 'image/png' });
    expect(result[0]).not.toHaveProperty('previewUrl');
  });
  it('keeps a valid preview and resolves physical objects from the old uid namespace', async () => {
    const head = vi.fn(async (key: string) => key.startsWith('owner/') ? metadata : null);
    const env = { FIREBASE_PROJECT_ID: 'synthetic-project', MEDIA: { head } } as unknown as Env;
    const result = await resolveLegacyMediaObjects(env, 'owner', [{ url: source, previewUrl: source.replace('image.png', 'image_preview.webp') }]);
    expect(result[0]).toMatchObject({ url: '/media/posts/owner/image.png', previewUrl: '/media/posts/owner/image_preview.webp', previewStoragePath: 'posts/owner/image_preview.webp' });
  });
  it('never selects an R2 object from another bucket, host, owner, or malformed escape', async () => {
    const head = vi.fn();
    const env = { FIREBASE_PROJECT_ID: 'synthetic-project', MEDIA: { head } } as unknown as Env;
    const urls = [source.replace('synthetic-project.firebasestorage.app', 'foreign.firebasestorage.app'), source.replace('firebasestorage.googleapis.com', 'evil.invalid'), source.replace('posts%2Fowner', 'posts%2Fother'), source.replace('image.png', '%ZZ')];
    await resolveLegacyMediaObjects(env, 'owner', urls.map(url => ({ url })));
    expect(head).not.toHaveBeenCalled();
  });
  it('does not serve an old uid alias before the post ACL passes', async () => {
    const head = vi.fn();const get = vi.fn();
    const env = { MEDIA: { head, get }, DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as unknown as Env;
    const response = await media(new Request('https://worker.invalid/media/owner/image.png'), env, 'owner/image.png');
    expect(response.status).toBe(404);expect(head).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();
  });
  it('serves an authorized canonical route from an old object with correct partial content', async () => {
    const head = vi.fn(async (key: string) => key === 'owner/image.png' ? metadata : null);
    const get = vi.fn(async () => ({ ...metadata, body: new Uint8Array(16) }));
    const env = { MEDIA: { head, get }, DB: { prepare: () => ({ bind: () => ({ first: async () => ({ allowed: 1 }) }) }) } } as unknown as Env;
    const response = await media(new Request('https://worker.invalid/media/posts/owner/image.png', { headers: { Range: 'bytes=8-23' } }), env, 'posts/owner/image.png');
    expect(response.status).toBe(206);expect(response.headers.get('Content-Range')).toBe('bytes 8-23/64');expect(response.headers.get('Content-Length')).toBe('16');expect(get).toHaveBeenCalledWith('owner/image.png', { range: { offset: 8, length: 16 } });
  });
  it('repairs an empty projection at the same source updateTime without overwriting post content', async () => {
    const writes: string[] = [];
    const env = { FIREBASE_PROJECT_ID: 'synthetic-project', MEDIA: { head: async () => metadata, put: vi.fn() }, DB: { prepare(sql: string) { return { bind() { return {
      async first() {
        if (sql.startsWith('SELECT author_id,visibility')) return { author_id: 'owner', visibility: 'public', firestore_update_time: 'same', media_json: '[]' };
        if (sql.startsWith('SELECT 1 AS allowed')) return { allowed: 1 };
        return null;
      }, async run() { writes.push(sql); return { success: true, meta: { changes: 1 } }; },
    }; } }; } } } as unknown as Env;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const full = !String(input).includes('mask.fieldPaths');
      return new Response(JSON.stringify({ name: 'projects/synthetic-project/databases/(default)/documents/posts/post', updateTime: 'same', fields: {
        userId: { stringValue: 'owner' }, visibility: { stringValue: 'public' }, ...(full ? { text: { stringValue: 'Original body' }, imageURLs: { arrayValue: { values: [{ stringValue: source }] } } } : {}),
      } }));
    });
    const result = await syncFirebasePost(new Request('https://worker.invalid/api/posts/post'), env, 'post', undefined, undefined, 20, false, true);
    expect(result.synced).toBe(true);expect(writes).toHaveLength(1);expect(writes[0]).toContain('UPDATE posts SET media_json');expect(writes[0]).not.toContain('body');expect(env.MEDIA!.put).not.toHaveBeenCalled();
  });
});
