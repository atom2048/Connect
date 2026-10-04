import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';

const { getViewerMock } = vi.hoisted(() => ({ getViewerMock: vi.fn() }));

vi.mock('../worker/auth', () => ({ getViewer: getViewerMock }));

const { handleModerationRequest } = await import('../worker/moderation');

function createEnv(): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('SELECT * FROM posts')) return null;
              return null;
            },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
    async batch() { return { success: true }; },
  } as unknown as D1Database;
  return { DB: db, FIREBASE_PROJECT_ID: 'connect-test' } as Env;
}

describe('post moderation API', () => {
  beforeEach(() => {
    getViewerMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a non-admin before reading or changing a post', async () => {
    getViewerMock.mockResolvedValue({ viewer: { id: 'user-1', role: 'user' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleModerationRequest(new Request('https://connect.test/api/admin/posts/post-1', {
      method: 'DELETE',
      headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'spam' }),
    }), createEnv());

    expect(response?.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes a typed Firestore timestamp and scrubs public content on deletion', async () => {
    getViewerMock.mockResolvedValue({ viewer: { id: 'admin-1', role: 'admin' } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH' && url.includes('/documents/notifications/')) return new Response('{}', { status: 200 });
      if (init?.method === 'PATCH') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({
        name: 'projects/connect-test/databases/(default)/documents/posts/post-1',
        fields: {
          userId: { stringValue: 'author-1' },
          text: { stringValue: 'test content' },
          createdAt: { timestampValue: '2026-09-20T12:33:00.000Z' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleModerationRequest(new Request('https://connect.test/api/admin/posts/post-1', {
      method: 'DELETE',
      headers: { authorization: 'Bearer signed-token', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'spam' }),
    }), createEnv());

    expect(response?.status).toBe(200);
    const postPatch = fetchMock.mock.calls.find(([input, init]) => init?.method === 'PATCH' && !String(input).includes('/documents/notifications/'));
    expect(postPatch).toBeDefined();
    const payload = JSON.parse(String(postPatch?.[1]?.body)) as { fields: Record<string, Record<string, unknown>> };
    expect(payload.fields.text).toEqual({ stringValue: '' });
    expect(payload.fields.moderationStatus).toEqual({ stringValue: 'removed' });
    expect(payload.fields.deletedAt.timestampValue).toEqual(expect.any(String));
    expect(payload.fields.deletedBy).toBeUndefined();
  });
});
