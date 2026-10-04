import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/types';
import { createPostMediaStoragePath } from '../src/attachments';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../worker/auth', () => ({
  getViewer: vi.fn(async () => ({ auth: null, viewer: { id: 'synthetic-viewer', name: 'Synthetic viewer', email: '' }, source: 'firebase_bearer' })),
}));

const { media } = await import('../worker/index');

function uploadEnvironment(size = 17 * 1024 * 1024) {
  const put = vi.fn(async () => undefined);
  const deleteObject = vi.fn(async () => undefined);
  const createMultipartUpload = vi.fn(async () => ({ uploadId: 'synthetic-upload-id' }));
  const uploadPart = vi.fn(async (partNumber: number) => ({ partNumber, etag: `etag-${partNumber}` }));
  const complete = vi.fn(async () => ({ size }));
  const abort = vi.fn(async () => undefined);
  const resumeMultipartUpload = vi.fn(() => ({ uploadPart, complete, abort }));
  const env = {
    MEDIA: {
      put,
      delete: deleteObject,
      head: vi.fn(async () => null),
      createMultipartUpload,
      resumeMultipartUpload,
    },
    DB: {},
  } as unknown as Env;
  return { env, put, deleteObject, createMultipartUpload, resumeMultipartUpload, uploadPart, complete, abort };
}

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  return { Authorization: 'Bearer synthetic-token', ...extra };
}

/** The deployed historical media PUT validation from 8a9699c:worker/index.ts. */
async function historicalMediaPut(request: Request, key: string, viewerId: string, put: (key: string, body: BodyInit | null) => Promise<void>): Promise<Response> {
  if (request.method !== 'PUT') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  if (!/^[-a-zA-Z0-9_./]+$/.test(key) || !key.startsWith(`${viewerId}/`)) {
    return new Response(JSON.stringify({ error: 'invalid_media_key' }), { status: 422 });
  }
  await put(key, request.body);
  return new Response(JSON.stringify({ key, url: `/media/${key}` }), { status: 201 });
}

/** The later deployed media gate from 8c94be1:worker/index.ts (d76a7c9a). */
async function d76MediaPut(request: Request, key: string, viewerId: string, put: (key: string, body: BodyInit | null) => Promise<void>): Promise<Response> {
  const ownerPrefixes = [`${viewerId}/`, `posts/${viewerId}/`, `profiles/${viewerId}/`];
  if (!/^[-a-zA-Z0-9_./]+$/.test(key) || !ownerPrefixes.some(prefix => key.startsWith(prefix))) {
    return new Response(JSON.stringify({ error: 'invalid_media_key' }), { status: 422 });
  }
  await put(key, request.body);
  return new Response(JSON.stringify({ key, url: `/media/${key}` }), { status: 201 });
}

afterEach(() => vi.restoreAllMocks());

