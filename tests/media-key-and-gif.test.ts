import { describe, expect, it } from 'vitest';
import { attachmentDisplayURL, createPostMediaStoragePath, resolveAttachmentMimeType, sniffAttachmentMimeType } from '../src/attachments.ts';
import { canonicalPostMediaURLFromPostMedia } from '../src/videoMedia.ts';

describe('post media storage keys', () => {
  it.each([
    ['写真 copy (最終版).JPEG', 'image/jpeg', 'image', 'jpg'],
    ['image without an extension', 'image/png', 'image', 'png'],
    ['アニメーション.gif', 'image/gif', 'image', 'gif'],
    ['video with spaces.MP4', 'video/mp4', 'video', 'mp4'],
  ] as const)('uses a safe MIME-derived suffix for %s', (name, type, purpose, suffix) => {
    const key = createPostMediaStoragePath('synthetic-viewer', new File(['media'], name, { type }), purpose);
    const parts = key.split('/');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('posts');
    expect(parts[1]).toBe('synthetic-viewer');
    expect(parts[2]).toMatch(new RegExp('^' + purpose + '_[A-Za-z0-9_-]+\\.' + suffix + '$'));
    expect(parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))).toBe(true);
  });

  it('infers a browser-omitted MIME type from a recognized filename suffix', () => {
    expect(resolveAttachmentMimeType({ name: 'scan.JPG', type: '' })).toBe('image/jpeg');
  });

  it('recognizes an extensionless image from its bytes and keeps the generated key safe', async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], '日本語 (拡張子なし)!', { type: '' });

    await expect(sniffAttachmentMimeType(file)).resolves.toBe('image/png');
    expect(resolveAttachmentMimeType(file)).toBe('image/png');
    expect(createPostMediaStoragePath('synthetic-viewer', file, 'image')).toMatch(/^posts\/synthetic-viewer\/image_[A-Za-z0-9_-]+\.png$/);
  });
});

describe('animated GIF display routes', () => {
  it('uses the original GIF in feed, profile media, and post-detail resolution despite a static preview', () => {
    const original = '/media/posts/synthetic-viewer/animation.gif';
    const media = [{
      kind: 'image',
      mimeType: 'image/gif',
      url: original,
      storagePath: 'posts/synthetic-viewer/animation.gif',
      previewUrl: '/media/posts/synthetic-viewer/animation_preview.webp',
    }];

    expect(attachmentDisplayURL({
      kind: 'image',
      url: original,
      mimeType: 'image/gif',
      thumbnailUrl: '',
      previewUrl: '/media/posts/synthetic-viewer/animation_preview.webp',
    })).toBe(original);
    expect(canonicalPostMediaURLFromPostMedia(media, original, 'image')).toBe(original);
  });
});
