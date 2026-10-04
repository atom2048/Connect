import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ collection: vi.fn(), doc: vi.fn(), auth: vi.fn() }));
vi.mock('../api/_firebase-admin.js', () => ({ adminDb: { collection: mocks.collection, doc: mocks.doc } }));
vi.mock('../api/_auth.js', () => ({ setApiHeaders: vi.fn(), verifyFirebaseUser: mocks.auth }));
vi.mock('../api/_search-config.js', () => ({ SEARCH_API_ENABLED: true, SEARCH_INDEX_READY: true, SEARCH_APPLICATION_DEADLINE_MS: 2500, SEARCH_DEFAULT_LIMIT: 20, SEARCH_MAX_LIMIT: 20, SEARCH_MAX_TERMS: 8, SEARCH_MAX_CODE_POINTS: 128, SEARCH_MAX_UTF8_BYTES: 512, FULL_SCAN_LIMIT: 100, PREVIEW_SCAN_LIMIT: 50 }));
import handler from '../api/search/posts.js';

const post = (id, text, visibility = 'public') => ({ id, data: () => ({ userId: 'owner', text, visibility, createdAt: 1000 }) });
let posts;
let postQuery;
beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ sub: 'viewer' });
  mocks.doc.mockReset().mockImplementation(path => ({ get: async () => ({ exists: path === 'users/owner', id: 'owner', data: () => ({ username: 'Mottie' }) }) }));
  posts = [post('a', '猫です'), post('b', '犬です'), post('c', '猫の秘密', 'friends')];
  postQuery = { where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), startAfter: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), get: vi.fn(async () => ({ docs: posts })) };
  mocks.collection.mockReset().mockImplementation(name => name === 'posts' ? postQuery : null);
});

async function request(query, extra = {}) {
  const res = { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', body: { query, ...extra } }, res);
  return res;
}

describe('author post search API', () => {
  it('filters by canonical author ID and excludes non-public posts', async () => {
    const result = await request('猫', { authorId: 'owner' });
    expect(result.statusCode).toBe(200);
    expect(postQuery.where).toHaveBeenCalledWith('userId', '==', 'owner');
    expect(result.body.items.map(item => item.id)).toEqual(['a']);
    expect(result.body.mode).toBe('author');
  });
  it('filters only post body text, accepts a one-character term, and allows an empty body query', async () => {
    expect((await request('Mottie', { authorId: 'owner' })).body.items).toEqual([]);
    expect((await request('猫', { authorId: 'owner' })).body.items.map(item => item.id)).toEqual(['a']);
    expect((await request('', { authorId: 'owner' })).body.items.map(item => item.id)).toEqual(['a', 'b']);
  });
  it('binds cursors to both author ID and body query', async () => {
    const first = await request('', { authorId: 'owner', limit: 1 });
    expect(first.body.hasMore).toBe(true);
    expect((await request('犬', { authorId: 'owner', cursor: first.body.nextCursor })).statusCode).toBe(400);
    expect((await request('', { authorId: 'other', cursor: first.body.nextCursor })).statusCode).toBe(400);
    await request('', { authorId: 'owner', cursor: first.body.nextCursor });
    expect(postQuery.startAfter).toHaveBeenCalled();
  });
  it('rejects invalid author, limit, malformed query types, and unauthenticated requests', async () => {
    expect((await request('', { authorId: '' })).statusCode).toBe(400);
    expect((await request('', { authorId: 'owner', limit: 0 })).statusCode).toBe(400);
    expect((await request({})).statusCode).toBe(400);
    mocks.auth.mockRejectedValueOnce(new Error('unauthorized'));
    expect((await request('', { authorId: 'owner' })).statusCode).toBe(401);
  });
});