describe('authenticated user R2 media upload', () => {
  it('reproduces the released frontend/Worker key-prefix mismatch and proves the current Worker accepts the same media', async () => {
    // Historical source pair (commit 8a9699c): home.ts generated
    // `posts/${uid}/image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    // where ext was `file.name.split('.').pop() || 'jpg'`; worker/index.ts then
    // accepted only keys starting `${viewer.id}/`. Keep both historical rules
    // executable here so this regression does not depend on archived logs.
    vi.spyOn(Date, 'now').mockReturnValue(1790860000000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fileName = '日本語 filename (image).JPG';
    const legacyExtension = fileName.split('.').pop() || 'jpg';
    const legacyKey = `posts/synthetic-viewer/image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${legacyExtension}`;

    expect(legacyKey).toBe('posts/synthetic-viewer/image_1790860000000_i.JPG');
    expect(/^[-a-zA-Z0-9_./]+$/.test(legacyKey)).toBe(true);
    const legacyPut = vi.fn(async () => undefined);
    const legacyResponse = await historicalMediaPut(new Request(`https://worker.example.invalid/media/${legacyKey}`, {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'image/jpeg' }), body: 'jpeg',
    }), legacyKey, 'synthetic-viewer', legacyPut);
    expect(legacyResponse.status).toBe(422);
    await expect(legacyResponse.json()).resolves.toEqual({ error: 'invalid_media_key' });
    expect(legacyPut).not.toHaveBeenCalled();

    // The incident-era deployment had already added the posts/{uid} prefix;
    // this proves the old mismatch alone cannot explain a later 422 from that
    // Worker. It also documents that Japanese basename characters are absent
    // from this normal-extension key.
    const incidentEraPut = vi.fn(async () => undefined);
    const incidentEraResponse = await d76MediaPut(new Request(`https://worker.example.invalid/media/${legacyKey}`, {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'image/jpeg' }), body: 'jpeg',
    }), legacyKey, 'synthetic-viewer', incidentEraPut);
    expect(incidentEraResponse.status).toBe(201);
    expect(incidentEraPut).toHaveBeenCalledOnce();

    const { env, put } = uploadEnvironment(4);
    const currentResponse = await media(new Request(`https://worker.example.invalid/media/${legacyKey}`, {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'image/jpeg', 'Content-Length': '4' }), body: 'jpeg',
    }), env, legacyKey);
    expect(currentResponse.status).toBe(201);
    expect(await currentResponse.json()).toEqual({ key: legacyKey, url: `/media/${legacyKey}` });
    expect(put).toHaveBeenCalledOnce();
  });

  it('reproduces invalid filename-derived suffixes against the incident-era Worker and accepts the same file via a MIME-derived key', async () => {
    // home.ts at 8c94be1 still used file.name.split('.').pop() || 'jpg'.
    // For a dotless Unicode filename this copied the *whole filename* into the
    // R2 key. The incident-era Worker (d76a7c9a, 8c94be1) allowed posts/{uid}
    // but rejected any key character outside ASCII [A-Za-z0-9_./-].
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00])], '日本語写真 (無拡張子)!', { type: 'image/jpeg' });
    const legacyExtension = file.name.split('.').pop() || 'jpg';
    const legacyKey = `posts/synthetic-viewer/image_1790860000000_i.${legacyExtension}`;
    expect(legacyKey).toBe('posts/synthetic-viewer/image_1790860000000_i.日本語写真 (無拡張子)!');
    const { env, put } = uploadEnvironment(4);
    const legacyResponse = await d76MediaPut(new Request(`https://worker.example.invalid/media/${encodeURIComponent(legacyKey)}`, {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'image/jpeg' }), body: 'jpeg',
    }), legacyKey, 'synthetic-viewer', put);
    expect(legacyResponse.status).toBe(422);
    await expect(legacyResponse.json()).resolves.toEqual({ error: 'invalid_media_key' });
    expect(put).not.toHaveBeenCalled();

    const correctedKey = createPostMediaStoragePath('synthetic-viewer', file, 'image');
    expect(correctedKey).toMatch(/^posts\/synthetic-viewer\/image_[A-Za-z0-9_-]+\.jpg$/);
    const currentResponse = await media(new Request(`https://worker.example.invalid/media/${correctedKey}`, {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'image/jpeg', 'Content-Length': '4' }), body: 'jpeg',
    }), env, correctedKey);
    expect(currentResponse.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
  });

  it('stores a new post video under its Firestore storage key and exact video MIME type', async () => {
    const { env, put } = uploadEnvironment();
    const request = new Request('https://worker.example.invalid/media/posts/synthetic-viewer/video-test.mp4', {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'video/mp4', 'Content-Length': '4' }),
      body: 'clip',
    });

    const response = await media(request, env, 'posts/synthetic-viewer/video-test.mp4');

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ key: 'posts/synthetic-viewer/video-test.mp4', url: '/media/posts/synthetic-viewer/video-test.mp4' });
    expect(put).toHaveBeenCalledWith('posts/synthetic-viewer/video-test.mp4', expect.anything(), { httpMetadata: { contentType: 'video/mp4' } });
  });

  it.each([
    ['image/jpeg', 'photo.jpg'],
    ['image/png', 'photo.png'],
    ['image/gif', 'animation.gif'],
  ])('stores %s bytes with the exact content type', async (contentType, filename) => {
    const { env, put } = uploadEnvironment(4);
    const key = 'posts/synthetic-viewer/' + filename;
    const response = await media(new Request('https://worker.example.invalid/media/' + key, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': contentType, 'Content-Length': '4' }),
      body: 'data',
    }), env, key);

    expect(response.status).toBe(201);
    expect(put).toHaveBeenCalledWith(key, expect.anything(), { httpMetadata: { contentType } });
  });

  it('rejects keys outside the signed-in user namespace', async () => {
    const { env, put } = uploadEnvironment();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await media(new Request('https://worker.example.invalid/media/posts/another-user/video.mp4', {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'video/mp4' }), body: 'clip',
    }), env, 'posts/another-user/video.mp4');

    expect(response.status).toBe(422);
    expect(put).not.toHaveBeenCalled();
    const diagnostic = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(diagnostic).toMatchObject({
      event: 'media_upload_rejected',
      reason: 'owner_mismatch',
      identitySource: 'firebase_bearer',
      keyNamespace: 'posts',
      ownerSegmentMatchesViewer: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('another-user');
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-viewer');
  });

  it('logs the unsafe path segment category without exposing a selected filename', async () => {
    const { env, put } = uploadEnvironment();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await media(new Request('https://worker.example.invalid/media/posts/synthetic-viewer/image_旅行.png', {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'image/png' }), body: 'png',
    }), env, 'posts/synthetic-viewer/image_旅行.png');

    expect(response.status).toBe(422);
    expect(put).not.toHaveBeenCalled();
    const diagnostic = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(diagnostic).toMatchObject({ event: 'media_upload_rejected', reason: 'invalid_path_segment', identitySource: 'firebase_bearer' });
    expect(JSON.stringify(diagnostic)).not.toContain('旅行');
  });

  it('uploads large videos as bounded R2 multipart chunks and checks the final byte count', async () => {
    const size = 17 * 1024 * 1024;
    const { env, createMultipartUpload, resumeMultipartUpload, uploadPart, complete } = uploadEnvironment(size);
    const initiate = await media(new Request('https://worker.example.invalid/media/posts/synthetic-viewer/large.webm', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'initiate', contentType: 'video/webm', size }),
    }), env, 'posts/synthetic-viewer/large.webm');
    expect(initiate.status).toBe(201);
    expect(await initiate.json()).toEqual({ uploadId: 'synthetic-upload-id' });
    expect(createMultipartUpload).toHaveBeenCalledWith('posts/synthetic-viewer/large.webm', { httpMetadata: { contentType: 'video/webm' } });

    for (let partNumber = 1; partNumber <= 3; partNumber += 1) {
      const part = await media(new Request(`https://worker.example.invalid/media/posts/synthetic-viewer/large.webm?uploadId=synthetic-upload-id&partNumber=${partNumber}`, {
        method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/octet-stream', 'Content-Length': '8' }), body: `part-${partNumber}`,
      }), env, 'posts/synthetic-viewer/large.webm');
      expect(part.status).toBe(200);
      expect(await part.json()).toEqual({ partNumber, etag: `etag-${partNumber}` });
    }
    expect(uploadPart).toHaveBeenCalledTimes(3);

    const parts = [1, 2, 3].map((partNumber) => ({ partNumber, etag: `etag-${partNumber}` }));
    const completed = await media(new Request('https://worker.example.invalid/media/posts/synthetic-viewer/large.webm', {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'complete', uploadId: 'synthetic-upload-id', size, parts }),
    }), env, 'posts/synthetic-viewer/large.webm');
    expect(completed.status).toBe(201);
    expect(await completed.json()).toEqual({ key: 'posts/synthetic-viewer/large.webm', url: '/media/posts/synthetic-viewer/large.webm', size });
    expect(resumeMultipartUpload).toHaveBeenCalledWith('posts/synthetic-viewer/large.webm', 'synthetic-upload-id');
    expect(complete).toHaveBeenCalledWith(parts);
  });

  it('allows the existing profile avatar upload namespace', async () => {
    const { env, put } = uploadEnvironment();
    const response = await media(new Request('https://worker.example.invalid/media/profiles/synthetic-viewer/avatar.webp', {
      method: 'PUT', headers: authHeaders({ 'Content-Type': 'image/webp', 'Content-Length': '4' }), body: 'webp',
    }), env, 'profiles/synthetic-viewer/avatar.webp');

    expect(response.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
  });
});
