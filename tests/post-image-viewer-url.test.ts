import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toPost } from '../src/types/converters.ts';

let renderPostCard: typeof import('../src/components.ts').renderPostCard;

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('document', {
    documentElement: { setAttribute: () => undefined },
    querySelectorAll: () => [],
    createElement: () => {
      const element: { innerHTML: string; textContent: string } = { innerHTML: '', textContent: '' };
      Object.defineProperty(element, 'textContent', {
        set(value: string) {
          element.innerHTML = String(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
          })[character] || character);
        },
      });
      return element;
    },
  });
  ({ renderPostCard } = await import('../src/components.ts'));
});

afterAll(() => vi.unstubAllGlobals());

function postImageSources(markup: string): Array<{ display: string; viewer: string }> {
  return [...markup.matchAll(/<button class="(?:post-image|post-image-carousel-item)"[\s\S]*?<\/button>/g)].map(([button]) => ({
    display: button.match(/<img src="([^"]+)"/)?.[1] || '',
    viewer: button.match(/data-image-url="([^"]+)"/)?.[1] || '',
  }));
}

describe('post image viewer URL resolution', () => {
  it('uses the same resolved media URL for single and multiple attachment images', () => {
    const originalUrls = [
      '/media/posts/author/image-one.png',
      '/media/posts/author/image-two.jpg',
      '/media/posts/author/image-three.webp',
    ];
    const resolvedUrls = [
      '/media/posts/author/image-one_preview.webp?ticket=preview-one',
      '/media/posts/author/image-two-thumb.webp?ticket=preview-two',
      '/media/posts/author/image-three-preview.webp?ticket=preview-three',
    ];
    const post = toPost({
      userId: 'author',
      text: 'multiple images',
      attachments: originalUrls.map((url, index) => ({
        id: `image-${index + 1}`,
        kind: 'image',
        url,
        thumbnailUrl: index === 1 ? resolvedUrls[index] : '',
        previewUrl: resolvedUrls[index],
        name: `image-${index + 1}`,
        size: 10,
        mimeType: ['image/png', 'image/jpeg', 'image/webp'][index],
      })),
    }, 'image-post');
    const markup = renderPostCard(post, { uid: 'author', displayName: 'Author', username: 'author' });

    expect(postImageSources(markup)).toEqual(resolvedUrls.map(url => ({ display: url, viewer: url })));
    originalUrls.forEach(url => expect(markup).not.toContain(`data-image-url="${url}"`));
    expect(markup.match(/class="post-image-media-fallback"/g)).toHaveLength(3);
  });

  it('keeps legacy image URLs and video rendering unchanged', () => {
    const legacyUrl = '/media/migration/legacy/posts/author/legacy-image.jpg';
    const post = toPost({
      userId: 'author',
      text: 'legacy image and video',
      imageURLs: [legacyUrl],
      videoURL: '/media/posts/author/clip.mp4',
    }, 'legacy-image-post');
    const markup = renderPostCard(post, { uid: 'author', displayName: 'Author', username: 'author' });

    expect(postImageSources(markup)).toEqual([{ display: legacyUrl, viewer: legacyUrl }]);
    expect(markup).toContain('/media/posts/author/clip.mp4');
    expect(markup).toContain('post-image-media-fallback');
  });

  it('uses the resolved source for a single attachment and carousel images', () => {
    const singleResolved = '/media/posts/author/single_preview.webp?ticket=single';
    const singlePost = toPost({
      userId: 'author',
      text: 'single image',
      attachments: [{
        id: 'single-image', kind: 'image', url: '/media/posts/author/single.png',
        previewUrl: singleResolved, name: 'single.png', size: 10, mimeType: 'image/png',
      }],
    }, 'single-image-post');
    const singleMarkup = renderPostCard(singlePost, { uid: 'author', displayName: 'Author', username: 'author' });
    expect(postImageSources(singleMarkup)).toEqual([{ display: singleResolved, viewer: singleResolved }]);

    const carouselURLs = Array.from({ length: 5 }, (_, index) => `/media/posts/author/carousel-${index}-preview.webp?ticket=${index}`);
    const carouselPost = toPost({
      userId: 'author',
      text: 'carousel images',
      attachments: carouselURLs.map((previewUrl, index) => ({
        id: `carousel-${index}`, kind: 'image', url: `/media/posts/author/carousel-${index}.png`,
        previewUrl, name: `carousel-${index}.png`, size: 10, mimeType: 'image/png',
      })),
    }, 'carousel-image-post');
    const carouselMarkup = renderPostCard(carouselPost, { uid: 'author', displayName: 'Author', username: 'author' });
    expect(postImageSources(carouselMarkup)).toEqual(carouselURLs.map(url => ({ display: url, viewer: url })));
    expect(carouselMarkup.match(/class="post-image-media-fallback"/g)).toHaveLength(5);
  });

  it('keeps animated GIFs on the original source in both post and viewer', () => {
    const gifSource = '/media/posts/author/animated.gif?ticket=source';
    const gifPreview = '/media/posts/author/animated_preview.webp?ticket=preview';
    const post = toPost({
      userId: 'author',
      text: 'animated GIF',
      attachments: [{
        id: 'animated-gif', kind: 'image', url: gifSource,
        previewUrl: gifPreview, name: 'animated.gif', size: 10, mimeType: 'image/gif',
      }],
    }, 'animated-gif-post');
    const markup = renderPostCard(post, { uid: 'author', displayName: 'Author', username: 'author' });

    expect(postImageSources(markup)).toEqual([{ display: gifSource, viewer: gifSource }]);
    expect(markup).not.toContain(gifPreview);
  });
});
