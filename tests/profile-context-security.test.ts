import { describe, expect, it } from 'vitest';
import { buildProfileContextManifest, selectMedia, serializeContext } from '../worker/ai/context';
import type { D1Database } from '@cloudflare/workers-types';

type QueryCall = { sql: string; bindings: unknown[] };

function post(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    author_id: 'profile-1',
    body: `public body ${id}`,
    visibility: 'public',
    deleted_at: null,
    created_at: 1,
    quoted_post_id: null,
    reply_to_post_id: null,
    thread_root_id: null,
    content_version: 1,
    access_version: 1,
    media_version: 1,
    structure_version: 1,
    media_json: null,
    accepted_policy_version: 'connect-ai-policy-v1',
    preference_version: 1,
    text_analysis: 'PUBLIC_ONLY',
    media_analysis: 'PUBLIC_ONLY',
    post_ai_text_analysis: null,
    post_ai_media_analysis: null,
    post_ai_consent_version: null,
    ...overrides,
  };
}

function comment(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    author_id: 'profile-1',
    body: `reply body ${id}`,
    visibility: 'public',
    deleted_at: null,
    parent_deleted_at: null,
    created_at: 1,
    content_version: 1,
    access_version: 1,
    media_version: 1,
    structure_version: 1,
    media_json: null,
    accepted_policy_version: 'connect-ai-policy-v1',
    preference_version: 1,
    text_analysis: 'PUBLIC_ONLY',
    media_analysis: 'PUBLIC_ONLY',
    post_ai_text_analysis: null,
    post_ai_media_analysis: null,
    post_ai_consent_version: null,
    ...overrides,
  };
}

