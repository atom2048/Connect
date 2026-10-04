import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { toUserProfile } from '../src/types/converters';
import { authorPostQuery, buildExploreRouteHash, parseExploreRouteState } from '../src/exploreRouteState';
import { getPostContentKind } from '../src/contentKinds';
import { validateNotificationSource } from '../functions/lib/source-validation.js';
import { notificationCopy, notificationId, notificationUrl } from '../functions/lib/notification-domain.js';
import { materializeCommentLikeNotification } from '../functions/lib/comment-like-notification.js';

describe('Connect six-fix regressions', () => {
  it('restores legacy image fields and prefers saved canonical images', () => {
    expect(toUserProfile({ avatarUrl: '/media/profiles/u/avatar.webp', coverImage: 'cover' }, 'u')).toMatchObject({ photoURL: '/media/profiles/u/avatar.webp', coverURL: 'cover' });
    expect(toUserProfile({ photoURL: '/media/profiles/u/new.webp', avatarUrl: '/media/profiles/u/old.webp', coverURL: 'new-cover', coverImage: 'old-cover' }, 'u')).toMatchObject({ photoURL: '/media/profiles/u/new.webp', coverURL: 'new-cover' });
    expect(toUserProfile({ photoURL: null, avatarURL: '/media/profiles/u/avatar.webp', coverURL: '', coverUrl: 'cover' }, 'u')).toMatchObject({ photoURL: '/media/profiles/u/avatar.webp', coverURL: 'cover' });
  });
  it('uses the latest Worker profile projection and persists both images through authenticated R2', async () => {
    const [client, profile, vercel] = await Promise.all([
      readFile(new URL('../src/db.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pageModules/profile.ts', import.meta.url), 'utf8'),
      readFile(new URL('../vercel.json', import.meta.url), 'utf8').then(JSON.parse),
    ]);
    expect(client).toContain("?includePosts=false");
    expect(client).toContain("method: 'PUT'");
    expect(client).toContain("Authorization: `Bearer ${await user.getIdToken()}`");
    expect(client).toContain("patch.coverUrl = updateData.coverURL");
    expect(client).toContain('const key = `profiles/${uid}/${kind}_');
    expect(client).toContain('payload.url.startsWith(`/media/profiles/${uid}/`)');
    expect(profile).toContain('getDisplayUserProfile(targetUid)');
    expect(profile).toContain('profile.coverURL || profile.coverPhotoPreviewURL || profile.coverImage');
    expect(vercel.rewrites).toContainEqual({
      source: '/media/:path*',
      destination: 'https://connect-social-standalone.quest-live.workers.dev/media/:path*',
    });
  });
  it('opens Trends and preserves the author search insertion space', () => {
    expect(parseExploreRouteState('#/explore').tab).toBe('trending');
    expect(parseExploreRouteState('#/explore?tab=news').tab).toBe('news');
    const route = parseExploreRouteState(buildExploreRouteHash('@Mottie ', 'posts', 'profile-123'));
    expect(route).toEqual({ query: '@Mottie ', tab: 'posts', authorId: 'profile-123' });
    expect(authorPostQuery(route.query, route.authorId)).toBe('');
    expect(authorPostQuery('@Mottie 猫', route.authorId)).toBe('猫');
  });
  it('does not redirect an explicitly selected Explore tab to News', async () => {
    const explore = await readFile(new URL('../src/pageModules/explore.ts', import.meta.url), 'utf8');
    expect(explore).not.toContain("navigateExplore('', 'news')");
    expect(explore).toContain('id="explore-panel-${state.tab}"');
  });
  it.each([undefined, null, '', ' ', 'unclassified', 'none', 'unknown'])('does not assign a content category for %s', contentType => {
    expect(getPostContentKind({ contentType })).toBe('unclassified');
  });
  it('does not render a tag when a post has no category', async () => {
    const components = await readFile(new URL('../src/components.ts', import.meta.url), 'utf8');
    expect(components).toMatch(/const contentKindLabel = contentKind === 'unclassified'\s*\? ''/);
    expect(components).toContain('${contentKindLabel || showVisibilityBadge || isScheduled || post.editedAt || (post.hashtags || []).length ? `<div class="post-badges">');
  });
  it('routes rendered comment-like notifications to the specific comment', async () => {
    const components = await readFile(new URL('../src/components.ts', import.meta.url), 'utf8');
    expect(components).toContain("notif.commentId ? `?commentId=${encodeURIComponent(notif.commentId)}` : ''");
  });
  const records: Record<string, object> = {
    'comments/c': { userId: 'owner', postId: 'p' },
    'posts/p': { userId: 'someone-else' },
    'likes/comment_c_actor': { type: 'comment', userId: 'actor', commentId: 'c', eventId: 'comment_c_actor' },
  };
  const db = { doc: (path: string) => ({ get: async () => ({ exists: !!records[path], id: path.split('/').at(-1), data: () => records[path] }) }) };
  const notification = { type: 'like', fromUserId: 'actor', userId: 'owner', postId: 'p', commentId: 'c', eventId: 'comment_c_actor' };
  it('notifies the comment owner, never an arbitrary post owner or forged actor', async () => {
    expect(await validateNotificationSource(db, 'actor', notification)).toEqual({ valid: true });
    for (const patch of [{ userId: 'someone-else' }, { postId: 'wrong' }, { eventId: 'random' }, { userId: 'actor' }, { fromUserId: 'fake' }]) {
      expect((await validateNotificationSource(db, 'actor', { ...notification, ...patch })).valid).toBe(false);
    }
  });
  it('deduplicates retries and gives comment-specific copy and a working post route', () => {
    const identity = { type: 'like', actorId: 'actor', recipientId: 'owner', eventId: 'comment_c_actor' };
    expect(notificationId(identity)).toBe(notificationId({ ...identity }));
    expect(notificationId({ ...identity, eventId: 'comment_other_actor' })).not.toBe(notificationId(identity));
    expect(notificationCopy('like', notification).body).toContain('コメントにいいね');
    expect(notificationUrl(notification)).toBe('/#/post/p?commentId=c');
  });
  it('materializes a durable notification once across repeated trigger delivery', async () => {
    const store: Record<string, object> = { ...records };
    const snapshot = (path: string) => ({ exists: !!store[path], data: () => store[path] });
    const triggerDb = {
      doc: (path: string) => ({ path, get: async () => snapshot(path) }),
      runTransaction: async (callback: (tx: unknown) => Promise<boolean>) => callback({
        get: async (ref: { path: string }) => snapshot(ref.path),
        create: (ref: { path: string }, data: object) => { store[ref.path] = data; },
      }),
    };
    const like = { ...records['likes/comment_c_actor'], createdAt: { toMillis: () => 1000 } };
    expect(await materializeCommentLikeNotification(triggerDb, like, 'comment_c_actor')).toBe(true);
    expect(await materializeCommentLikeNotification(triggerDb, like, 'comment_c_actor')).toBe(false);
    expect(Object.keys(store).filter(path => path.startsWith('notifications/'))).toHaveLength(1);
  });
  it('does not create a notification when the comment author likes their own comment', async () => {
    const store: Record<string, object> = {
      ...records,
      'comments/self': { userId: 'actor', postId: 'p' },
      'likes/comment_self_actor': { type: 'comment', userId: 'actor', commentId: 'self', eventId: 'comment_self_actor' },
    };
    const dbForSelfLike = {
      doc: (path: string) => ({ path, get: async () => ({ exists: !!store[path], data: () => store[path] }) }),
      runTransaction: async (callback: (tx: unknown) => Promise<boolean>) => callback({
        get: async (ref: { path: string }) => ({ exists: !!store[ref.path], data: () => store[ref.path] }),
        create: (ref: { path: string }, data: object) => { store[ref.path] = data; },
      }),
    };
    const selfLike = { ...store['likes/comment_self_actor'], createdAt: { toMillis: () => 1000 } };
    expect(await materializeCommentLikeNotification(dbForSelfLike, selfLike, 'comment_self_actor')).toBe(false);
    expect(Object.keys(store).filter(path => path.startsWith('notifications/'))).toHaveLength(0);
  });
  it('validates comment-like writes server-side while preserving post-like writes', async () => {
    const [rules, client, functions] = await Promise.all([
      readFile(new URL('../firestore.rules', import.meta.url), 'utf8'),
      readFile(new URL('../src/db.ts', import.meta.url), 'utf8'),
      readFile(new URL('../functions/index.js', import.meta.url), 'utf8'),
    ]);
    expect(rules).toContain("likeId == 'comment_' + request.resource.data.commentId + '_' + request.auth.uid");
    expect(rules).toContain("request.resource.data.eventId == likeId");
    expect(rules).toContain("request.resource.data.get('type', '') != 'comment'");
    const toggleSource = client.split('export async function toggleCommentLike', 2)[1]?.split('export async function hasCommentLiked', 1)[0] || '';
    expect(toggleSource).toContain('transaction.set(likeRef');
    expect(toggleSource).not.toContain('createNotification(');
    expect(functions).toContain("document: 'likes/{likeId}'");
    expect(functions).toContain('materializeCommentLikeNotification(db, event.data?.data(), event.params.likeId)');
  });
  it('keeps the search field glass-styled and narrow-screen safe', async () => {
    const [explore, css] = await Promise.all([
      readFile(new URL('../src/pageModules/explore.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
    ]);
    expect(explore).toContain('class="explore-search-icon"');
    expect(css).toContain('.explore-search-field:focus-within');
    expect(css).toContain('max-width: 520px');
    expect(css).toMatch(/@media \(max-width: 520px\) \{\s*\.explore-page \{ max-width: 100%; \}/);
    expect(css).toContain('min-width: 0');
    expect(css).toContain('var(--card-bg)');
  });
  it('starts profile search in focused author-scoped Posts mode with a trailing insertion space', async () => {
    const [profile, explore, client, api] = await Promise.all([
      readFile(new URL('../src/pageModules/profile.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pageModules/explore.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/db.ts', import.meta.url), 'utf8'),
      readFile(new URL('../api/search/posts.js', import.meta.url), 'utf8'),
    ]);
    expect(profile).toContain("buildExploreRouteHash(`@${username.replace(/^@/, '')} `, 'posts', profileId)");
    expect(explore).toContain('input.focus();');
    expect(explore).toContain('input.setSelectionRange(input.value.length, input.value.length);');
    expect(explore).toContain("searchPosts(authorPostQuery(queryText, authorId), postLimit, postCursor, authorId || undefined)");
    expect(client).toContain('authorId?: string');
    expect(api).toContain(".where('userId', '==', authorId)");
    expect(api).toContain("const terms = splitSearchTerms(text);");
  });
});
