import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { authorFromRow, decodeCursor, encodeCursor, isProductionFixturePost, postFromRow, productionFixturePredicate, visibilityPredicate } from '../worker/lib';

describe('Cloudflare canonical identity contract', () => {
  it('resolves a post author from the current joined profile', () => {
    const post = postFromRow({ id: 'p1', author_id: 'u1', body: 'hello', visibility: 'public', created_at: 10, updated_at: 10, author_profile_id: 'u1', author_name: 'Current name', author_username: 'current', author_avatar_color: '#111', counts_json: '{"likes":2}' });
    expect(post.author).toMatchObject({ id: 'u1', displayName: 'Current name', username: 'current' });
    expect(post).not.toHaveProperty('authorSnapshot');
  });

  it('uses a non-linkable fallback only when the current profile is missing', () => {
    const author = authorFromRow({ author_id: 'deleted-user', author_profile_id: null, author_name: null, author_username: null, author_avatar_url: null, author_avatar_color: null });
    expect(author).toMatchObject({ id: 'deleted-user', displayName: '削除されたユーザー', username: 'deleted', isUnavailable: true });
    expect(author).not.toHaveProperty('authorSnapshot');
  });

  it('builds a visibility predicate that excludes deleted and blocked records', () => {
    const predicate = visibilityPredicate('viewer-1');
    expect(predicate.sql).toContain('deleted_at IS NULL');
    expect(predicate.sql).toContain('FROM blocks');
    expect(predicate.sql).toContain('visibility = \'friends\'');
    expect(predicate.sql.endsWith('))')).toBe(true);
    expect(predicate.bindings).toEqual(['viewer-1', 'viewer-1', 'viewer-1', 'viewer-1', 'viewer-1']);
  });

  it('round-trips cursor pagination state', () => {
    const cursor = encodeCursor(123, 'post-1');
    expect(decodeCursor(cursor)).toEqual({ createdAt: 123, postId: 'post-1' });
  });

  it('keeps historical Ask AI fixtures out of the production content boundary', () => {
    expect(isProductionFixturePost('ask_ai_smoke_public_20260831', 'normal')).toBe(true);
    expect(isProductionFixturePost('real-post-id', 'Ask AI Vision production synthetic test: 青い円')).toBe(true);
    expect(isProductionFixturePost('real-post-id', '通常の投稿で synthetic data について説明します')).toBe(false);
    expect(isProductionFixturePost('real-post-id', '通常の公開投稿')).toBe(false);
    expect(productionFixturePredicate('p')).toContain("instr(lower(p.id), 'ask_ai_smoke_')");
    expect(productionFixturePredicate('p')).toContain("NOT LIKE 'connect ask ai production smoke test.%'");
    expect(productionFixturePredicate('p')).toContain("NOT LIKE 'ask ai vision production synthetic test:%'");
  });

  it('keeps Firebase/Vercel out of the Cloudflare Worker runtime', async () => {
    const source = await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from|require\s*\()\s*['"`][^'"`]*(?:firebase|vercel)/i);
  });

  it('allows the approved frontend origin to read a public post-detail response directly from the Worker', async () => {
    const source = await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('posts\\/[^/]+(?:\\/(?:ask-ai|ai-consent))?$');
    expect(source).toContain("'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'");
    expect(source).toContain('return withAiCors(request, env, await route(request, env));');
  });

  it('joins current profiles for every post query and scopes profile search by author ID', async () => {
    const source = await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('LEFT JOIN profiles pr ON pr.id = p.author_id');
    expect(source).toContain('authorId, search: fts');
    expect(source).toContain('authorId: profileId');
    expect(source).toContain('ON CONFLICT(id) DO UPDATE SET email = coalesce(excluded.email, profiles.email)');
    expect(source).not.toContain('display_name = excluded.display_name, email = excluded.email');
  });

  it('declares D1 FTS5 and the performance indexes', async () => {
    const migration = await readFile(new URL('../drizzle/0000_bright_wolfpack.sql', import.meta.url), 'utf8');
    expect(migration).toContain('CREATE VIRTUAL TABLE posts_fts USING fts5');
    expect(migration).toContain('posts_public_time_idx');
  });
});