function fakeDb(options: {
  blocked?: boolean;
  profilePreference?: Record<string, unknown> | null;
  posts?: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
} = {}): { db: D1Database; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const session = {
    prepare(sql: string) {
      const call: QueryCall = { sql, bindings: [] };
      calls.push(call);
      return {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return {
            async first<T>() {
              if (sql.includes('FROM profiles')) return { id: 'profile-1', display_name: 'Test User', username: 'test', bio: '公開プロフィール', updated_at: 1 } as T;
              if (sql.includes('FROM blocks')) return (options.blocked ? { blocked: 1 } : null) as T | null;
              if (sql.includes('ai_author_preferences')) return (options.profilePreference === undefined
                ? { accepted_policy_version: 'connect-ai-policy-v1', preference_version: 1, text_analysis: 'PUBLIC_ONLY', media_analysis: 'PUBLIC_ONLY' }
                : options.profilePreference) as T | null;
              return null;
            },
            async all<T>() {
              if (sql.includes('FROM comments c')) return { results: (options.comments || []).slice(0, 80) as T[] };
              if (sql.includes('FROM posts p')) return { results: (options.posts || []).slice(0, 80) as T[] };
              return { results: [] as T[] };
            },
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    },
  };
  return { db: { withSession: () => session } as unknown as D1Database, calls };
}

describe('profile Ask AI context security boundary', () => {
  it('filters restricted, deleted, and unviewable rows before context and media selection', async () => {
    const { db, calls } = fakeDb({
      posts: [
        post('p-public', { created_at: 10, media_json: JSON.stringify([{ url: '/media/public.jpg', mimeType: 'image/jpeg' }]) }),
        post('p-limited-no-consent', { visibility: 'friends', body: 'LIMITED SECRET no consent', created_at: 9 }),
        post('p-limited-consented', { visibility: 'friends', body: 'LIMITED SECRET consented', post_ai_text_analysis: 'AUTHORIZED_CONTEXT', post_ai_media_analysis: 'AUTHORIZED_CONTEXT', created_at: 8 }),
        post('p-private-consented', { visibility: 'private', body: 'PRIVATE SECRET consented', post_ai_text_analysis: 'AUTHORIZED_CONTEXT', created_at: 7 }),
        post('p-deleted', { body: 'DELETED SECRET', deleted_at: 123, created_at: 6 }),
        post('p-no-image-consent', { body: 'public text is okay', media_analysis: 'DISABLED', media_json: JSON.stringify([{ url: '/media/opted-out.jpg', mimeType: 'image/jpeg' }]), created_at: 5 }),
      ],
      comments: [
        comment('r-public', { created_at: 10 }),
        comment('r-limited', { visibility: 'friends', body: 'REPLY LIMITED SECRET', created_at: 9 }),
        comment('r-deleted', { body: 'REPLY DELETED SECRET', deleted_at: 123, created_at: 8 }),
        comment('r-parent-deleted', { body: 'REPLY PARENT DELETED SECRET', parent_deleted_at: 123, created_at: 7 }),
      ],
    });

    const manifest = await buildProfileContextManifest(db, 'viewer-1', 'profile-1', 'test-consent-secret', false, [
      'p-public', 'p-limited-no-consent', 'p-limited-consented', 'p-private-consented', 'p-deleted', 'p-no-image-consent',
    ]);
    expect(manifest).not.toBeNull();
    const ids = manifest!.sources.map((source) => source.actualId);
    expect(ids).toEqual(expect.arrayContaining(['profile-1', 'p-public', 'p-no-image-consent']));
    for (const forbidden of ['p-limited-no-consent', 'p-limited-consented', 'p-private-consented', 'p-deleted', 'r-public', 'r-limited', 'r-deleted', 'r-parent-deleted']) {
      expect(ids).not.toContain(forbidden);
    }

    const serialized = serializeContext(manifest!);
    expect(serialized).not.toContain('LIMITED SECRET');
    expect(serialized).not.toContain('PRIVATE SECRET');
    expect(serialized).not.toContain('DELETED SECRET');
    const selected = selectMedia(manifest!, 'VISION_REQUIRED', 'ALL_RELEVANT');
    expect(selected.map((item) => item.objectKey)).toEqual(['public.jpg']);
    expect(manifest!.media.find((item) => item.objectKey === 'opted-out.jpg')?.allowedByConsent).toBe(false);

    const postQuery = calls.find((call) => call.sql.includes('FROM posts p'))!;
    expect(postQuery.sql).toContain("p.visibility='public'");
    expect(postQuery.sql).toContain('p.deleted_at IS NULL');
    expect(postQuery.sql).toContain('NOT EXISTS (SELECT 1 FROM blocks');
    expect(postQuery.sql).toContain('p.id IN (?,?,?,?,?,?)');
    expect(postQuery.sql).toContain('LIMIT 80');
    expect(postQuery.bindings).toEqual(['profile-1', 'p-public', 'p-limited-no-consent', 'p-limited-consented', 'p-private-consented', 'p-deleted', 'p-no-image-consent', 'viewer-1', 'viewer-1']);
    expect(calls.some((call) => call.sql.includes('FROM comments c'))).toBe(false);
  });

  it('fails closed for a block and never acquires profile posts or replies', async () => {
    const { db, calls } = fakeDb({ blocked: true, posts: [post('blocked-post')], comments: [comment('blocked-reply')] });
    await expect(buildProfileContextManifest(db, 'viewer-1', 'profile-1', 'test-consent-secret')).resolves.toBeNull();
    expect(calls.some((call) => call.sql.includes('FROM posts p') || call.sql.includes('FROM comments c'))).toBe(false);
  });

  it('honors the database acquisition bounds of 80 posts and 80 replies', async () => {
    const posts = Array.from({ length: 100 }, (_, index) => post(`p-${index}`, { created_at: 1_000 - index }));
    const comments = Array.from({ length: 100 }, (_, index) => comment(`r-${index}`, { created_at: 1_000 - index }));
    const { db } = fakeDb({ posts, comments });
    const manifest = await buildProfileContextManifest(db, 'viewer-1', 'profile-1', 'test-consent-secret', false, ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7', 'p-8', 'p-9', 'p-10', 'p-11']);
    expect(manifest).not.toBeNull();
    expect(manifest!.sources.filter((source) => source.type === 'post')).toHaveLength(12);
    expect(manifest!.sources.filter((source) => source.type === 'comment')).toHaveLength(0);
  });

  it('serializes every profile-owner post as the same author', async () => {
    const { db } = fakeDb({ posts: [
      post('recent-1', { created_at: 30, body: 'first profile post' }),
      post('recent-2', { created_at: 20, body: 'second profile post' }),
      post('recent-3', { created_at: 10, body: 'third profile post' }),
    ] });
    const manifest = await buildProfileContextManifest(db, 'viewer-1', 'profile-1', 'test-consent-secret', false, ['recent-1', 'recent-2', 'recent-3']);
    const context = JSON.parse(serializeContext(manifest!)) as { posts: Array<{ author: string; text: string }> };

    expect(context.posts).toHaveLength(4);
    expect(context.posts.map((source) => source.author)).toEqual(Array(4).fill('CurrentAuthor'));
    expect(context.posts.map((source) => source.text)).toEqual(expect.arrayContaining([
      '表示名: Test User\nユーザー名: @test\n自己紹介: 公開プロフィール',
      'first profile post', 'second profile post', 'third profile post',
    ]));
  });

  it('keeps recent multi-image profile context bounded to four consented images', async () => {
    const posts = Array.from({ length: 6 }, (_, index) => post(`image-post-${index}`, {
      created_at: 1_000 - index,
      body: `recent visual post ${index}`,
      media_json: JSON.stringify([{ url: `/media/recent-${index}.webp`, mimeType: 'image/webp' }]),
    }));
    const { db } = fakeDb({ posts });
    const manifest = await buildProfileContextManifest(db, 'viewer-1', 'profile-1', 'test-consent-secret', false, posts.map((row) => String(row.id)));
    expect(manifest).not.toBeNull();
    const selected = selectMedia(manifest!, 'VISION_REQUIRED', 'ALL_RELEVANT');
    expect(selected).toHaveLength(4);
    expect(selected.map((item) => item.objectKey)).toEqual([
      'recent-0.webp', 'recent-1.webp', 'recent-2.webp', 'recent-3.webp',
    ]);
    expect(serializeContext(manifest!)).toContain('recent visual post 0');
  });

  it('bounds long profile serialization below the profile-specific context ceiling', async () => {
    const longBody = '情報量のある公開投稿。'.repeat(900);
    const posts = Array.from({ length: 80 }, (_, index) => post(`long-${index}`, {
      created_at: 1_000 - index,
      body: longBody,
    }));
    const { db } = fakeDb({ posts });
    const manifest = await buildProfileContextManifest(db, 'viewer-1', 'profile-1', 'test-consent-secret', false, posts.map((row) => String(row.id)));
    expect(manifest).not.toBeNull();
    const serialized = serializeContext(manifest!);
    expect(serialized.length).toBeLessThanOrEqual(32_000);
    expect(manifest!.contextTruncated).toBe(true);
  });

  it('does not expose profile information when the profile author disabled text analysis', async () => {
    const { db } = fakeDb({
      profilePreference: { accepted_policy_version: 'connect-ai-policy-v1', preference_version: 2, text_analysis: 'DISABLED', media_analysis: 'PUBLIC_ONLY' },
      posts: [post('should-not-be-sent')],
      comments: [comment('reply-should-not-be-sent')],
    });
    await expect(buildProfileContextManifest(db, 'viewer-1', 'profile-1', 'test-consent-secret', false, ['should-not-be-sent'])).resolves.toBeNull();
  });
});
