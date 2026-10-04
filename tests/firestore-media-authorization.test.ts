import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../worker/auth', () => ({
  getViewer: vi.fn(async () => ({ auth: null, viewer: { id: 'synthetic-viewer', name: 'Synthetic viewer', email: '' } })),
}));

const { media } = await import('../worker/index');
const { addPostMediaTickets } = await import('../worker/index');
const { createMediaAccessTicket, verifyMediaAccessTicket } = await import('../worker/mediaAccess');

function mediaEnv(authorized: boolean, bodyText = 'synthetic image bytes', contentType = 'image/png') {
  const sqlCalls: string[] = [];
  const bytes = new TextEncoder().encode(bodyText);
  const get = vi.fn(async (_key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) => {
    const requestedRange = options?.range;
    if (requestedRange) {
      const offset = requestedRange.suffix !== undefined
        ? Math.max(0, bytes.byteLength - requestedRange.suffix)
        : requestedRange.offset ?? 0;
      const requestedLength = requestedRange.suffix !== undefined
        ? Math.min(requestedRange.suffix, bytes.byteLength)
        : requestedRange.length ?? (bytes.byteLength - offset);
      const requestedEnd = offset + requestedLength - 1;
      if (requestedLength <= 0) return null;
      const end = Math.min(requestedEnd, bytes.byteLength - 1);
      if (offset >= bytes.byteLength || offset > end) return null;
      return {
        body: new Blob([bytes.slice(offset, end + 1)]).stream(),
        size: bytes.byteLength,
        range: requestedRange,
        httpEtag: 'synthetic-etag',
        writeHttpMetadata(headers: Headers) { headers.set('Content-Type', contentType); },
      };
    }
    return {
      body: new Blob([bytes]).stream(),
      size: bytes.byteLength,
      httpEtag: 'synthetic-etag',
      writeHttpMetadata(headers: Headers) { headers.set('Content-Type', contentType); },
    };
  });
  const head = vi.fn(async () => ({
    size: bytes.byteLength,
    httpEtag: 'synthetic-etag',
    writeHttpMetadata(headers: Headers) { headers.set('Content-Type', contentType); },
  }));
  const env = {
    MEDIA: { get, head },
    LOG_PSEUDONYM_MASTER_SECRET: 'synthetic-ticket-secret',
    DB: {
      prepare(sql: string) {
        sqlCalls.push(sql);
        return { bind: () => ({ first: async () => authorized ? { allowed: 1 } : null }) };
      },
    },
  } as unknown as Env;
  return { env, get, head, sqlCalls };
}

afterEach(() => vi.restoreAllMocks());

