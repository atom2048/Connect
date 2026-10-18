import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostMediaURLFromProjection } from '../src/postMediaLookup.ts';

beforeAll(() => vi.stubGlobal('window', { location: { origin: 'https://connect.test' } }));
afterAll(() => vi.unstubAllGlobals());

describe('post media projection URL resolution', () => {
  it('maps old Firebase media URLs to the current Worker URL from the saved post projection', async () => {
    const source = 'https://firebasestorage.googleapis.com/v0/b/connect.firebasestorage.app/o/posts%2Fauthor%2Fclip.mp4?alt=media&token=old';
    const lookup = vi.fn(async () => ({
      status: 200,
      media: [{ kind: 'video', url: '/media/posts/author/clip.mp4?ticket=fresh', storagePath: 'posts/author/clip.mp4', mimeType: 'video/mp4' }],
    }));
    const result = await resolvePostMediaURLFromProjection('post-1', source, 'video', 0, lookup);
    expect(result).toBe('/media/posts/author/clip.mp4?ticket=fresh');
    expect(lookup).toHaveBeenCalledOnce();
  });

  it('uses a valid ticketed Worker URL directly without a redundant API read', async () => {
    const lookup = vi.fn();
    const result = await resolvePostMediaURLFromProjection(
      'post-1',
      '/media/posts/author/clip.mp4?ticket=fresh',
      'video',
      0,
      lookup,
    );
    expect(result).toBe('/media/posts/author/clip.mp4?ticket=fresh');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fails closed when the post references a missing video object', async () => {
    const source = 'https://firebasestorage.googleapis.com/v0/b/connect.firebasestorage.app/o/posts%2Fauthor%2Fclip.mp4?alt=media';
    await expect(resolvePostMediaURLFromProjection('post-1', source, 'video', 0, async () => ({
      status: 200,
      media: [{ kind: 'video', originalUrl: source, storagePath: 'posts/author/clip.mp4' }],
    }))).rejects.toThrow('post_media_object_unavailable');
  });

  it('retains the stored source for new posts not yet present in the read projection', async () => {
    const source = 'https://firebasestorage.googleapis.com/v0/b/connect.firebasestorage.app/o/posts%2Fauthor%2Fclip.mp4?alt=media';
    const result = await resolvePostMediaURLFromProjection('post-1', source, 'video', 0, async () => ({ status: 404, media: null }));
    expect(result).toBe(source);
  });
});
