import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mergeLatestDisplayProfile, resolveAvatarURL } from '../src/avatar.ts';
import { canonicalPostMediaURLFromPostMedia, canonicalVideoURLFromPostMedia, storagePathFromMediaURL } from '../src/videoMedia.ts';
import { toPost, toUserProfile } from '../src/types/converters.ts';

let createAvatarHTML: typeof import('../src/components.ts').createAvatarHTML;
let renderCreatePostForm: typeof import('../src/components.ts').renderCreatePostForm;
let updateCurrentUserComposerAvatars: typeof import('../src/components.ts').updateCurrentUserComposerAvatars;
let renderPostCard: typeof import('../src/components.ts').renderPostCard;
type TestAvatarNode = { dataset: Record<string, string>; href: string; innerHTML: string; removeAttribute: (name: string) => void };
const composerAvatarNodes: TestAvatarNode[] = [];

function makeComposerAvatarNode(): TestAvatarNode {
  const node: TestAvatarNode = {
    dataset: { avatarSize: '40', avatarUserId: 'viewer' },
    href: '#/profile/viewer',
    innerHTML: '',
    removeAttribute(name) { if (name === 'href') node.href = ''; },
  };
  return node;
}

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('document', {
    documentElement: { setAttribute: () => undefined },
    querySelectorAll: () => composerAvatarNodes as unknown as NodeListOf<Element>,
    createElement: () => {
      const element: { innerHTML: string; textContent: string } = { innerHTML: '', textContent: '' };
      Object.defineProperty(element, 'textContent', {
        set(value: string) {
          element.innerHTML = String(value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
          })[character] || character);
        },
      });
      return element;
    },
  });
  const components = await import('../src/components.ts');
  createAvatarHTML = components.createAvatarHTML;
  renderCreatePostForm = components.renderCreatePostForm;
  updateCurrentUserComposerAvatars = components.updateCurrentUserComposerAvatars;
  renderPostCard = components.renderPostCard;
});

afterAll(() => vi.unstubAllGlobals());