describe('Firestore-synced R2 media authorization', () => {
  it('returns a 404 without reading R2 when no currently visible post references the image', async () => {
    const { env, get, sqlCalls } = mediaEnv(false);

    const response = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.png'), env, 'migration/synthetic-post/0.png');

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    expect(sqlCalls[0]).toContain('json_each');
    expect(sqlCalls[0]).toContain("p.deleted_at IS NULL");
    expect(sqlCalls[0]).toContain('blocks');
  });

  it('serves an authorized migrated image without shared or persistent caching', async () => {
    const { env, get } = mediaEnv(true);

    const response = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.png'), env, 'migration/synthetic-post/0.png');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('synthetic image bytes');
    expect(get).toHaveBeenCalledOnce();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Authorization, Cookie');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('authorizes a migrated R2 image referenced by a current profile avatar or cover', async () => {
    const { env, get, sqlCalls } = mediaEnv(true);

    const response = await media(new Request('https://worker.example.invalid/media/migration/legacy/profile-avatar.webp'), env, 'migration/legacy/profile-avatar.webp');

    expect(response.status).toBe(200);
    expect(sqlCalls[0]).toContain('UNION ALL');
    expect(sqlCalls[0]).toContain('FROM profiles pr');
    expect(sqlCalls[0]).toContain('pr.avatar_url=? OR pr.cover_url=?');
    expect(get).toHaveBeenCalledOnce();
  });

  it('returns a correctly framed 206 response for a byte range', async () => {
    const { env, get } = mediaEnv(true, '0123456789', 'video/mp4');
    const request = new Request('https://worker.example.invalid/media/migration/synthetic-post/0.mp4', {
      headers: { Range: 'bytes=2-5' },
    });

    const response = await media(request, env, 'migration/synthetic-post/0.mp4');

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.text()).toBe('2345');
    expect(get).toHaveBeenCalledWith('migration/synthetic-post/0.mp4', { range: { offset: 2, length: 4 } });
  });

  it('supports open-ended and suffix byte ranges', async () => {
    const { env, get } = mediaEnv(true, '0123456789', 'video/mp4');
    const openEnded = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.mp4', {
      headers: { Range: 'bytes=6-' },
    }), env, 'migration/synthetic-post/0.mp4');
    const suffix = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.mp4', {
      headers: { Range: 'bytes=-3' },
    }), env, 'migration/synthetic-post/0.mp4');

    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('Content-Range')).toBe('bytes 6-9/10');
    expect(openEnded.headers.get('Content-Length')).toBe('4');
    expect(get).toHaveBeenNthCalledWith(1, 'migration/synthetic-post/0.mp4', { range: { offset: 6 } });
    expect(await openEnded.text()).toBe('6789');
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('Content-Range')).toBe('bytes 7-9/10');
    expect(suffix.headers.get('Content-Length')).toBe('3');
    expect(get).toHaveBeenNthCalledWith(2, 'migration/synthetic-post/0.mp4', { range: { suffix: 3 } });
    expect(await suffix.text()).toBe('789');
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const { env, head } = mediaEnv(true, '0123456789', 'video/mp4');
    const response = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.mp4', {
      headers: { Range: 'bytes=10-' },
    }), env, 'migration/synthetic-post/0.mp4');

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(head).toHaveBeenCalledOnce();
  });

  it('ignores malformed and multi-range headers instead of generating invalid Content-Range values', async () => {
    const { env, get } = mediaEnv(true, '0123456789', 'video/mp4');
    for (const range of ['bytes=2-1', 'bytes=2-3,5-6', 'bytes=-0']) {
      const response = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.mp4', {
        headers: { Range: range },
      }), env, 'migration/synthetic-post/0.mp4');

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(response.headers.get('Content-Length')).toBe('10');
      expect(await response.text()).toBe('0123456789');
    }
    expect(get).toHaveBeenNthCalledWith(1, 'migration/synthetic-post/0.mp4', undefined);
    expect(get).toHaveBeenNthCalledWith(2, 'migration/synthetic-post/0.mp4', undefined);
    expect(get).toHaveBeenNthCalledWith(3, 'migration/synthetic-post/0.mp4', undefined);
  });

  it('preserves post-scoped media tickets on range requests', async () => {
    const { env, sqlCalls } = mediaEnv(true, '0123456789', 'video/mp4');
    const ticket = await createMediaAccessTicket('synthetic-ticket-secret', {
      key: 'migration/synthetic-post/0.mp4',
      postId: 'post-123',
      viewerId: 'synthetic-viewer',
    });
    const response = await media(new Request(`https://worker.example.invalid/media/migration/synthetic-post/0.mp4?ticket=${ticket}`, {
      headers: { Range: 'bytes=2-5' },
    }), env, 'migration/synthetic-post/0.mp4');

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(sqlCalls[0]).toContain('AND p.id = ?');
    expect(sqlCalls[0]).not.toContain('FROM profiles pr');
    expect(await response.text()).toBe('2345');
  });

  it('authorizes uploaded post media through a scoped ticket and serves video ranges', async () => {
    const { env, get, sqlCalls } = mediaEnv(true, '0123456789', 'video/webm');
    const ticket = await createMediaAccessTicket('synthetic-ticket-secret', {
      key: 'posts/synthetic-viewer/video.webm',
      postId: 'post-456',
      viewerId: 'synthetic-viewer',
    });
    const response = await media(new Request(`https://worker.example.invalid/media/posts/synthetic-viewer/video.webm?ticket=${ticket}`, {
      headers: { Range: 'bytes=3-6' },
    }), env, 'posts/synthetic-viewer/video.webm');

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Type')).toBe('video/webm');
    expect(response.headers.get('Content-Range')).toBe('bytes 3-6/10');
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(sqlCalls[0]).toContain('AND p.id = ?');
    expect(await response.text()).toBe('3456');
    expect(get).toHaveBeenCalledWith('posts/synthetic-viewer/video.webm', { range: { offset: 3, length: 4 } });
  });

  it('authorizes an uploaded image preview through a ticket scoped to its owning post', async () => {
    const { env, get, sqlCalls } = mediaEnv(true);
    const ticket = await createMediaAccessTicket('synthetic-ticket-secret', {
      key: 'posts/synthetic-viewer/preview.webp',
      postId: 'post-789',
      viewerId: 'synthetic-viewer',
    });
    const response = await media(new Request(`https://worker.example.invalid/media/posts/synthetic-viewer/preview.webp?ticket=${ticket}`), env, 'posts/synthetic-viewer/preview.webp');

    expect(response.status).toBe(200);
    expect(sqlCalls[0]).toContain('p.author_id=?');
    expect(sqlCalls[0]).toContain("].thumbnailUrl')");
    expect(sqlCalls[0]).toContain("].previewUrl')");
    expect(get).toHaveBeenCalledOnce();
  });

  it('signs protected thumbnail and preview routes in post detail while rejecting another post’s migration preview', async () => {
    const result = await addPostMediaTickets({ LOG_PSEUDONYM_MASTER_SECRET: 'synthetic-ticket-secret' } as unknown as Env, {
      id: 'post-789',
      authorId: 'synthetic-viewer',
      media: [{
        url: '/media/migration/post-789/0.jpg',
        thumbnailUrl: '/media/posts/synthetic-viewer/thumb.webp',
        previewUrl: '/media/migration/post-789/preview.webp',
        originalUrl: 'https://firebasestorage.googleapis.com/v0/b/old/o/image.jpg?token=old',
      }, {
        url: '/media/migration/post-789/1.jpg',
        previewUrl: '/media/migration/another-post/preview.webp',
      }],
    }, 'synthetic-viewer');
    const media = result.media as Array<Record<string, unknown>>;
    const previewTicketURL = new URL(String(media[0].thumbnailUrl), 'https://connect.invalid');
    const previewTicket = previewTicketURL.searchParams.get('ticket') || '';

    expect(previewTicket).not.toBe('');
    expect(await verifyMediaAccessTicket('synthetic-ticket-secret', previewTicket, 'posts/synthetic-viewer/thumb.webp')).toMatchObject({ postId: 'post-789', viewerId: 'synthetic-viewer' });
    expect(String(media[0].url)).toContain('?ticket=');
    expect(String(media[0].previewUrl)).toContain('?ticket=');
    expect(media[1].previewUrl).toBe('/media/migration/another-post/preview.webp');
  });

  it('supports HEAD with the full object length and no body', async () => {
    const { env, get, head } = mediaEnv(true, 'video bytes', 'video/mp4');

    const response = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.mp4', { method: 'HEAD' }), env, 'migration/synthetic-post/0.mp4');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String('video bytes'.length));
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(await response.text()).toBe('');
    expect(head).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });

  it('fails closed when the D1 authorization index is unavailable', async () => {
    const { env, get } = mediaEnv(true);
    delete (env as Env & { DB?: Env['DB'] }).DB;

    const response = await media(new Request('https://worker.example.invalid/media/migration/synthetic-post/0.png'), env, 'migration/synthetic-post/0.png');

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
});