describe('post author avatar regressions', () => {
  it('uses the latest Worker profile image in preference to an old Firestore snapshot', () => {
    const profile = mergeLatestDisplayProfile(
      { uid: 'author', displayName: 'Author', photoURL: 'https://firebasestorage.googleapis.com/v0/b/old/avatar', profilePhotoPreviewURL: '' },
      { photoURL: '/media/migration/legacy/profiles/author/avatar.webp' },
    );
    expect(profile?.photoURL).toBe('/media/migration/legacy/profiles/author/avatar.webp');
    expect(resolveAvatarURL(profile)).toBe('/media/migration/legacy/profiles/author/avatar.webp');
  });

  it('keeps Firebase URLs as a last-resort candidate and prefers canonical Worker media', () => {
    const firebasePhoto = 'https://firebasestorage.googleapis.com/v0/b/old/avatar';
    expect(resolveAvatarURL({ photoURL: firebasePhoto })).toBe(firebasePhoto);
    expect(resolveAvatarURL({ photoURL: 'https://storage.googleapis.com/bucket/old-avatar' })).toBe('https://storage.googleapis.com/bucket/old-avatar');
    expect(resolveAvatarURL({ photoURL: 'https://storage.cloud.google.com/bucket/old-avatar' })).toBe('https://storage.cloud.google.com/bucket/old-avatar');
    expect(resolveAvatarURL({ photoURL: 'https://example.invalid/avatar.png' })).toBe('https://example.invalid/avatar.png');
    const fallback = createAvatarHTML({ displayName: 'Aki', photoURL: firebasePhoto });
    expect(fallback).toContain(`src="${firebasePhoto}"`);
    expect(fallback).toContain('class="avatar-fallback avatar-initials-fallback"');
    expect(fallback).toMatch(/avatar-initials-fallback" style="[^"]*display:none/);
    expect(fallback).not.toContain('avatar-image-placeholder');
    expect(createAvatarHTML({ displayName: 'Aki' })).toContain('class="avatar-fallback avatar-initials-fallback"');
    expect(createAvatarHTML({ displayName: 'Aki' })).not.toContain('avatar-image-placeholder');
    expect(resolveAvatarURL({ photoURL: 'https://firebasestorage.googleapis.com/old', avatarUrl: '/media/migration/legacy/author/current.webp' })).toBe('/media/migration/legacy/author/current.webp');
    expect(resolveAvatarURL({ photoURL: firebasePhoto, profileImage: '/media/profiles/author/current.webp' })).toBe('/media/profiles/author/current.webp');
    expect(mergeLatestDisplayProfile(
      { uid: 'author', photoURL: '/media/profiles/author/current.webp' },
      { photoURL: firebasePhoto },
    )?.photoURL).toBe('/media/profiles/author/current.webp');
    expect(resolveAvatarURL({ photoURL: '/media/legacy/old-key' })).toBe('');
  });

  it('normalizes legacy profile field aliases through the shared avatar resolver', () => {
    const profile = toUserProfile({ photoURL: 'https://firebasestorage.googleapis.com/v0/b/old/avatar', avatarURL: '/media/profiles/author/avatar.webp' }, 'author');
    expect(profile.photoURL).toBe('/media/profiles/author/avatar.webp');
    expect(resolveAvatarURL({ photoURL: '', avatar_url: '/media/profiles/author/avatar.webp' })).toBe('/media/profiles/author/avatar.webp');
  });

  it('renders a circular image and initials fallback in the shared clickable post header', () => {
    const avatar = createAvatarHTML({ displayName: 'Aki', photoURL: '/media/profiles/author/avatar.webp' });
    expect(avatar).toContain('src="/media/profiles/author/avatar.webp"');
    expect(avatar).toContain('class="avatar-fallback avatar-initials-fallback"');
    expect(avatar).toMatch(/avatar-initials-fallback" style="[^"]*display:none/);
    expect(avatar).toContain("this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex'");
    expect(avatar).toContain("console.warn('[Connect] avatar image failed to load',{host:");
    expect(avatar).toContain('object-fit:cover');
    expect(avatar).toContain('>A</div>');

    const card = renderPostCard({ id: 'post-1', userId: 'author', text: 'hello' }, {
      uid: 'author', displayName: 'Aki', username: 'aki', photoURL: '/media/profiles/author/avatar.webp',
    });
    expect(card).toMatch(/<a href="#\/profile\/author" class="post-author"[\s\S]*?<span class="post-avatar">/);
    expect(card).toContain('src="/media/profiles/author/avatar.webp"');
  });

  it('keeps both composer avatars in sync with the current Worker profile and shows a placeholder while loading', () => {
    const workerProfile = mergeLatestDisplayProfile(
      { uid: 'viewer', displayName: 'Aki', photoURL: 'https://firebasestorage.googleapis.com/v0/b/old/avatar' },
      { uid: 'viewer', photoURL: '/media/viewer/profiles/avatar_latest.webp' },
    )!;
    const markup = renderCreatePostForm(workerProfile);
    expect((markup.match(/data-current-user-avatar/g) || [])).toHaveLength(2);
    expect((markup.match(/src="\/media\/viewer\/profiles\/avatar_latest\.webp"/g) || [])).toHaveLength(2);
    expect(markup).toContain('<input type="file" id="post-image-file" multiple');
    expect(markup).not.toContain('id="post-image-file" accept=');

    const loadingMarkup = renderCreatePostForm({ uid: 'viewer', displayName: 'Aki' }, { avatarLoading: true });
    expect((loadingMarkup.match(/class="avatar-fallback avatar-image-placeholder skeleton-avatar"/g) || [])).toHaveLength(2);
    expect(loadingMarkup).not.toContain('>A</div>');

    composerAvatarNodes.splice(0, composerAvatarNodes.length, makeComposerAvatarNode(), makeComposerAvatarNode());
    updateCurrentUserComposerAvatars(workerProfile);
    expect(composerAvatarNodes.every((node) => node.innerHTML.includes('src="/media/viewer/profiles/avatar_latest.webp"'))).toBe(true);
    expect(composerAvatarNodes.every((node) => node.href === '#/profile/viewer')).toBe(true);

    updateCurrentUserComposerAvatars(null);
    expect(composerAvatarNodes.every((node) => node.innerHTML.includes('skeleton-avatar'))).toBe(true);
    expect(composerAvatarNodes.every((node) => node.href === '')).toBe(true);
  });

  it('resolves latest profiles for home, Explore, profile posts, and comments', async () => {
    const [database, home, explore, profile, friends, components, worker] = await Promise.all([
      readFile(new URL('../src/db.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pageModules/home.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pageModules/explore.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pageModules/profile.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pageModules/friends.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/components.ts', import.meta.url), 'utf8'),
      readFile(new URL('../worker/index.ts', import.meta.url), 'utf8'),
    ]);
    expect(database).toContain('getDisplayUserProfile(uid: string)');
    expect(database).toContain('fetchLatestProfileProjectionData(uid)');
    expect(database).toContain('buildLatestProfileProjection(uid, latestData, firestoreProfile)');
    expect(database).toContain('getDisplayUserProfilesByIds(authorIds)');
    expect(home).toContain('getDisplayUserProfile(uid)');
    expect(home).toContain("getDisplayUserProfile(original.userId || '')");
    expect(home).toContain('getDisplayUserProfile(data.userId)');
    expect(home).toContain('getDisplayUserProfilesByIds(likes.map');
    expect(explore).toContain('getDisplayUserProfile(uid)');
    expect(profile).toContain('getDisplayUserProfile(uid)');
    expect(database).toContain('getDisplayUserProfilesByIds(fromUserIds)');
    expect(home).toContain('getDisplayUserProfile(uid).catch');
    expect(profile).toContain('createAvatarHTML(profile as unknown as Partial<UserProfile>, 104');
    expect(friends).toContain("createAvatarHTML(user as unknown as Partial<UserProfile>, 40, { imageClassName: 'search-result-avatar'");
    expect(friends).toContain("createAvatarHTML(friend as unknown as Partial<UserProfile>, 46, { imageClassName: 'friend-avatar-img'");
    expect(profile).toContain("createAvatarHTML(friend as unknown as Partial<UserProfile>, 46, { imageClassName: 'friend-avatar-img'");
    expect(components).toContain('createAvatarHTML(from, 40)');
    expect(home).toContain('createAvatarHTML(profile, 64)');
    expect(home).toContain('createAvatarHTML(user, 40)');
    expect(worker).toContain("path === '/api/profiles'");
    expect(worker).toContain('pr.avatar_url=? OR pr.cover_url=?');
  });

  it('hydrates the signed-in Composer from the shared profile resolver and refreshes its rendered avatars', async () => {
    const [main, home] = await Promise.all([
      readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pageModules/home.ts', import.meta.url), 'utf8'),
    ]);
    expect(main).toContain('getDisplayUserProfile(firebaseUser.uid)');
    expect(main).toContain("onStateChange('userProfile', (profile) => updateCurrentUserComposerAvatars(profile))");
    expect(home).toContain('currentProfile?.uid === currentUser.uid');
    expect(home).toContain('{ avatarLoading: !hasCurrentProfile }');
  });

  it('resolves stale Firebase video URLs by the exact storage key recorded in post media', () => {
    const sourceURL = 'https://firebasestorage.googleapis.com/v0/b/connect-b5e82.firebasestorage.app/o/posts%2Fauthor%2Fvideo_123.mp4?alt=media&token=secret';
    expect(storagePathFromMediaURL(sourceURL)).toBe('posts/author/video_123.mp4');
    expect(canonicalVideoURLFromPostMedia([
      { kind: 'image', storagePath: 'posts/author/cover.jpg', mimeType: 'image/jpeg', url: '/media/migration/post/0.jpg' },
      { kind: 'video', storagePath: 'posts/author/video_123.mp4', mimeType: 'video/mp4', url: '/media/migration/legacy/sha256/123' },
    ], sourceURL)).toBe('/media/migration/legacy/sha256/123');
    expect(canonicalVideoURLFromPostMedia([
      { kind: 'video', storagePath: 'posts/another/video_123.mp4', mimeType: 'video/mp4', url: '/media/migration/legacy/wrong' },
    ], sourceURL)).toBe('');
    expect(canonicalVideoURLFromPostMedia([
      { kind: 'video', storagePath: 'posts/author/video_123.mp4', mimeType: 'video/mp4', url: '/media/legacy/wrong' },
    ], sourceURL)).toBe('');
    expect(canonicalVideoURLFromPostMedia([
      { kind: 'video', mimeType: 'video/mp4', url: '/media/migration/legacy/sha256/123' },
    ], '/media/legacy/old-video.mp4')).toBe('/media/migration/legacy/sha256/123');
  });

  it('requests a scoped playback route for newly uploaded post media', () => {
    const sourceURL = '/media/posts/author/video_123.webm';
    const ticketedURL = '/media/posts/author/video_123.webm?ticket=short-lived-ticket';
    expect(storagePathFromMediaURL(sourceURL)).toBe('posts/author/video_123.webm');
    expect(canonicalVideoURLFromPostMedia([
      { kind: 'video', storagePath: 'posts/author/video_123.webm', mimeType: 'video/webm', url: ticketedURL },
    ], sourceURL)).toBe(ticketedURL);
  });

  it('resolves stale image previews to the migrated post image and preserves a fresh preview ticket', () => {
    const stalePreview = 'https://firebasestorage.googleapis.com/v0/b/connect.firebasestorage.app/o/posts%2Fauthor%2Fthumb.webp?alt=media&token=old';
    const route = '/media/posts/author/thumb.webp?ticket=short-lived-ticket';
    expect(canonicalPostMediaURLFromPostMedia([
      { kind: 'image', storagePath: 'posts/author/full.jpg', previewStoragePath: 'posts/author/thumb.webp', originalUrl: 'https://firebasestorage.googleapis.com/v0/b/connect.firebasestorage.app/o/posts%2Fauthor%2Ffull.jpg?token=old', url: '/media/migration/post-1/0.jpg', previewUrl: route },
    ], stalePreview, 'image', 0)).toBe(route);
    expect(canonicalPostMediaURLFromPostMedia([
      { kind: 'image', storagePath: 'posts/other/full.jpg', url: '/media/migration/post-2/0.jpg' },
    ], 'https://firebasestorage.googleapis.com/v0/b/connect.firebasestorage.app/o/posts%2Fauthor%2Ffull.jpg?token=old', 'image', 0)).toBe('');
  });

  it('matches an old Firebase preview filename to its migrated original storage key', () => {
    const oldPreview = 'https://firebasestorage.googleapis.com/v0/b/connect-b5e82.firebasestorage.app/o/posts%2Fauthor%2Fimage_123_ltdit5_preview.webp?alt=media&token=old';
    const migratedRoute = '/media/migration/legacy/sha256/1789993625349328?ticket=short-lived-ticket';
    expect(canonicalPostMediaURLFromPostMedia([
      { kind: 'image', storagePath: 'posts/author/image_123_ltdit5.png', url: migratedRoute },
    ], oldPreview, 'image', 0)).toBe(migratedRoute);
    expect(canonicalPostMediaURLFromPostMedia([
      { kind: 'image', storagePath: 'posts/another/image_123_ltdit5.png', url: '/media/migration/legacy/wrong' },
    ], oldPreview, 'image', 0)).toBe('');
  });

  it('normalizes singular legacy image and attachment video fields', () => {
    const post = toPost({
      imageURL: 'https://firebasestorage.googleapis.com/v0/b/old/o/legacy.jpg?token=old',
      attachments: [{ id: 'video-1', kind: 'video', url: '/media/posts/author/clip.mp4', name: 'clip', size: 10, mimeType: 'video/mp4' }],
    }, 'legacy-post');
    expect(post.imageURLs).toEqual(['https://firebasestorage.googleapis.com/v0/b/old/o/legacy.jpg?token=old']);
    expect(post.imageURL).toBe(post.imageURLs[0]);
    expect(post.videoURL).toBe('/media/posts/author/clip.mp4');
  });

  it('keeps the user content category off ordinary post cards while retaining visibility badges', () => {
    const author = { uid: 'author', displayName: 'Aki', username: 'aki' };
    const card = renderPostCard({ id: 'user-post', userId: 'author', text: 'hello', contentType: 'user', visibility: 'friends' }, author);
    expect(card).not.toContain('content-kind-user');
    expect(card).not.toContain('post-badge content-kind-badge');
    expect(card).toContain('visibility-badge');
    const newsCard = renderPostCard({ id: 'news-post', userId: 'author', text: 'news', contentType: 'news' }, author);
    expect(newsCard).toContain('content-kind-badge content-kind-news');
    expect(newsCard).toContain('ニュース');
  });

  it('adds a resolver and visible fallback to post images without hiding the whole tile on failure', () => {
    const card = renderPostCard({ id: 'image-post', userId: 'author', text: 'hello', imageURLs: ['/old/image.jpg'] }, {
      uid: 'author', displayName: 'Aki', username: 'aki', photoURL: '',
    });
    expect(card).toContain('data-post-media-image="true" data-post-id="image-post" data-media-kind="image"');
    expect(card).toContain('class="post-image-media-fallback" role="status" hidden');
    expect(card).not.toContain('onerror="this.parentElement.style.display=\'none\'"');
  });

  it('renders image and video attachments together in one post card', () => {
    const post = toPost({
      authorId: 'author',
      text: 'mixed media',
      attachments: [
        { id: 'image-1', kind: 'image', url: '/media/posts/author/image.jpg', name: 'image.jpg', size: 12, mimeType: 'image/jpeg' },
        { id: 'video-1', kind: 'video', url: '/media/posts/author/video.mp4', name: 'video.mp4', size: 34, mimeType: 'video/mp4' },
      ],
    }, 'mixed-post');
    const card = renderPostCard(post, { uid: 'author', displayName: 'Aki', username: 'aki', photoURL: '' });

    expect(card).toContain('src="/media/posts/author/image.jpg"');
    expect(card).toContain('data-media-kind="image"');
    expect(card).toContain('<video data-post-id="mixed-post" data-src="/media/posts/author/video.mp4"');
  });

  it('loads profile video thumbnails lazily and seeks to a real frame without starting playback', async () => {
    const profile = await readFile(new URL('../src/pageModules/profile.ts', import.meta.url), 'utf8');
    const thumbnailSetup = profile.slice(profile.indexOf('function setupProfileMediaVideoThumbnails'), profile.indexOf('async function loadProfileMediaLegacy'));
    expect(profile).toContain('data-profile-media-video="true"');
    expect(thumbnailSetup).toContain('new IntersectionObserver');
    expect(thumbnailSetup).toContain('video.currentTime = frameTime');
    expect(thumbnailSetup).toContain("video.addEventListener('seeked', showFrame");
    expect(thumbnailSetup).not.toContain('video.play()');
  });

  it('carries a video post id to the lazy player for canonical source lookup', () => {
    const card = renderPostCard({ id: 'video-post', userId: 'author', text: 'hello', videoURL: 'https://firebasestorage.googleapis.com/v0/b/old/o/video.mp4?token=old' }, {
      uid: 'author', displayName: 'Aki', username: 'aki', photoURL: '/media/profiles/author/avatar.webp',
    });
    expect(card).toContain('class="post-video post-video-lazy" data-post-id="video-post"');
    expect(card).toContain('<video data-post-id="video-post"');
  });
});
