import { getViewer } from './auth';
import {
  all,
  createQueryContext,
  cursorPredicate,
  decodeCursor,
  encodeCursor,
  error,
  first,
  id,
  json,
  normalizeLimit,
  now,
  authorFromRow,
  postFromRow,
  profileFromRow,
  productionFixturePredicate,
  isProductionFixturePost,
  run,
  visibilityPredicate,
} from './lib';
import type { Env, PostRow, ProfileRow, PushJob, Viewer } from './types';
import type { D1Database } from '@cloudflare/workers-types';
import { askAi, aiFeedback, aiPreferences, aiStatus, postAiConsent, profileAskAi } from './ai/handler';
import { consentFor } from './ai/context';
import { cleanupAiStorage } from './ai/cache';
import { refreshEndpointPolicies } from './ai/policy-health';
import { controlFetch } from './ai/control-plane';
import { AiPredeployError, runAiPredeploy } from './ai/predeploy';
import { createMediaAccessTicket, verifyMediaAccessTicket } from './mediaAccess';
import { parseMediaByteRange, resolveMediaByteRange } from './mediaRange';
import { canonicalPostMediaKey, postMediaObjectKeys, resolveLegacyMediaObjects } from './legacyMedia';
import { createCommentRecord, createPostRecord, markImportedPostDeleted, recordPollVote, replaceImportedMedia, updateImportedPostVisibility, upsertImportedComment, upsertImportedPost } from './repositories/content';
import { handleModerationRequest } from './moderation';
import { resolveAvatarURL } from '../src/avatar.ts';
export { AIRequestCoordinator } from './ai/coordinator';
export { OpenRouterAccountControlPlane } from './ai/control-plane';

const POST_SELECT = `
  p.id, p.author_id, p.body, p.visibility, p.media_json, p.hashtags_json,
  p.mentions_json, p.quoted_post_id, p.poll_json, p.counts_json,
  p.created_at, p.updated_at, p.deleted_at,
  pr.id AS author_profile_id, pr.display_name AS author_name, pr.username AS author_username,
  pr.avatar_url AS author_avatar_url, pr.avatar_color AS author_avatar_color,
  (SELECT count(*) FROM likes lcount WHERE lcount.post_id = p.id) AS likes_count,
  (SELECT count(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comments_count`;

type ImportRecord = Record<string, unknown>;

const AI_CORS_PATH = /^\/api\/(?:ai\/|posts\/[^/]+(?:\/(?:ask-ai|ai-consent))?$|profiles\/[^/]+(?:\/ask-ai)?$|admin\/ai\/sync-post\/[^/]+$)/;

function allowedCorsOrigin(request: Request, env: Env): string | null {
  const raw = request.headers.get('origin');
  if (!raw || raw === 'null') return null;
  try {
    const origin = new URL(raw).origin;
    const allowed = (env.CONNECT_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin);
    return allowed.includes(origin) ? origin : null;
  } catch { return null; }
}

function withAiCors(request: Request, env: Env, response: Response): Response {
  if (!AI_CORS_PATH.test(new URL(request.url).pathname)) return response;
  const origin = allowedCorsOrigin(request, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requireDb(env: Env): env is Env & { DB: D1Database } {
  return Boolean(env.DB);
}

async function readBody<T>(request: Request): Promise<T> {
  try { return await request.json<T>(); } catch { throw new Error('invalid_json'); }
}

function headerToken(request: Request): string | null {
  return request.headers.get('x-migration-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
}

function isMigrationRequest(request: Request, env: Env): boolean {
  return Boolean(env.MIGRATION_TOKEN && headerToken(request) === env.MIGRATION_TOKEN);
}

async function isOperationalAdminRequest(request: Request, env: Env): Promise<boolean> {
  if (isMigrationRequest(request, env)) return true;
  const { viewer } = await getViewer(env, request);
  if (!viewer) return false;
  return (env.AI_ADMIN_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean).includes(viewer.id);
}

function safeDate(value: unknown, fallback = now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function textValue(record: ImportRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function jsonValue(record: ImportRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return null;
}

function normalizeVisibility(record: ImportRecord): string {
  const raw = textValue(record, 'visibility', 'privacy', 'privacyType').toLowerCase();
  if (['private', 'onlyme', 'only_me'].includes(raw)) return 'private';
  if (['friends', 'friend'].includes(raw)) return 'friends';
  return 'public';
}

function normalizeAiVisibility(record: ImportRecord): string | null {
  const raw = textValue(record, 'visibility', 'privacy', 'privacyType').toLowerCase();
  if (!raw || ['public', 'everyone'].includes(raw)) return 'public';
  if (['private', 'onlyme', 'only_me'].includes(raw)) return 'private';
  if (['friends', 'friend'].includes(raw)) return 'friends';
  return null;
}

function usernameFor(record: ImportRecord, userId: string): string {
  const raw = textValue(record, 'username', 'handle', 'userName').replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
  return raw || `user_${userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 18) || 'connect'}`;
}

function profileRecord(record: ImportRecord): { id: string; name: string; username: string; email: string | null; bio: string; avatar: string | null; createdAt: number; updatedAt: number } {
  const idValue = textValue(record, 'id', 'uid', 'userId', 'authorId');
  const name = textValue(record, 'displayName', 'name', 'username') || 'Connect user';
  return {
    id: idValue,
    name,
    username: usernameFor(record, idValue),
    email: textValue(record, 'email') || null,
    bio: textValue(record, 'bio', 'description'),
    avatar: resolveAvatarURL(record) || null,
    createdAt: safeDate(record.createdAt || record.created_at),
    updatedAt: safeDate(record.updatedAt || record.updated_at),
  };
}

async function ensureProfile(ctx: ReturnType<typeof createQueryContext>, viewer: Viewer): Promise<void> {
  const stamp = now();
  await run(ctx, `INSERT INTO profiles(id, display_name, username, email, avatar_url, avatar_color, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = coalesce(excluded.email, profiles.email)`,
  [viewer.id, viewer.name || 'Connect user', `user_${viewer.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'connect'}`, viewer.email, viewer.image ?? null, '#4f46e5', stamp, stamp]);
}

async function queryPosts(ctx: ReturnType<typeof createQueryContext>, viewerId: string | null, options: { cursor: string | null; limit: number; authorId?: string; search?: string; friendsOnly?: boolean; postId?: string }): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }> {
  const cursor = decodeCursor(options.cursor);
  const visibility = visibilityPredicate(viewerId, 'p');
  const cursorPart = cursorPredicate(cursor, 'p');
  const selectLiked = viewerId ? `(SELECT count(*) FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked, (SELECT count(*) FROM bookmarks bkm WHERE bkm.post_id = p.id AND bkm.user_id = ?) AS bookmarked,` : '0 AS liked, 0 AS bookmarked,';
  const bindings: unknown[] = viewerId ? [viewerId, viewerId] : [];
  const where: string[] = [visibility.sql];
  bindings.push(...visibility.bindings);
  if (ctx.aiEnvironment === 'production') where.push(productionFixturePredicate('p'));

  if (options.authorId) { where.push('p.author_id = ?'); bindings.push(options.authorId); }
  if (options.postId) { where.push('p.id = ?'); bindings.push(options.postId); }
  if (options.friendsOnly && viewerId) {
    where.push(`EXISTS (SELECT 1 FROM friendships ff WHERE ff.status = 'accepted' AND ((ff.requester_id = ? AND ff.addressee_id = p.author_id) OR (ff.requester_id = p.author_id AND ff.addressee_id = ?)))`);
    bindings.push(viewerId, viewerId);
  }
  if (options.search) {
    where.push('posts_fts MATCH ?');
    bindings.push(options.search);
  }
  if (cursorPart.sql) { where.push(cursorPart.sql.replace(/^AND\s+/, '')); bindings.push(...cursorPart.bindings); }

  // The immutable owner ID remains on posts. Current profile fields come from
  // this join; a missing profile uses the safe DTO fallback, never a snapshot.
  const from = options.search ? 'posts p LEFT JOIN profiles pr ON pr.id = p.author_id JOIN posts_fts ON posts_fts.post_id = p.id' : 'posts p LEFT JOIN profiles pr ON pr.id = p.author_id';
  const rows = await all<PostRow & { liked: number; bookmarked: number }>(ctx, `SELECT ${selectLiked} ${POST_SELECT}
    FROM ${from}
    WHERE ${where.join(' AND ')}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ?`, [...bindings, options.limit + 1]);
  const page = rows.slice(0, options.limit).map((row) => postFromRow(row, viewerId || ''));
  const last = rows[options.limit - 1] as PostRow | undefined;
  return { rows: page, nextCursor: rows.length > options.limit && last ? encodeCursor(last.created_at, last.id) : null };
}

async function getProfile(ctx: ReturnType<typeof createQueryContext>, profileId: string): Promise<ProfileRow | null> {
  return first<ProfileRow>(ctx, 'SELECT * FROM profiles WHERE id = ?', [profileId]);
}

async function bootstrap(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env)) return json({ viewer: null, profile: null, feed: [], nextCursor: null, database: false });
  const { viewer } = await getViewer(env, request);
  const ctx = createQueryContext(env);
  if (viewer) await ensureProfile(ctx, viewer);
  const feed = await queryPosts(ctx, viewer?.id ?? null, { cursor: null, limit: 20 });
  const profile = viewer ? await getProfile(ctx, viewer.id) : null;
  return json({ viewer, profile: profileFromRow(profile), feed: feed.rows, nextCursor: feed.nextCursor, database: true }, { headers: { 'Cache-Control': viewer ? 'private, no-store' : 'public, max-age=0, s-maxage=30' } }, ctx.reads);
}

async function feed(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env)) return json({ posts: [], nextCursor: null, database: false });
  const url = new URL(request.url);
  const { viewer } = await getViewer(env, request);
  const ctx = createQueryContext(env);
  const mode = url.searchParams.get('mode') === 'friends' ? 'friends' : 'recommended';
  const result = await queryPosts(ctx, viewer?.id ?? null, { cursor: url.searchParams.get('cursor'), limit: normalizeLimit(url.searchParams.get('limit')), friendsOnly: mode === 'friends' });
  return json({ posts: result.rows, nextCursor: result.nextCursor, mode }, { headers: { 'Cache-Control': viewer ? 'private, no-store' : 'public, max-age=0, s-maxage=15' } }, ctx.reads);
}

function makeFtsQuery(value: string): string {
  return value.trim().split(/\s+/).map((part) => part.replace(/["*(){}\[\]:^~]/g, '').trim()).filter(Boolean).slice(0, 8).map((part) => `"${part}"*`).join(' AND ');
}

async function search(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env)) return json({ posts: [], profiles: [], nextCursor: null, database: false });
  const url = new URL(request.url);
  const query = url.searchParams.get('query')?.trim() || '';
  const authorId = url.searchParams.get('authorId')?.trim().slice(0, 160) || undefined;
  const tab = url.searchParams.get('tab') || 'all';
  const { viewer } = await getViewer(env, request);
  const ctx = createQueryContext(env);
  const profileRows = tab === 'posts' ? [] : await all<ProfileRow>(ctx, `SELECT * FROM profiles WHERE username LIKE ? OR display_name LIKE ? ORDER BY display_name COLLATE NOCASE LIMIT 20`, [`%${query}%`, `%${query}%`]);
  if (!query) return json({ posts: [], profiles: profileRows.map(profileFromRow).filter(Boolean), nextCursor: null, query }, {}, ctx.reads);
  const fts = makeFtsQuery(query);
  if (!fts) return json({ posts: [], profiles: profileRows.map(profileFromRow).filter(Boolean), nextCursor: null, query, tab, authorId: authorId ?? null }, {}, ctx.reads);
  const result = tab === 'users' ? { rows: [], nextCursor: null } : await queryPosts(ctx, viewer?.id ?? null, { cursor: url.searchParams.get('cursor'), limit: normalizeLimit(url.searchParams.get('limit')), authorId, search: fts });
  return json({ posts: result.rows, profiles: profileRows.map(profileFromRow).filter(Boolean), nextCursor: result.nextCursor, query, tab, authorId: authorId ?? null }, {}, ctx.reads);
}

async function profile(request: Request, env: Env, profileId: string): Promise<Response> {
  if (!requireDb(env)) return json({ profile: null, posts: [], nextCursor: null, database: false });
  const { viewer } = await getViewer(env, request);
  const ctx = createQueryContext(env);
  const row = await getProfile(ctx, profileId);
  if (!row) return error('profile_not_found', 404, ctx.reads);
  const url = new URL(request.url);
  const result = await queryPosts(ctx, viewer?.id ?? null, { cursor: url.searchParams.get('cursor'), limit: normalizeLimit(url.searchParams.get('limit')), authorId: profileId });
  return json({ profile: profileFromRow(row), posts: result.rows, nextCursor: result.nextCursor }, {}, ctx.reads);
}

async function profilesByIds(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env)) return json({ profiles: [], database: false });
  const ids = [...new Set(new URL(request.url).searchParams.getAll('id')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 160))].slice(0, 50);
  if (!ids.length) return json({ profiles: [] });
  const ctx = createQueryContext(env);
  const rows = await all<ProfileRow>(ctx, `SELECT * FROM profiles WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const profiles = rows.map(profileFromRow)
    .filter((profile): profile is Record<string, unknown> => Boolean(profile))
    .map(({ email: _email, ...profile }) => profile);
  return json({ profiles }, {}, ctx.reads);
}

export async function addPostMediaTickets(env: Env, post: Record<string, unknown>, viewerId: string | null): Promise<Record<string, unknown>> {
  const media = Array.isArray(post.media) ? post.media : null;
  const secret = env.LOG_PSEUDONYM_MASTER_SECRET;
  if (!media || !secret) return post;
  const postId = String(post.id || '');
  const authorId = String(post.authorId || '');
  const signedRoute = async (value: unknown, nested: boolean): Promise<string | null> => {
    if (typeof value !== 'string' || !value.startsWith('/media/') || value.startsWith('//')) return null;
    const route = new URL(value, 'https://connect.invalid');
    let key = '';
    try { key = decodeURIComponent(route.pathname.slice('/media/'.length)); } catch { return null; }
    if (!safeProtectedMediaKey(key) || (!key.startsWith('migration/') && !key.startsWith('posts/'))) return null;
    if (nested && key.startsWith('posts/') && (!authorId || key.split('/')[1] !== authorId)) return null;
    if (nested && key.startsWith('migration/') && !key.startsWith(`migration/${postId}/`)) return null;
    try {
      const ticket = await createMediaAccessTicket(secret, { key, postId, viewerId });
      route.searchParams.set('ticket', ticket);
      return `${route.pathname}${route.search}`;
    } catch {
      return null;
    }
  };
  const signedMedia = await Promise.all(media.map(async (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const item = value as Record<string, unknown>;
    const signed: Record<string, unknown> = { ...item };
    const primary = await signedRoute(item.url, false);
    if (primary) signed.url = primary;
    for (const field of ['thumbnailUrl', 'previewUrl'] as const) {
      const nested = await signedRoute(item[field], true);
      if (nested) signed[field] = nested;
    }
    return signed;
  }));
  return { ...post, media: signedMedia };
}

async function postDetail(request: Request, env: Env, postId: string): Promise<Response> {
  if (!requireDb(env)) return error('database_unavailable', 503);
  const { viewer } = await getViewer(env, request);
  const ctx = createQueryContext(env);
  let result = await queryPosts(ctx, viewer?.id ?? null, { cursor: null, limit: 1, postId });
  let post = result.rows[0];
  // Firestore is still the write path for the legacy client. Mirror a missing
  // row after applying the same viewer ACL so R2 attachments can receive the
  // post-scoped media tickets used by image and video requests.
  const needsMediaRepair = post && (!Array.isArray(post.media) || !post.media.length || post.media.some((item: unknown) => {
    if (!item || typeof item !== 'object') return true;
    const value = item as Record<string, unknown>;
    return typeof value.url !== 'string' || !/^\/media\/(posts|migration)\//.test(value.url);
  }));
  if ((!post || needsMediaRepair) && env.FIREBASE_PROJECT_ID) {
    await syncFirebasePost(request, env, postId, undefined, undefined, 20, false, Boolean(needsMediaRepair));
    result = await queryPosts(ctx, viewer?.id ?? null, { cursor: null, limit: 1, postId });
    post = result.rows[0];
  }
  if (!post) return error('post_not_found', 404, ctx.reads);
  const comments = await all<Record<string, unknown>>(ctx, `SELECT c.*, pr.id AS author_profile_id, pr.display_name AS author_name, pr.username AS author_username, pr.avatar_url AS author_avatar_url, pr.avatar_color AS author_avatar_color
    FROM comments c LEFT JOIN profiles pr ON pr.id = c.author_id WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at ASC, c.id ASC LIMIT 100`, [postId]);
  const postWithMediaTickets = await addPostMediaTickets(env, post, viewer?.id ?? null);
  return json({ post: postWithMediaTickets, comments: comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: comment.created_at,
    author: authorFromRow({
      author_id: String(comment.author_id || ''),
      author_profile_id: typeof comment.author_profile_id === 'string' ? comment.author_profile_id : null,
      author_name: typeof comment.author_name === 'string' ? comment.author_name : null,
      author_username: typeof comment.author_username === 'string' ? comment.author_username : null,
      author_avatar_url: typeof comment.author_avatar_url === 'string' ? comment.author_avatar_url : null,
      author_avatar_color: typeof comment.author_avatar_color === 'string' ? comment.author_avatar_color : null,
    }),
  })) }, {}, ctx.reads);
}

async function currentViewer(request: Request, env: Env): Promise<{ viewer: Viewer | null; ctx: ReturnType<typeof createQueryContext> }> {
  const { viewer } = await getViewer(env, request);
  return { viewer, ctx: createQueryContext(env) };
}

async function createPost(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env)) return error('database_unavailable', 503);
  const { viewer, ctx } = await currentViewer(request, env);
  if (!viewer) return error('unauthorized', 401, ctx.reads);
  await ensureProfile(ctx, viewer);
  const input = await readBody<{ body?: string; visibility?: string; media?: unknown[]; hashtags?: string[]; mentions?: string[]; replyToPostId?: string; quotedPostId?: string }>(request);
  const body = (input.body || '').trim();
  if (!body || body.length > 5000) return error('body_required_or_too_long', 422, ctx.reads);
  const postId = await createPostRecord(ctx, { authorId: viewer.id, body, visibility: input.visibility === 'friends' ? 'friends' : 'public', media: input.media || [], hashtags: input.hashtags || [], mentions: input.mentions || [], replyToPostId: input.replyToPostId || null, quotedPostId: input.quotedPostId || null });
  const result = await queryPosts(ctx, viewer.id, { cursor: null, limit: 1, postId });
  return json({ post: result.rows[0] }, { status: 201 }, ctx.reads);
}

async function toggleReaction(request: Request, env: Env, postId: string, kind: 'like' | 'bookmark'): Promise<Response> {
  if (!requireDb(env)) return error('database_unavailable', 503);
  const { viewer, ctx } = await currentViewer(request, env);
  if (!viewer) return error('unauthorized', 401, ctx.reads);
  if (!(await queryPosts(ctx, viewer.id, { cursor: null, limit: 1, postId })).rows.length) return error('post_not_found', 404, ctx.reads);
  await ensureProfile(ctx, viewer);
  const table = kind === 'like' ? 'likes' : 'bookmarks';
  const existing = await first<Record<string, unknown>>(ctx, `SELECT 1 FROM ${table} WHERE post_id = ? AND user_id = ?`, [postId, viewer.id]);
  let requestedActive: boolean | undefined;
  try {
    const input = await readBody<{ active?: unknown }>(request);
    if (typeof input.active === 'boolean') requestedActive = input.active;
  } catch {
    // The old toggle contract had no body. Keep it compatible while the new
    // desired-state contract prevents duplicate/retried requests from flipping
    // the user's choice twice.
  }
  const active = requestedActive ?? !existing;
  if (active !== Boolean(existing)) {
    if (active) await run(ctx, `INSERT OR IGNORE INTO ${table}(post_id, user_id, created_at) VALUES(?, ?, ?)`, [postId, viewer.id, now()]);
    else await run(ctx, `DELETE FROM ${table} WHERE post_id = ? AND user_id = ?`, [postId, viewer.id]);
  }
  const [likedRow, bookmarkedRow, likesRow] = await Promise.all([
    first<Record<string, number>>(ctx, 'SELECT count(*) AS active FROM likes WHERE post_id = ? AND user_id = ?', [postId, viewer.id]),
    first<Record<string, number>>(ctx, 'SELECT count(*) AS active FROM bookmarks WHERE post_id = ? AND user_id = ?', [postId, viewer.id]),
    first<Record<string, number>>(ctx, 'SELECT count(*) AS count FROM likes WHERE post_id = ?', [postId]),
  ]);
  return json({
    postId,
    kind,
    active: Boolean(kind === 'like' ? likedRow?.active : bookmarkedRow?.active),
    liked: Boolean(likedRow?.active),
    bookmarked: Boolean(bookmarkedRow?.active),
    counts: { likes: Number(likesRow?.count || 0) },
  }, {}, ctx.reads);
}

async function votePoll(request: Request, env: Env, postId: string): Promise<Response> {
  if (!requireDb(env)) return error('database_unavailable', 503);
  const { viewer, ctx } = await currentViewer(request, env);
  if (!viewer) return error('unauthorized', 401, ctx.reads);
  let optionIndex = -1;
  try {
    const input = await readBody<{ optionIndex?: unknown }>(request);
    optionIndex = typeof input.optionIndex === 'number' ? Math.floor(input.optionIndex) : Number(input.optionIndex);
  } catch {
    return error('invalid_poll_option', 422, ctx.reads);
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) return error('invalid_poll_option', 422, ctx.reads);
  await ensureProfile(ctx, viewer);
  if (!(await queryPosts(ctx, viewer.id, { cursor: null, limit: 1, postId })).rows.length) return error('poll_not_found_or_inaccessible', 404, ctx.reads);

  const recorded = await recordPollVote(ctx, { postId, viewerId: viewer.id, optionIndex });
  if (!recorded.ok) {
    const status = recorded.code === 'poll_not_found' ? 404 : recorded.code === 'invalid_poll_option' ? 422 : 409;
    return error(recorded.code, status, ctx.reads);
  }
  const fresh = await queryPosts(ctx, viewer.id, { cursor: null, limit: 1, postId });
  return json({ poll: fresh.rows[0]?.poll || null, post: fresh.rows[0] || null }, {}, ctx.reads);
}

async function addComment(request: Request, env: Env, postId: string): Promise<Response> {
  if (!requireDb(env)) return error('database_unavailable', 503);
  const { viewer, ctx } = await currentViewer(request, env);
  if (!viewer) return error('unauthorized', 401, ctx.reads);
  const input = await readBody<{ body?: string; parentCommentId?: string }>(request);
  const body = (input.body || '').trim();
  if (!body || body.length > 2000) return error('body_required_or_too_long', 422, ctx.reads);
  await ensureProfile(ctx, viewer);
  const commentId = await createCommentRecord(ctx, { postId, authorId: viewer.id, body, parentCommentId: input.parentCommentId || null });
  return json({ id: commentId, body }, { status: 201 }, ctx.reads);
}

async function updateProfile(request: Request, env: Env, profileId: string): Promise<Response> {
  if (!requireDb(env)) return error('database_unavailable', 503);
  const { viewer, ctx } = await currentViewer(request, env);
  if (!viewer || viewer.id !== profileId) return error('unauthorized', 401, ctx.reads);
  const input = await readBody<{ displayName?: string; username?: string; bio?: string; avatarUrl?: string | null; avatarColor?: string }>(request);
  const displayName = (input.displayName || viewer.name || 'Connect user').trim().slice(0, 80);
  const username = (input.username || `user_${profileId.slice(0, 16)}`).replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
  if (!username) return error('username_required', 422, ctx.reads);
  try {
    await run(ctx, `UPDATE profiles SET display_name = ?, username = ?, bio = ?, avatar_url = ?, avatar_color = ?, updated_at = ? WHERE id = ?`, [displayName, username, (input.bio || '').trim().slice(0, 500), input.avatarUrl || null, input.avatarColor || '#4f46e5', now(), profileId]);
  } catch { return error('username_taken', 409, ctx.reads); }
  return json({ profile: profileFromRow(await getProfile(ctx, profileId)) }, {}, ctx.reads);
}

function userMediaKeyFailureReason(key: string, viewerId: string): string | null {
  const parts = key.split('/');
  if (parts.length < 3) return 'invalid_structure';
  if (parts[0] !== 'posts' && parts[0] !== 'profiles') return 'invalid_namespace';
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(parts[1])) return 'invalid_owner_segment';
  if (parts[1] !== viewerId) return 'owner_mismatch';
  if (!parts.slice(2).every((part) => Boolean(part) && part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part))) return 'invalid_path_segment';
  return null;
}

const MAX_R2_OBJECT_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_R2_SINGLE_PUT_BYTES = 16 * 1024 * 1024;
const MAX_R2_MULTIPART_PART_BYTES = 16 * 1024 * 1024;
const SUPPORTED_USER_MEDIA_TYPES = new Set([
  'image/avif', 'image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/heic', 'image/heif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/3gpp', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg', 'video/ogg',
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/webm', 'audio/3gpp', 'audio/x-wav',
  'application/pdf', 'application/zip', 'application/octet-stream', 'text/plain',
]);

function supportedUserMediaType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const type = value.split(';', 1)[0].trim().toLowerCase();
  return SUPPORTED_USER_MEDIA_TYPES.has(type) ? type : null;
}

function safeProtectedMediaKey(key: string): boolean {
  if (key.startsWith('migration/')) return /^migration\/[a-zA-Z0-9_./-]+$/.test(key) && !key.split('/').some((part) => part === '.' || part === '..');
  if (key.startsWith('posts/')) {
    const parts = key.split('/');
    return parts.length >= 3 && /^[A-Za-z0-9_-]{1,160}$/.test(parts[1])
      && parts.slice(2).every((part) => Boolean(part) && part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part));
  }
  return false;
}

export async function media(request: Request, env: Env, key: string): Promise<Response> {
  if (!env.MEDIA) return error('media_unavailable', 503);
  if (request.method === 'GET' || request.method === 'HEAD') {
    key = canonicalPostMediaKey(key) || key;
    const protectedMedia = key.startsWith('migration/') || key.startsWith('posts/');
    if (protectedMedia) {
      if (!requireDb(env) || !safeProtectedMediaKey(key)) return error('media_not_found', 404);
      const { viewer } = await getViewer(env, request);
      const ticket = new URL(request.url).searchParams.get('ticket');
      const grant = ticket
        ? await verifyMediaAccessTicket(env.LOG_PSEUDONYM_MASTER_SECRET || '', ticket, key)
        : null;
      if (ticket && !grant) return error('media_not_found', 404);
      if (grant && viewer && grant.viewerId !== viewer.id) return error('media_not_found', 404);
      const viewerId = grant ? grant.viewerId : (viewer?.id || null);
      const visibility = visibilityPredicate(viewerId, 'p');
      const postPredicate = grant ? 'AND p.id = ?' : '';
      const postBindings = grant ? [grant.postId] : [];
      const profileReference = grant ? '' : `UNION ALL
        SELECT 1 AS allowed FROM profiles pr WHERE pr.avatar_url=? OR pr.cover_url=?`;
      const mediaURL = `/media/${key}`;
      const nestedOwnerId = key.match(/^posts\/([A-Za-z0-9_-]{1,160})\//)?.[1];
      const nestedMigrationPostId = key.match(/^migration\/([A-Za-z0-9_-]{1,160})\//)?.[1];
      const nestedReference = nestedOwnerId
        ? `OR (p.author_id=? AND (json_extract(p.media_json, '$[' || item.key || '].thumbnailUrl')=? OR json_extract(p.media_json, '$[' || item.key || '].previewUrl')=?))`
        : nestedMigrationPostId && nestedMigrationPostId !== 'legacy'
          ? `OR (p.id=? AND (json_extract(p.media_json, '$[' || item.key || '].thumbnailUrl')=? OR json_extract(p.media_json, '$[' || item.key || '].previewUrl')=?))`
          : '';
      const nestedReferenceBindings = nestedOwnerId
        ? [nestedOwnerId, mediaURL, mediaURL]
        : nestedMigrationPostId && nestedMigrationPostId !== 'legacy'
          ? [nestedMigrationPostId, mediaURL, mediaURL]
          : [];
      const visibleReference = await env.DB.prepare(`SELECT 1 AS allowed FROM posts p
        WHERE ${visibility.sql}
          ${postPredicate}
          AND EXISTS (
            SELECT 1 FROM json_each(COALESCE(p.media_json, '[]')) item
            WHERE json_extract(p.media_json, '$[' || item.key || '].url')=?
              ${nestedReference}
          )
        ${profileReference}
        LIMIT 1`)
        .bind(...visibility.bindings, ...postBindings, mediaURL, ...nestedReferenceBindings, ...(grant ? [] : [mediaURL, mediaURL]))
        .first<{ allowed: number }>();
      if (!visibleReference) return error('media_not_found', 404);
    }
    if (request.method === 'HEAD') {
      let metadata: R2Object | null = null;
      for (const candidate of postMediaObjectKeys(key)) {
        metadata = await env.MEDIA.head(candidate);
        if (metadata) break;
      }
      if (!metadata) return error('media_not_found', 404);
      const headers = new Headers();
      metadata.writeHttpMetadata(headers);
      headers.set('Cache-Control', protectedMedia ? 'private, no-store' : 'public, max-age=31536000, immutable');
      headers.set('Accept-Ranges', 'bytes');
      if (protectedMedia) headers.set('Vary', 'Authorization, Cookie');
      headers.set('ETag', metadata.httpEtag);
      headers.set('Content-Length', String(metadata.size));
      return new Response(null, { headers });
    }
    const requestedRange = parseMediaByteRange(request.headers.get('range'));
    const rangeRequested = Boolean(requestedRange);
    let object: R2ObjectBody | null = null;
    let metadata: R2Object | null = null;
    for (const candidate of postMediaObjectKeys(key)) {
      metadata = await env.MEDIA.head(candidate);
      if (!metadata) continue;
      // Do not try the other namespace when the object exists but its range is unsatisfiable.
      if (requestedRange && !resolveMediaByteRange(requestedRange, metadata.size)) break;
      object = await env.MEDIA.get(candidate, requestedRange ? { range: requestedRange } : undefined);
      break;
    }
    if (!object && rangeRequested) {
      if (!metadata) return error('media_not_found', 404);
      const headers = new Headers();
      metadata.writeHttpMetadata(headers);
      headers.set('Cache-Control', protectedMedia ? 'private, no-store' : 'public, max-age=31536000, immutable');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Content-Range', `bytes */${metadata.size}`);
      headers.set('Content-Length', '0');
      if (protectedMedia) headers.set('Vary', 'Authorization, Cookie');
      headers.set('ETag', metadata.httpEtag);
      return new Response(null, { status: 416, headers });
    }
    if (!object) return error('media_not_found', 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', protectedMedia ? 'private, no-store' : 'public, max-age=31536000, immutable');
    headers.set('Accept-Ranges', 'bytes');
    if (protectedMedia) headers.set('Vary', 'Authorization, Cookie');
    headers.set('ETag', object.httpEtag);
    if (requestedRange) {
      const range = resolveMediaByteRange(requestedRange, object.size);
      if (!range) {
        headers.set('Content-Range', `bytes */${object.size}`);
        headers.set('Content-Length', '0');
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${object.size}`);
      headers.set('Content-Length', String(range.length));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set('Content-Length', String(object.size));
    return new Response(object.body, { headers });
  }
  if (!['PUT', 'POST', 'DELETE'].includes(request.method)) return error('method_not_allowed', 405);
  if (!requireDb(env)) return error('database_unavailable', 503);
  const identity = await getViewer(env, request);
  const { viewer } = identity;
  if (!viewer) {
    console.warn(JSON.stringify({
      event: 'media_upload_rejected',
      requestId: request.headers.get('cf-ray') || null,
      reason: 'authentication_failed',
      method: request.method,
      identitySource: identity.source,
      hasBearer: /^Bearer\s+\S+$/i.test(request.headers.get('authorization') || ''),
      hasSessionCookie: Boolean(request.headers.get('cookie')),
    }));
    return error('unauthorized', 401);
  }
  const keyFailureReason = userMediaKeyFailureReason(key, viewer.id);
  if (keyFailureReason) {
    const parts = key.split('/');
    console.warn(JSON.stringify({
      event: 'media_upload_rejected',
      requestId: request.headers.get('cf-ray') || null,
      reason: keyFailureReason,
      method: request.method,
      identitySource: identity.source,
      keyNamespace: parts[0] === 'posts' || parts[0] === 'profiles' ? parts[0] : 'other',
      keySegmentCount: parts.length,
      ownerSegmentMatchesViewer: parts[1] === viewer.id,
      ownerSegmentLength: (parts[1] || '').length,
    }));
    return error('invalid_media_key', 422);
  }
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId') || '';

  if (request.method === 'DELETE') {
    if (uploadId) {
      if (uploadId.length > 512) return error('invalid_upload_id', 422);
      await env.MEDIA.resumeMultipartUpload(key, uploadId).abort();
      return json({ aborted: true });
    }
    const existed = Boolean(await env.MEDIA.head(key));
    await env.MEDIA.delete(key);
    return json({ deleted: existed });
  }

  if (request.method === 'POST') {
    const input = await readBody<{ action?: unknown; contentType?: unknown; size?: unknown; uploadId?: unknown; parts?: unknown }>(request);
    if (input.action === 'initiate') {
      const type = supportedUserMediaType(input.contentType);
      const size = Number(input.size);
      if (!type) return error('unsupported_media_type', 415);
      if (!Number.isSafeInteger(size) || size <= MAX_R2_SINGLE_PUT_BYTES || size > MAX_R2_OBJECT_BYTES) return error('media_too_large', 413);
      const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type } });
      return json({ uploadId: upload.uploadId }, { status: 201 });
    }
    if (input.action === 'complete' && typeof input.uploadId === 'string' && input.uploadId.length <= 512 && Array.isArray(input.parts)) {
      const parts: R2UploadedPart[] = [];
      for (const [index, value] of input.parts.entries()) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return error('invalid_multipart_parts', 422);
        const part = value as Record<string, unknown>;
        if (part.partNumber !== index + 1 || typeof part.etag !== 'string' || !part.etag) return error('invalid_multipart_parts', 422);
        parts.push({ partNumber: index + 1, etag: part.etag });
      }
      const size = Number(input.size);
      if (!Number.isSafeInteger(size) || size <= MAX_R2_SINGLE_PUT_BYTES || size > MAX_R2_OBJECT_BYTES || !parts.length || parts.length > 10_000) return error('invalid_multipart_parts', 422);
      const completed = await env.MEDIA.resumeMultipartUpload(key, input.uploadId).complete(parts);
      if (completed.size !== size) {
        await env.MEDIA.delete(key);
        return error('media_size_mismatch', 422);
      }
      return json({ key, url: `/media/${key}`, size: completed.size }, { status: 201 });
    }
    return error('invalid_multipart_action', 422);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  const partNumber = Number(url.searchParams.get('partNumber') || 0);
  if (uploadId || url.searchParams.has('partNumber')) {
    if (!uploadId || uploadId.length > 512 || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) return error('invalid_multipart_part', 422);
    if (contentLength > MAX_R2_MULTIPART_PART_BYTES) return error('media_too_large', 413);
    const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, request.body!);
    return json({ partNumber, etag: part.etag });
  }
  if (contentLength > MAX_R2_SINGLE_PUT_BYTES) return error('media_too_large', 413);
  const type = supportedUserMediaType(request.headers.get('content-type') || 'application/octet-stream');
  if (!type) return error('unsupported_media_type', 415);
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  return json({ key, url: `/media/${key}` }, { status: 201 });
}

async function migrationMedia(request: Request, env: Env, key: string): Promise<Response> {
  if (!env.MEDIA || !isMigrationRequest(request, env)) return error('not_found', 404);
  if (request.method !== 'PUT') return error('method_not_allowed', 405);
  if (!/^[-a-zA-Z0-9_./]+$/.test(key) || !key.startsWith('migration/')) return error('invalid_media_key', 422);
  const type = (request.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
  if (!['image/avif', 'image/webp', 'image/jpeg', 'image/png', 'video/mp4'].includes(type)) return error('unsupported_media_type', 415);
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 15 * 1024 * 1024) return error('media_too_large', 413);
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  return json({ ok: true, key, url: `/media/${key}` }, { status: 201 });
}

async function push(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env)) return error('database_unavailable', 503);
  const { viewer, ctx } = await currentViewer(request, env);
  if (!viewer) return error('unauthorized', 401, ctx.reads);
  if (request.method === 'GET') return json({ publicKey: env.VAPID_PUBLIC_KEY || null }, {}, ctx.reads);
  const input = await readBody<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(request);
  if (!input.endpoint || !input.keys?.p256dh || !input.keys.auth) return error('invalid_subscription', 422, ctx.reads);
  await ensureProfile(ctx, viewer);
  const timestamp = now();
  await run(ctx, `INSERT INTO push_subscriptions(id, user_id, endpoint, p256dh, auth, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at`, [id(), viewer.id, input.endpoint, input.keys.p256dh, input.keys.auth, timestamp, timestamp]);
  return json({ ok: true }, { status: 201 }, ctx.reads);
}

async function rum(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env)) return json({ ok: false, database: false });
  const input = await readBody<{ route?: string; lcp?: number; inp?: number; cls?: number; ttfb?: number; jsBytes?: number; imageBytes?: number }>(request);
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, value)) : null;
  const ctx = createQueryContext(env);
  await run(ctx, `INSERT INTO rum_samples(id, route, lcp, inp, cls, ttfb, js_bytes, image_bytes, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id(), (input.route || '/').slice(0, 200), numeric(input.lcp), numeric(input.inp), numeric(input.cls), numeric(input.ttfb), numeric(input.jsBytes), numeric(input.imageBytes), now()]);
  return json({ ok: true }, {}, ctx.reads);
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('media_too_large');
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error('media_fetch_rejected');
    if (bytes.byteLength > maxBytes) throw new Error('media_too_large');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('media_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  if (!bytes.byteLength) throw new Error('media_fetch_rejected');
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function copyMediaArray(env: Env, postId: string, value: string | null, shouldCopy: boolean, maxBytes = 15 * 1024 * 1024): Promise<{ json: string | null; failed: number }> {
  if (!value || !shouldCopy || !env.MEDIA) return { json: value, failed: 0 };
  const media = (() => { try { return JSON.parse(value) as unknown[]; } catch { return []; } })();
  if (!Array.isArray(media)) return { json: JSON.stringify([]), failed: 0 };
  const copied: Array<Record<string, unknown>> = [];
  let failed = 0;
  for (let index = 0; index < media.length; index += 1) {
    const item = typeof media[index] === 'string' ? { url: media[index] } : (media[index] as Record<string, unknown> || {});
    const source = typeof item.url === 'string' ? item.url : '';
    if (!source || source.startsWith('/media/')) { if (source) copied.push({ ...item, url: source }); continue; }
    try {
      const response = await fetch(source, { redirect: 'follow', signal: AbortSignal.timeout(5_000) });
      const type = response.headers.get('content-type') || 'application/octet-stream';
      const length = Number(response.headers.get('content-length') || 0);
      if (!response.ok || length > maxBytes || !/^(image\/(avif|webp|jpeg|png)|video\/mp4)/i.test(type)) throw new Error('media_fetch_rejected');
      const bytes = await readBoundedResponse(response, maxBytes);
      const extension = type.includes('avif') ? 'avif' : type.includes('webp') ? 'webp' : type.includes('png') ? 'png' : type.includes('mp4') ? 'mp4' : 'jpg';
      const key = `migration/${postId}/${index}.${extension}`;
      await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((part) => part.toString(16).padStart(2, '0')).join('');
      copied.push({ ...item, url: `/media/${key}`, originalUrl: typeof item.originalUrl === 'string' ? item.originalUrl : source, sourceType: type, mimeType: type.split(';', 1)[0].toLowerCase(), bytes: bytes.byteLength, sha256: digest });
    } catch {
      failed += 1;
      copied.push({ ...item, url: null, originalUrl: typeof item.originalUrl === 'string' ? item.originalUrl : source, unavailable: true });
    }
  }
  return { json: JSON.stringify(copied), failed };
}

function firestoreValue(value: Record<string, unknown> | undefined): unknown {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return ((value.arrayValue as { values?: Array<Record<string, unknown>> }).values || []).map(firestoreValue);
  if ('mapValue' in value) return Object.fromEntries(Object.entries((value.mapValue as { fields?: Record<string, Record<string, unknown>> }).fields || {}).map(([key, item]) => [key, firestoreValue(item)]));
  return null;
}

function firestoreRecord(document: { name?: string; fields?: Record<string, Record<string, unknown>> }): ImportRecord {
  return { id: String(document.name || '').split('/').pop() || '', ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, firestoreValue(value)])) };
}

function firestoreMedia(record: ImportRecord): Array<Record<string, unknown>> {
  const values = Array.isArray(record.imageURLs) ? record.imageURLs : Array.isArray(record.images) ? record.images : [];
  const authorId = textValue(record, 'userId', 'authorId', 'uid', 'creatorId');
  const allowedHost = (value: string): boolean => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && (host === 'firebasestorage.googleapis.com' || host === 'storage.googleapis.com' || host.endsWith('.firebasestorage.app'));
    } catch { return false; }
  };
  const allowedR2Route = (value: string): boolean => {
    if (!value.startsWith('/media/')) return false;
    const key = value.split(/[?#]/, 1)[0].slice('/media/'.length);
    if (key.startsWith('migration/')) return safeProtectedMediaKey(key);
    return Boolean(canonicalPostMediaKey(key, authorId));
  };
  const allowedNestedR2Route = (value: string): boolean => {
    if (!value.startsWith('/media/')) return false;
    const key = value.split(/[?#]/, 1)[0].slice('/media/'.length);
    if (!safeProtectedMediaKey(key)) return false;
    if (key.startsWith('posts/')) return key.split('/')[1] === authorId;
    const migratedPostId = key.match(/^migration\/([A-Za-z0-9_-]{1,160})\//)?.[1];
    return Boolean(migratedPostId && migratedPostId === textValue(record, 'id'));
  };
  const storageKeyFromRoute = (value: unknown): string => {
    if (typeof value !== 'string' || !value.startsWith('/media/')) return '';
    const encodedKey = value.split(/[?#]/, 1)[0].slice('/media/'.length);
    try {
      const key = decodeURIComponent(encodedKey);
      return safeProtectedMediaKey(key) ? key : '';
    } catch { return ''; }
  };
  const candidates: Array<Record<string, unknown>> = [];
  const append = (value: unknown, kindHint?: string): void => {
    const item = typeof value === 'string' ? { url: value } : value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!item || typeof item.url !== 'string' || (!allowedHost(item.url) && !allowedR2Route(item.url))) return;
    const primaryKey = storageKeyFromRoute(item.url);
    const previewKey = storageKeyFromRoute(item.previewUrl) || storageKeyFromRoute(item.thumbnailUrl);
    candidates.push({
      url: item.url,
      ...(typeof item.kind === 'string' ? { kind: item.kind } : kindHint ? { kind: kindHint } : {}),
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
      ...(typeof item.sourceType === 'string' ? { sourceType: item.sourceType } : {}),
      ...(primaryKey ? { storagePath: primaryKey, objectKey: primaryKey } : typeof item.storagePath === 'string' ? { storagePath: item.storagePath } : {}),
      ...(!primaryKey && typeof item.objectKey === 'string' ? { objectKey: item.objectKey } : {}),
      ...(typeof item.thumbnailUrl === 'string' && (allowedHost(item.thumbnailUrl) || allowedNestedR2Route(item.thumbnailUrl)) ? { thumbnailUrl: item.thumbnailUrl } : {}),
      ...(typeof item.previewUrl === 'string' && (allowedHost(item.previewUrl) || allowedNestedR2Route(item.previewUrl)) ? { previewUrl: item.previewUrl } : {}),
      ...(previewKey ? { previewStoragePath: previewKey } : typeof item.previewStoragePath === 'string' ? { previewStoragePath: item.previewStoragePath } : {}),
      ...((typeof item.originalUrl === 'string' && (allowedHost(item.originalUrl) || allowedR2Route(item.originalUrl))) || allowedHost(item.url) ? { originalUrl: typeof item.originalUrl === 'string' ? item.originalUrl : item.url } : {}),
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.size === 'number' && Number.isFinite(item.size) ? { size: item.size } : {}),
    });
  };
  for (const value of values) append(value);
  if (Array.isArray(record.attachments)) for (const value of record.attachments) append(value);
  for (const [key, kind] of [['imageURL', 'image'], ['videoURL', 'video']] as const) {
    append(record[key], kind);
  }
  const unique = new Map<string, Record<string, unknown>>();
  for (const item of candidates) {
    const url = String(item.url);
    const previous = unique.get(url) || {};
    unique.set(url, { ...previous, ...item,
      kind: item.kind || previous.kind,
      mimeType: item.mimeType || previous.mimeType,
      sourceType: item.sourceType || previous.sourceType,
      storagePath: item.storagePath || previous.storagePath,
      objectKey: item.objectKey || previous.objectKey,
    });
  }
  return [...unique.values()].slice(0, 20);
}

async function syncAdminFirebasePost(request: Request, env: Env, postId: string): Promise<Response> {
  if (!requireDb(env) || !env.MEDIA) return error('database_unavailable', 503);
  const { viewer } = await getViewer(env, request);
  if (!viewer || !(env.AI_ADMIN_USER_IDS || '').split(',').map((value) => value.trim()).includes(viewer.id)) return error('not_found', 404);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return error('post_not_found', 404);
  const projectId = env.FIREBASE_PROJECT_ID || '';
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/posts/${encodeURIComponent(postId)}`);
  if (!response.ok) return error('post_not_found', 404);
  const record = firestoreRecord(await response.json<{ name?: string; fields?: Record<string, Record<string, unknown>> }>());
  const authorId = textValue(record, 'userId', 'authorId', 'uid', 'creatorId');
  if (!authorId || normalizeVisibility(record) !== 'public' || record.deletedAt) return error('post_not_found', 404);
  const ctx = createQueryContext(env);
  const createdAt = safeDate(record.createdAt);
  // The endpoint is admin-authenticated and only imports the exact public
  // Firestore document fetched above. Feed posts commonly belong to another
  // author, so ensure the D1 foreign-key parent without trusting client data.
  await run(ctx, `INSERT OR IGNORE INTO profiles(id, display_name, username, avatar_color, created_at, updated_at)
    VALUES(?, 'Connect user', ?, '#4f46e5', ?, ?)`, [authorId, usernameFor({ id: authorId }, authorId), createdAt, createdAt]);
  const media = await copyMediaArray(env, postId, JSON.stringify(firestoreMedia(record)), true);
  if (media.failed) return error('media_sync_failed', 503, ctx.reads);
  await upsertImportedPost(ctx, [
    postId, authorId, textValue(record, 'text', 'body', 'content'), 'public', media.json,
    jsonValue(record, 'hashtags'), jsonValue(record, 'mentions'), null, null, null,
    jsonValue(record, 'poll'), JSON.stringify({ likes: Number(record.likesCount || 0), comments: Number(record.commentsCount || 0), shares: Number(record.repostsCount || 0) }),
    createdAt, safeDate(record.updatedAt, createdAt), null,
  ]);
  return json({ ok: true, postId, mediaCount: firestoreMedia(record).length, mediaReady: true }, { headers: { 'Cache-Control': 'private, no-store' } }, ctx.reads);
}

/**
 * The established Connect UI still reads legacy posts from Firestore while
 * the Worker owns the AI context in D1. A post can therefore be visible in
 * the feed before its scoped migration reaches D1. On an Ask AI request, read
 * through one exact Firestore document and persist only that document in D1.
 *
 * Public documents may be read without a bearer. Restricted documents are
 * first read with a field mask containing only author/visibility/deleted
 * metadata. The D1 friendship/block/owner ACL is evaluated before the full
 * Firestore document or any media is fetched. The normal AI context query
 * then applies the same D1 ACL again after the upsert; there is no post-ID
 * exception that can turn a legacy read into an AI context authorization.
 */
async function legacyPostViewerCanRead(db: D1Database, viewerId: string | null, authorId: string, visibility: string): Promise<boolean> {
  if (!viewerId) return visibility === 'public';
  const row = await db.prepare(`SELECT 1 AS allowed
    WHERE NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE (b.blocker_id=? AND b.blocked_id=?) OR (b.blocker_id=? AND b.blocked_id=?)
    ) AND (
      ?='public' OR ?=? OR (
        ?='friends' AND EXISTS (
          SELECT 1 FROM friendships f
          WHERE f.status='accepted' AND ((f.requester_id=? AND f.addressee_id=?) OR (f.requester_id=? AND f.addressee_id=?))
        )
      )
    ) LIMIT 1`)
    .bind(viewerId, authorId, authorId, viewerId, visibility, viewerId, authorId, visibility, viewerId, authorId, authorId, viewerId)
    .first<{ allowed: number }>();
  return Boolean(row);
}

export async function syncFirebasePost(request: Request, env: Env, postId: string, correlationId?: string, expectedAuthorId?: string, maxMediaItems = 4, requireAiConsent = false, repairMedia = false): Promise<{
  synced: boolean;
  sourceUnavailable?: boolean;
  diagnostic?: { visibility: string | null; ownerMatch: boolean | null; normalViewAllowed: boolean | null; aiAllowed: boolean; imageConsentAllowed: boolean | null; denyReason: string };
}> {
  if (!requireDb(env) || !env.MEDIA || !env.FIREBASE_PROJECT_ID) return { synced: false };
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return { synced: false };
  const syncContext = createQueryContext(env);
  const trace = (outcome: string, extra: Record<string, unknown> = {}): void => {
    // Diagnostic fields are deliberately redacted: no bearer, body, author ID,
    // or post ID is ever written to the Worker log.
    console.log(JSON.stringify({ event: 'ai_legacy_post_sync', correlationId, outcome, ...extra }));
  };
  try {
    const existing = await env.DB.prepare('SELECT author_id,visibility,firestore_update_time,media_json FROM posts WHERE id=? LIMIT 1').bind(postId).first<{ author_id: string; visibility: string; firestore_update_time: string | null; media_json: string | null }>();
    const { viewer } = await getViewer(env, request);
    const authorization = request.headers.get('authorization') || '';
    const canForwardBearer = Boolean(viewer && /^Bearer\s+\S+$/i.test(authorization));
    if (existing && existing.visibility !== 'public' && !canForwardBearer) { trace('restricted_without_validated_bearer', { hasViewer: Boolean(viewer), hasBearer: /^Bearer\s+\S+$/i.test(authorization) }); return { synced: false }; }
    const headers = new Headers();
    if (canForwardBearer) headers.set('Authorization', authorization);
    const documentUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/posts/${encodeURIComponent(postId)}`;
    const metadataUrl = new URL(documentUrl);
    for (const fieldPath of ['userId', 'authorId', 'uid', 'creatorId', 'visibility', 'privacy', 'privacyType', 'deletedAt']) metadataUrl.searchParams.append('mask.fieldPaths', fieldPath);
    const metadataResponse = await fetch(metadataUrl, { headers, signal: AbortSignal.timeout(5_000) });
    if (!metadataResponse.ok) {
      if (metadataResponse.status === 404 && existing && (existing.firestore_update_time || existing.author_id === expectedAuthorId || existing.author_id === viewer?.id)) {
        await markImportedPostDeleted(syncContext, postId, existing.author_id);
      }
      trace('firestore_metadata_denied', { status: metadataResponse.status, hasViewer: Boolean(viewer), hasBearer: canForwardBearer });
      return { synced: false, sourceUnavailable: metadataResponse.status >= 500 || metadataResponse.status === 429 };
    }
    const metadataDocument = await metadataResponse.json<{ name?: string; updateTime?: string; fields?: Record<string, Record<string, unknown>> }>();
    const metadata = firestoreRecord(metadataDocument);
    const metadataAuthorId = textValue(metadata, 'userId', 'authorId', 'uid', 'creatorId');
    const metadataVisibility = normalizeAiVisibility(metadata);
    const metadataUpdateTime = typeof metadataDocument.updateTime === 'string' ? metadataDocument.updateTime : '';
    if (!metadataAuthorId || !metadataVisibility || !metadataUpdateTime || metadata.deletedAt) {
      if (metadataAuthorId && existing?.author_id === metadataAuthorId && metadata.deletedAt) await markImportedPostDeleted(syncContext, postId, metadataAuthorId);
      trace('metadata_rejected', { reason: !metadataAuthorId ? 'AUTHOR_MISSING' : metadata.deletedAt ? 'POST_DELETED' : !metadataVisibility ? 'VISIBILITY_INVALID' : 'SOURCE_VERSION_MISSING', hasAuthor: Boolean(metadataAuthorId), visibility: metadataVisibility || 'unknown' });
      return { synced: false };
    }
    if (existing && existing.author_id !== metadataAuthorId) { trace('profile_owner_mismatch', { visibility: metadataVisibility }); return { synced: false }; }
    if (expectedAuthorId && metadataAuthorId !== expectedAuthorId) { trace('profile_owner_mismatch', { visibility: metadataVisibility }); return { synced: false }; }
    if (existing && existing.visibility !== metadataVisibility) {
      await updateImportedPostVisibility(syncContext, postId, metadataAuthorId, metadataVisibility);
    }
    if (expectedAuthorId && metadataVisibility !== 'public') { trace('profile_post_not_public', { visibility: metadataVisibility }); return { synced: false }; }
    if (metadataVisibility !== 'public' && !canForwardBearer) { trace('restricted_without_validated_bearer', { hasViewer: Boolean(viewer), hasBearer: canForwardBearer, visibility: metadataVisibility }); return { synced: false }; }
    if (!await legacyPostViewerCanRead(env.DB, viewer?.id || null, metadataAuthorId, metadataVisibility)) {
      trace('acl_denied_before_content_fetch', { hasViewer: Boolean(viewer), visibility: metadataVisibility });
      return { synced: false };
    }
    if (isProductionFixturePost(postId, '')) {
      trace('production_fixture_excluded', { visibility: metadataVisibility, normalViewAllowed: true });
      const preference = await env.DB.prepare('SELECT media_analysis FROM ai_author_preferences WHERE user_id=? LIMIT 1').bind(metadataAuthorId).first<{ media_analysis: string | null }>().catch(() => null);
      return { synced: false, diagnostic: {
        visibility: metadataVisibility,
        ownerMatch: Boolean(viewer && viewer.id === metadataAuthorId),
        normalViewAllowed: true,
        aiAllowed: false,
        imageConsentAllowed: preference ? preference.media_analysis !== 'DISABLED' : true,
        denyReason: 'PRODUCTION_FIXTURE_EXCLUDED',
      } };
    }
    const [preference, postConsent] = await Promise.all([
      env.DB.prepare('SELECT accepted_policy_version,preference_version,text_analysis,media_analysis FROM ai_author_preferences WHERE user_id=? LIMIT 1')
        .bind(metadataAuthorId).first<{ accepted_policy_version: string | null; preference_version: number | null; text_analysis: string | null; media_analysis: string | null }>(),
      env.DB.prepare('SELECT text_analysis,media_analysis FROM post_ai_consents WHERE post_id=? AND author_id=? LIMIT 1')
        .bind(postId, metadataAuthorId).first<{ text_analysis: string; media_analysis: string }>(),
    ]);
    const consent = consentFor({
      acceptedPolicyVersion: preference?.accepted_policy_version || null,
      preferenceVersion: preference?.preference_version ?? 1,
      textAnalysis: (preference?.text_analysis || 'PUBLIC_ONLY') as 'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT',
      mediaAnalysis: (preference?.media_analysis || 'PUBLIC_ONLY') as 'DISABLED' | 'PUBLIC_ONLY' | 'AUTHORIZED_CONTEXT',
    }, metadataVisibility, postConsent ? { textAnalysis: postConsent.text_analysis, mediaAnalysis: postConsent.media_analysis } : null);
    if (requireAiConsent && !consent.allowText && !consent.allowMedia) {
      trace('ai_consent_denied_before_content_fetch', { visibility: metadataVisibility, imageConsentAllowed: false });
      return { synced: false, diagnostic: {
        visibility: metadataVisibility,
        ownerMatch: Boolean(viewer && viewer.id === metadataAuthorId),
        normalViewAllowed: true,
        aiAllowed: false,
        imageConsentAllowed: false,
        denyReason: 'AUTHOR_AI_CONSENT_DISABLED',
      } };
    }
    if (existing?.firestore_update_time === metadataUpdateTime && !repairMedia) {
      trace('source_unchanged', { visibility: metadataVisibility, aclChecked: true, imageConsentAllowed: consent.allowMedia });
      return { synced: true };
    }
    const response = await fetch(documentUrl, { headers, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      trace('firestore_content_denied', { status: response.status, hasViewer: Boolean(viewer), hasBearer: canForwardBearer });
      return { synced: false, sourceUnavailable: response.status >= 500 || response.status === 429 };
    }
    const contentDocument = await response.json<{ name?: string; updateTime?: string; fields?: Record<string, Record<string, unknown>> }>();
    const record = firestoreRecord(contentDocument);
    const authorId = textValue(record, 'userId', 'authorId', 'uid', 'creatorId');
    const body = textValue(record, 'text', 'body', 'content');
    const visibility = normalizeAiVisibility(record);
    if (!authorId || !visibility || authorId !== metadataAuthorId || visibility !== metadataVisibility || contentDocument.updateTime !== metadataUpdateTime || record.deletedAt) {
      const reason = !authorId ? 'AUTHOR_MISSING' : authorId !== metadataAuthorId ? 'OWNER_CHANGED' : record.deletedAt ? 'POST_DELETED' : visibility !== metadataVisibility ? 'VISIBILITY_CHANGED' : contentDocument.updateTime !== metadataUpdateTime ? 'SOURCE_CHANGED_DURING_SYNC' : 'VISIBILITY_INVALID';
      if (authorId && existing?.author_id === authorId && record.deletedAt) {
        await markImportedPostDeleted(syncContext, postId, authorId);
      }
      if (authorId && existing?.author_id === authorId && visibility && visibility !== 'public') {
        await updateImportedPostVisibility(syncContext, postId, authorId, visibility);
      }
      trace('record_rejected', { reason, hasAuthor: Boolean(authorId), visibility: visibility || 'unknown' });
      return { synced: false, sourceUnavailable: reason === 'SOURCE_CHANGED_DURING_SYNC' };
    }
    const existingMedia = (() => {
      try { const value = JSON.parse(existing?.media_json || '[]'); return Array.isArray(value) ? value as Array<Record<string, unknown>> : []; }
      catch { return []; }
    })();
    // Consent gates AI use in the context manifest. It must not erase media
    // from the user-facing post record or prevent normal playback.
    const sourceMedia = requireAiConsent && !consent.allowMedia ? existingMedia : firestoreMedia(record);
    if (!body && !sourceMedia.length || body.length > 5_000) {
      const reason = body.length > 5_000 ? 'BODY_TOO_LARGE' : 'CONTENT_MISSING';
      trace('record_rejected', { reason, hasBody: Boolean(body), visibility });
      return { synced: false };
    }
    if (isProductionFixturePost(postId, body)) {
      trace('production_fixture_excluded', { visibility, normalViewAllowed: true });
      const preference = await env.DB.prepare('SELECT media_analysis FROM ai_author_preferences WHERE user_id=? LIMIT 1').bind(authorId).first<{ media_analysis: string | null }>().catch(() => null);
      return { synced: false, diagnostic: {
        visibility,
        ownerMatch: Boolean(viewer && viewer.id === authorId),
        normalViewAllowed: true,
        aiAllowed: false,
        imageConsentAllowed: preference ? preference.media_analysis !== 'DISABLED' : true,
        denyReason: 'PRODUCTION_FIXTURE_EXCLUDED',
      } };
    }
    if ((expectedAuthorId && authorId !== expectedAuthorId) || !await legacyPostViewerCanRead(env.DB, viewer?.id || null, authorId, visibility)) {
      trace('acl_changed_before_sync', { hasViewer: Boolean(viewer), visibility });
      return { synced: false };
    }
    const mediaItems = await resolveLegacyMediaObjects(env, authorId, sourceMedia.slice(0, Math.max(0, Math.min(requireAiConsent ? 4 : 20, Math.floor(maxMediaItems)))));
    const media = await copyMediaArray(env, postId, JSON.stringify(mediaItems), true, 5 * 1024 * 1024);
    if (media.failed) { trace('media_copy_failed', { failed: media.failed }); return { synced: false }; }
    const totalBytes = (() => {
      try {
        return (JSON.parse(media.json || '[]') as Array<Record<string, unknown>>).reduce((sum, item) => sum + (typeof item.bytes === 'number' && Number.isFinite(item.bytes) ? item.bytes : 0), 0);
      } catch { return Number.POSITIVE_INFINITY; }
    })();
    if (requireAiConsent && totalBytes > 20 * 1024 * 1024) { trace('media_too_large'); return { synced: false }; }
    if (repairMedia && existing?.firestore_update_time === metadataUpdateTime) {
      if (existing.media_json !== media.json) {
        await replaceImportedMedia(syncContext, postId, JSON.parse(media.json || '[]'));
      }
      trace('media_repaired', { mediaCount: mediaItems.length, aclChecked: true });
      return { synced: true };
    }
    const createdAt = safeDate(record.createdAt);
    await run(syncContext, `INSERT OR IGNORE INTO profiles(id, display_name, username, avatar_color, created_at, updated_at)
      VALUES(?, 'Connect user', ?, '#4f46e5', ?, ?)`, [authorId, usernameFor({ id: authorId }, authorId), createdAt, createdAt]);
    await upsertImportedPost(syncContext, [
      postId, authorId, body, visibility, media.json,
      jsonValue(record, 'hashtags'), jsonValue(record, 'mentions'), null, null, null,
      jsonValue(record, 'poll'), JSON.stringify({ likes: Number(record.likesCount || 0), comments: Number(record.commentsCount || 0), shares: Number(record.repostsCount || 0) }),
      createdAt, safeDate(record.updatedAt, createdAt), null,
    ], metadataUpdateTime);
    trace('synced', { visibility, aclChecked: true, imageConsentAllowed: consent.allowMedia });
    return { synced: true };
  } catch (cause) {
    // A Firestore read-through is best effort. The normal D1 context path
    // remains fail-closed when the legacy source is unavailable.
    trace('exception', { name: cause instanceof Error ? cause.name : 'unknown' });
    return { synced: false, sourceUnavailable: true };
  }
}

const PROFILE_CONTEXT_POST_HINT_LIMIT = 12;

export async function syncFirebaseProfileContext(request: Request, env: Env, input: {
  viewerId: string;
  profileId: string;
  contextPostIds: string[];
  requestId: string;
}): Promise<{
  profileSynced: boolean;
  profileVerified: boolean;
  profileDenied: boolean;
  sourceUnavailable: boolean;
  requestedPostCount: number;
  attemptedPostCount: number;
  syncedPostCount: number;
  skippedPostCount: number;
  verifiedPostIds: string[];
}> {
  const postIds = [...new Set(input.contextPostIds.filter((postId) => /^[A-Za-z0-9_-]{1,160}$/.test(postId)))].slice(0, PROFILE_CONTEXT_POST_HINT_LIMIT);
  const stats = {
    profileSynced: false,
    profileVerified: false,
    profileDenied: false,
    sourceUnavailable: false,
    requestedPostCount: postIds.length,
    attemptedPostCount: 0,
    syncedPostCount: 0,
    skippedPostCount: postIds.length,
    verifiedPostIds: [] as string[],
  };
  if (!requireDb(env) || !env.FIREBASE_PROJECT_ID) {
    stats.sourceUnavailable = true;
    return stats;
  }

  const [blocked, preferences] = await Promise.all([
    env.DB.prepare(`SELECT 1 AS blocked FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1`)
      .bind(input.viewerId, input.profileId, input.profileId, input.viewerId).first<{ blocked: number }>(),
    env.DB.prepare('SELECT text_analysis,media_analysis FROM ai_author_preferences WHERE user_id=? LIMIT 1')
      .bind(input.profileId).first<{ text_analysis: string | null; media_analysis: string | null }>(),
  ]);
  if (blocked || preferences?.text_analysis === 'DISABLED') {
    stats.profileDenied = true;
    return stats;
  }

  let profileOutcome = 'not_found';
  try {
    const profileUrl = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/users/${encodeURIComponent(input.profileId)}`);
    for (const fieldPath of ['displayName', 'name', 'username', 'userName', 'handle', 'bio', 'description']) profileUrl.searchParams.append('mask.fieldPaths', fieldPath);
    const profileResponse = await fetch(profileUrl, { signal: AbortSignal.timeout(5_000) });
    if (profileResponse.ok) {
      const document = await profileResponse.json<{ name?: string; fields?: Record<string, Record<string, unknown>>; createTime?: string; updateTime?: string }>();
      if (!document.updateTime) {
        profileOutcome = 'source_version_missing';
        stats.sourceUnavailable = true;
      } else {
      const record = firestoreRecord(document);
      const existing = await env.DB.prepare('SELECT display_name,username,bio,avatar_color,created_at,updated_at FROM profiles WHERE id=? LIMIT 1')
        .bind(input.profileId).first<{ display_name: string; username: string; bio: string; avatar_color: string; created_at: number; updated_at: number }>();
      // A successful Firestore read is authoritative even when optional fields
      // are absent: in particular, never reuse a stale D1 bio after it was
      // removed from the source document.
      const displayName = (textValue(record, 'displayName', 'name') || textValue(record, 'username', 'userName') || 'Connect user').slice(0, 80);
      const username = usernameFor(record, input.profileId);
      const bio = textValue(record, 'bio', 'description').slice(0, 500);
      const createdAt = safeDate(document.createTime, existing?.created_at || now());
      const updatedAt = safeDate(document.updateTime, existing?.updated_at || createdAt);
      await env.DB.prepare(`INSERT INTO profiles(id,display_name,username,bio,avatar_color,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username,bio=excluded.bio,updated_at=excluded.updated_at`)
        .bind(input.profileId, displayName, username, bio, existing?.avatar_color || '#4f46e5', createdAt, updatedAt).run();
      stats.profileSynced = true;
      stats.profileVerified = true;
      profileOutcome = 'synced';
      }
    } else {
      profileOutcome = `http_${profileResponse.status}`;
      stats.profileDenied = profileResponse.status === 403 || profileResponse.status === 404;
      stats.sourceUnavailable = profileResponse.status === 429 || profileResponse.status >= 500;
    }
  } catch (cause) {
    profileOutcome = cause instanceof Error ? cause.name : 'unknown';
    stats.sourceUnavailable = true;
  }
  console.log(JSON.stringify({
    event: 'ai_legacy_profile_sync',
    requestId: input.requestId,
    outcome: profileOutcome,
    bodyLogged: false,
    piiLogged: false,
  }));

  if (!stats.profileVerified || !postIds.length || !env.MEDIA) return stats;
  const placeholders = postIds.map(() => '?').join(',');
  const consentRows = await env.DB.prepare(`SELECT post_id,text_analysis,media_analysis FROM post_ai_consents WHERE author_id=? AND post_id IN (${placeholders})`)
    .bind(input.profileId, ...postIds).all<{ post_id: string; text_analysis: string; media_analysis: string }>();
  const consentByPost = new Map((consentRows.results || []).map((row) => [row.post_id, row]));
  const candidates = postIds.filter((postId) => {
    const consent = consentByPost.get(postId);
    const textAllowed = preferences?.text_analysis !== 'DISABLED' && consent?.text_analysis !== 'DISABLED';
    const mediaAllowed = preferences?.media_analysis !== 'DISABLED' && consent?.media_analysis !== 'DISABLED';
    return textAllowed || mediaAllowed;
  });
  stats.attemptedPostCount = candidates.length;
  const maxConcurrentPostSyncs = 4;
  for (let index = 0; index < candidates.length; index += maxConcurrentPostSyncs) {
    const batch = candidates.slice(index, index + maxConcurrentPostSyncs);
    const results = await Promise.all(batch.map(async (postId) => {
      const mediaAllowed = preferences?.media_analysis !== 'DISABLED' && consentByPost.get(postId)?.media_analysis !== 'DISABLED';
      // The profile context caps visual input at four images. Copy at most one
      // consented image from each of the first four recent hinted posts.
      const mediaLimit = mediaAllowed && candidates.indexOf(postId) < 4 ? 1 : 0;
      return { postId, result: await syncFirebasePost(request, env, postId, input.requestId, input.profileId, mediaLimit, true) };
    }));
    const synced = results.filter((entry) => entry.result.synced);
    stats.syncedPostCount += synced.length;
    stats.verifiedPostIds.push(...synced.map((entry) => entry.postId));
  }
  stats.skippedPostCount = postIds.length - stats.syncedPostCount;
  return stats;
}

async function importRecords(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env) || !await isOperationalAdminRequest(request, env)) return error('not_found', 404);
  const payload = await readBody<{ kind?: string; records?: ImportRecord[]; batchId?: string; copyMedia?: boolean }>(request);
  const records = Array.isArray(payload.records) ? payload.records : [];
  const ctx = createQueryContext(env);
  const stamp = now();
  let imported = 0;
  let mediaFailures = 0;
  if (payload.kind === 'profiles') {
    for (const record of records) {
      const profile = profileRecord(record);
      if (!profile.id) continue;
      await run(ctx, `INSERT INTO profiles(id, display_name, username, email, bio, avatar_url, avatar_color, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, username=excluded.username, email=excluded.email, bio=excluded.bio, avatar_url=excluded.avatar_url, updated_at=excluded.updated_at`, [profile.id, profile.name, profile.username, profile.email, profile.bio, profile.avatar, '#4f46e5', profile.createdAt, profile.updatedAt || stamp]);
      const authEmail = profile.email || `${profile.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)}@migrated.connect.invalid`;
      await run(ctx, `INSERT INTO user(id, name, email, email_verified, image, created_at, updated_at) VALUES(?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, image=excluded.image, updated_at=excluded.updated_at`, [profile.id, profile.name, authEmail, profile.avatar, profile.createdAt, profile.updatedAt || stamp]);
      imported += 1;
    }
  } else if (payload.kind === 'posts') {
    for (const record of records) {
      const postId = textValue(record, 'id', 'postId') || id();
      const authorId = textValue(record, 'authorId', 'userId', 'uid', 'creatorId');
      if (!authorId) continue;
      const createdAt = safeDate(record.createdAt || record.created_at);
      const media = await copyMediaArray(env, postId, jsonValue(record, 'media', 'mediaJson', 'imageURLs', 'images'), Boolean(payload.copyMedia));
      mediaFailures += media.failed;
      await run(ctx, `INSERT OR IGNORE INTO profiles(id, display_name, username, avatar_color, created_at, updated_at) VALUES(?, 'Connect user', ?, '#4f46e5', ?, ?)`, [authorId, usernameFor({ id: authorId }, authorId), createdAt, createdAt]);
      await upsertImportedPost(ctx, [postId, authorId, textValue(record, 'body', 'text', 'content'), normalizeVisibility(record), media.json, jsonValue(record, 'hashtags'), jsonValue(record, 'mentions'), textValue(record, 'replyToPostId') || null, textValue(record, 'threadRootId') || null, textValue(record, 'quotedPostId') || null, jsonValue(record, 'poll'), jsonValue(record, 'counts', 'stats') || JSON.stringify({}), createdAt, safeDate(record.updatedAt || record.updated_at, createdAt), record.deletedAt ? safeDate(record.deletedAt) : null]);
      imported += 1;
    }
  } else if (payload.kind === 'comments') {
    for (const record of records) {
      const commentId = textValue(record, 'id', 'commentId') || id();
      const postId = textValue(record, 'postId', 'post_id');
      const authorId = textValue(record, 'authorId', 'userId', 'uid');
      if (!postId || !authorId) continue;
      const createdAt = safeDate(record.createdAt || record.created_at);
      await run(ctx, `INSERT OR IGNORE INTO profiles(id, display_name, username, avatar_color, created_at, updated_at) VALUES(?, 'Connect user', ?, '#4f46e5', ?, ?)`, [authorId, usernameFor({ id: authorId }, authorId), createdAt, createdAt]);
      await upsertImportedComment(ctx, { postId, authorId, createdAt, values: [commentId, postId, authorId, textValue(record, 'body', 'text', 'content'), textValue(record, 'parentCommentId', 'parentId') || null, createdAt, safeDate(record.updatedAt || record.updated_at, createdAt), record.deletedAt ? safeDate(record.deletedAt) : null] });
      imported += 1;
    }
  } else if (payload.kind === 'media-map') {
    for (const record of records) {
      const postId = textValue(record, 'postId', 'post_id');
      const index = Number(record.index);
      const url = textValue(record, 'url');
      if (!postId || !Number.isInteger(index) || index < 0 || !url.startsWith('/media/')) continue;
      const row = await first<{ media_json: string | null }>(ctx, 'SELECT media_json FROM posts WHERE id = ?', [postId]);
      const media = row?.media_json ? (() => { try { return JSON.parse(row.media_json) as unknown[]; } catch { return []; } })() : [];
      if (!Array.isArray(media) || !media[index]) continue;
      const item: Record<string, unknown> = typeof media[index] === 'string' ? { url: media[index] } : { ...(media[index] as Record<string, unknown>) };
      item.url = url;
      if (record.type) item.sourceType = record.type;
      delete item.unavailable;
      media[index] = item;
      await replaceImportedMedia(ctx, postId, media);
      imported += 1;
    }
  } else {
    return error('unsupported_import_kind', 422, ctx.reads);
  }
  await run(ctx, `INSERT INTO migration_state(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, [`batch:${payload.batchId || id()}`, JSON.stringify({ kind: payload.kind, imported, count: records.length }), stamp]);
  return json({ ok: true, kind: payload.kind, imported, received: records.length, mediaFailures }, { status: 202 }, ctx.reads);
}

async function integrity(request: Request, env: Env): Promise<Response> {
  if (!requireDb(env) || !await isOperationalAdminRequest(request, env)) return error('not_found', 404);
  const ctx = createQueryContext(env);
  const expected = request.method === 'POST'
    ? await readBody<{ profiles?: string[]; posts?: string[]; comments?: string[] }>(request)
    : {};
  const counts = await first<Record<string, number>>(ctx, `SELECT (SELECT count(*) FROM profiles) AS profiles, (SELECT count(*) FROM posts) AS posts, (SELECT count(*) FROM comments) AS comments, (SELECT count(*) FROM posts_fts) AS fts, (SELECT count(*) FROM user) AS auth_users`);
  const checks = await first<Record<string, number>>(ctx, `SELECT
    (SELECT count(*) FROM posts p LEFT JOIN profiles pr ON pr.id = p.author_id WHERE pr.id IS NULL) AS posts_without_profile,
    (SELECT count(*) FROM posts p WHERE p.deleted_at IS NULL AND p.visibility NOT IN ('public', 'friends', 'private')) AS invalid_visibility,
    (SELECT count(*) FROM posts p WHERE p.deleted_at IS NULL AND (p.media_json LIKE '%firebase%' OR p.media_json LIKE '%googleapis.com%' OR p.media_json LIKE '%vercel%')) AS legacy_media,
    (SELECT count(*) FROM posts p LEFT JOIN posts_fts f ON f.post_id = p.id WHERE p.deleted_at IS NULL AND f.post_id IS NULL) AS posts_without_fts,
    (SELECT count(*) FROM posts p LEFT JOIN posts q ON q.id=p.quoted_post_id WHERE p.quoted_post_id IS NOT NULL AND q.id IS NULL) AS missing_quote_targets,
    (SELECT count(*) FROM posts p LEFT JOIN posts r ON r.id=p.reply_to_post_id WHERE p.reply_to_post_id IS NOT NULL AND r.id IS NULL) AS missing_reply_targets,
    (SELECT count(*) FROM posts p LEFT JOIN posts r ON r.id=p.thread_root_id WHERE p.thread_root_id IS NOT NULL AND r.id IS NULL) AS missing_thread_roots,
    (SELECT count(*) FROM comments c LEFT JOIN comments p ON p.id=c.parent_comment_id WHERE c.parent_comment_id IS NOT NULL AND p.id IS NULL) AS missing_comment_parents`);
  const plan = await all<Record<string, unknown>>(ctx, `EXPLAIN QUERY PLAN SELECT p.id FROM posts p JOIN profiles pr ON pr.id = p.author_id WHERE p.visibility = 'public' AND p.deleted_at IS NULL ORDER BY p.created_at DESC, p.id DESC LIMIT 20`);
  const expectedChecks: Record<string, number> = {};
  for (const [table, rawIds] of Object.entries(expected)) {
    if (!['profiles', 'posts', 'comments'].includes(table) || !Array.isArray(rawIds)) continue;
    const ids = [...new Set(rawIds.filter((value): value is string => typeof value === 'string' && value.length > 0))];
    let found = 0;
    for (let offset = 0; offset < ids.length; offset += 90) {
      const batch = ids.slice(offset, offset + 90);
      const placeholders = batch.map(() => '?').join(',');
      const row = await first<{ count: number }>(ctx, `SELECT count(*) count FROM ${table} WHERE id IN (${placeholders})`, batch);
      found += Number(row?.count || 0);
    }
    expectedChecks[`${table}_expected`] = ids.length;
    expectedChecks[`${table}_found`] = found;
    expectedChecks[`${table}_missing`] = ids.length - found;
  }
  const pass = Object.values(checks || {}).every((value) => Number(value) === 0)
    && Object.entries(expectedChecks).filter(([key]) => key.endsWith('_missing')).every(([, value]) => value === 0);
  return json({ ok: true, counts, checks, expectedChecks, queryPlan: plan, pass }, {}, ctx.reads);
}

async function verifyAlertWebhook(request: Request, env: Env): Promise<Response> {
  if (!await isOperationalAdminRequest(request, env)) return error('not_found', 404);
  return controlFetch(env, '/alert/test');
}

async function predeployAi(request: Request, env: Env): Promise<Response> {
  if (!await isOperationalAdminRequest(request, env)) return error('not_found', 404);
  try {
    const result = await runAiPredeploy(env);
    return json({ ok: true, ...result }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (cause) {
    const code = cause instanceof Error ? cause.message.slice(0, 160) : 'PREDEPLOY_FAILED';
    const retryAfter = cause instanceof AiPredeployError ? cause.retryAfterSeconds : undefined;
    const diagnostic = cause instanceof AiPredeployError ? cause.diagnostic : undefined;
    const headers: Record<string, string> = { 'Cache-Control': 'private, no-store' };
    if (retryAfter) headers['Retry-After'] = String(retryAfter);
    return json({ ok: false, code, diagnostic }, { status: 503, headers });
  }
}

// Rotate the durable marker once after the malformed-smoke failure. This is
// not a provider retry: the previous run did not receive a 429, and the new
// marker still applies the normal single-run cooldown and breaker checks.
const SCHEDULED_PREDEPLOY_RESOURCE = 'scheduled-auto-predeploy-v2';
const SCHEDULED_PREDEPLOY_COOLDOWN_MS = 12 * 3_600_000;
// A retained endpoint can serve PUBLIC_AI posts, but it must never suppress
// the scheduled policy refresh needed for FRIENDS/LIMITED/PRIVATE posts. Keep
// this list aligned with the text route's current and compatibility chains;
// the actual endpoint/provider/privacy checks remain in runAiPredeploy and
// endpointSnapshot.
const SCHEDULED_TEXT_SNAPSHOT_KEYS = ['minimaxM3', 'nemotronUltra', 'hy3', 'glm52', 'dots', 'gemma31', 'gemma26', 'lingVl'] as const;

/**
 * Keep production self-healing after an endpoint snapshot expires without
 * exposing a public predeploy trigger. The scheduled path is bounded by a
 * durable D1 cooldown and delegates all endpoint, price, privacy, provider,
 * and response checks to the same predeploy routine used by the admin route.
 * A 429 extends the cooldown; no retry is performed in this invocation.
 */
async function scheduledAiPredeploy(env: Env): Promise<void> {
  if (!env.DB || !env.OPENROUTER_API_KEY?.trim() || env.AI_ENVIRONMENT !== 'production') return;
  const now = Date.now();
  try {
    const current = await env.DB.prepare(`SELECT 1 AS ready FROM ai_endpoint_snapshots
      WHERE policy_state='VALID' AND expires_at>?
        AND model_key IN (${SCHEDULED_TEXT_SNAPSHOT_KEYS.map(() => '?').join(',')})
        AND json_extract(snapshot_json, '$.retention.type')='zdr'
      LIMIT 1`).bind(now, ...SCHEDULED_TEXT_SNAPSHOT_KEYS).first<{ ready: number }>();
    if (current?.ready === 1) return;
    // Claim the cooldown before making any upstream request. This keeps an
    // overlapping cron delivery from spending two bounded predeploy runs.
    const claim = await env.DB.prepare(`INSERT INTO ai_predeploy_progress(resource_key,phase,progress_json,verified_at,expires_at)
      VALUES(?,?,?,?,?) ON CONFLICT(resource_key) DO UPDATE SET phase=excluded.phase,progress_json=excluded.progress_json,verified_at=excluded.verified_at,expires_at=excluded.expires_at
      WHERE ai_predeploy_progress.expires_at<=?`)
      .bind(SCHEDULED_PREDEPLOY_RESOURCE, 'METADATA_VALID', JSON.stringify({ outcome: 'running' }), now, now + SCHEDULED_PREDEPLOY_COOLDOWN_MS, now).run();
    if (Number(claim.meta?.changes || 0) !== 1) return;
  } catch {
    // A scheduled policy refresh must never turn a storage hiccup into a
    // Worker-wide failure or an unbounded retry loop.
    console.log(JSON.stringify({ event: 'ai_scheduled_predeploy', outcome: 'storage_unavailable' }));
    return;
  }
  let cooldown = SCHEDULED_PREDEPLOY_COOLDOWN_MS;
  let outcome = 'failed';
  let code = 'PREDEPLOY_FAILED';
  try {
    await runAiPredeploy(env);
    const restrictedText = await env.DB.prepare(`SELECT 1 AS ready FROM ai_endpoint_snapshots
      WHERE policy_state='VALID' AND expires_at>?
        AND model_key IN (${SCHEDULED_TEXT_SNAPSHOT_KEYS.map(() => '?').join(',')})
        AND json_extract(snapshot_json, '$.retention.type')='zdr'
      LIMIT 1`).bind(Date.now(), ...SCHEDULED_TEXT_SNAPSHOT_KEYS).first<{ ready: number }>();
    if (restrictedText?.ready !== 1) throw new Error('NO_VALID_ZDR_TEXT_ENDPOINT');
    outcome = 'completed';
    code = 'OK';
  } catch (cause) {
    code = cause instanceof Error ? cause.message.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120) : code;
    if (cause instanceof AiPredeployError && cause.retryAfterSeconds) {
      cooldown = Math.max(cooldown, Math.max(60, cause.retryAfterSeconds) * 1_000);
    }
  }
  // This row is only a cooldown marker. It is not read as model metadata and
  // therefore cannot make an endpoint eligible without a successful audit.
  try {
    await env.DB.prepare(`UPDATE ai_predeploy_progress SET phase=?,progress_json=?,verified_at=?,expires_at=? WHERE resource_key=?`)
      .bind('METADATA_VALID', JSON.stringify({ outcome, code }), now, now + cooldown, SCHEDULED_PREDEPLOY_RESOURCE).run();
  } catch {
    console.log(JSON.stringify({ event: 'ai_scheduled_predeploy', outcome: 'storage_unavailable' }));
    return;
  }
  console.log(JSON.stringify({ event: 'ai_scheduled_predeploy', outcome, code, cooldownSeconds: Math.ceil(cooldown / 1_000) }));
}

async function health(env: Env): Promise<Response> {
  if (!requireDb(env)) return json({ ok: false, architecture: 'cloudflare-workers', d1: false, r2: Boolean(env.MEDIA), firebaseRuntime: false, vercelRuntime: false }, { status: 503 });
  try {
    const row = await env.DB.prepare(`SELECT (SELECT count(*) FROM profiles) AS profiles, (SELECT count(*) FROM posts) AS posts, (SELECT count(*) FROM posts_fts) AS fts`).first<Record<string, number>>();
    return json({ ok: true, architecture: 'cloudflare-workers', d1: true, r2: Boolean(env.MEDIA), queues: Boolean(env.PUSH_QUEUE), search: 'd1-fts5', firebaseRuntime: false, vercelRuntime: false, counts: row || {} }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    return json({ ok: false, architecture: 'cloudflare-workers', d1: true, error: cause instanceof Error ? cause.message : 'schema_not_ready', firebaseRuntime: false, vercelRuntime: false }, { status: 503 });
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const moderationResponse = await handleModerationRequest(request, env);
  if (moderationResponse) return moderationResponse;
  if (path === '/api/health' && request.method === 'GET') return health(env);
  if (path.startsWith('/api/auth/')) {
    if (!requireDb(env)) return error('database_unavailable', 503);
    const { auth } = await getViewer(env, request);
    if (!auth) return error('auth_not_configured', 503);
    return auth.handler(request);
  }
  if (path === '/api/bootstrap' && request.method === 'GET') return bootstrap(request, env);
  if (path === '/api/feed' && request.method === 'GET') return feed(request, env);
  if (path === '/api/search' && request.method === 'GET') return search(request, env);
  if (path === '/api/rum' && request.method === 'POST') return rum(request, env);
  if (path === '/api/ai/status' && request.method === 'GET') return aiStatus(request, env);
  if (path === '/api/ai/preferences' && (request.method === 'GET' || request.method === 'PUT')) return aiPreferences(request, env);
  if (path === '/api/ai/feedback' && request.method === 'POST') return aiFeedback(request, env);
  const migrationMediaMatch = path.match(/^\/api\/admin\/media\/(.+)$/);
  if (migrationMediaMatch && request.method === 'PUT') return migrationMedia(request, env, decodeURIComponent(migrationMediaMatch[1]));
  if (path === '/api/admin/import' && request.method === 'POST') return importRecords(request, env);
  if (path === '/api/admin/integrity' && (request.method === 'GET' || request.method === 'POST')) return integrity(request, env);
  if (path === '/api/admin/ai/alert-test' && request.method === 'POST') return verifyAlertWebhook(request, env);
  if (path === '/api/admin/ai/predeploy' && request.method === 'POST') return predeployAi(request, env);
  const syncPostMatch = path.match(/^\/api\/admin\/ai\/sync-post\/([^/]+)$/);
  if (syncPostMatch && request.method === 'POST') return syncAdminFirebasePost(request, env, decodeURIComponent(syncPostMatch[1]));
  if (path === '/api/push/public-key' && request.method === 'GET') return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
  if (path === '/api/push/subscribe' && (request.method === 'POST' || request.method === 'PUT')) return push(request, env);
  if (path === '/api/profile' && request.method === 'GET') {
    const { viewer } = await getViewer(env, request);
    return viewer ? profile(request, env, viewer.id) : error('unauthorized', 401);
  }
  if (path === '/api/profiles' && request.method === 'GET') return profilesByIds(request, env);
  const profileMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch && request.method === 'GET') return profile(request, env, decodeURIComponent(profileMatch[1]));
  if (profileMatch && request.method === 'PATCH') return updateProfile(request, env, decodeURIComponent(profileMatch[1]));
  const postMatch = path.match(/^\/api\/posts\/([^/]+)$/);
  if (postMatch && request.method === 'GET') return postDetail(request, env, decodeURIComponent(postMatch[1]));
  const postAiConsentMatch = path.match(/^\/api\/posts\/([^/]+)\/ai-consent$/);
  if (postAiConsentMatch && (request.method === 'GET' || request.method === 'PUT')) return postAiConsent(request, env, decodeURIComponent(postAiConsentMatch[1]), () => syncFirebasePost(request, env, decodeURIComponent(postAiConsentMatch[1])));
  const reactionMatch = path.match(/^\/api\/posts\/([^/]+)\/(like|bookmark)$/);
  if (reactionMatch && request.method === 'POST') return toggleReaction(request, env, decodeURIComponent(reactionMatch[1]), reactionMatch[2] as 'like' | 'bookmark');
  const pollMatch = path.match(/^\/api\/posts\/([^/]+)\/poll$/);
  if (pollMatch && request.method === 'POST') return votePoll(request, env, decodeURIComponent(pollMatch[1]));
  const commentMatch = path.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (commentMatch && request.method === 'POST') return addComment(request, env, decodeURIComponent(commentMatch[1]));
  const askAiMatch = path.match(/^\/api\/posts\/([^/]+)\/ask-ai$/);
  if (askAiMatch && (request.method === 'POST' || request.method === 'OPTIONS')) {
    const postId = decodeURIComponent(askAiMatch[1]);
    return askAi(request, env, postId, 0, request.method === 'POST' ? (correlationId) => syncFirebasePost(request, env, postId, correlationId, undefined, 4, true) : undefined);
  }
  const profileAskAiMatch = path.match(/^\/api\/profiles\/([^/]+)\/ask-ai$/);
  if (profileAskAiMatch && (request.method === 'POST' || request.method === 'OPTIONS')) {
    const profileId = decodeURIComponent(profileAskAiMatch[1]);
    return profileAskAi(request, env, profileId, 0, (input) => syncFirebaseProfileContext(request, env, input));
  }
  if (path === '/api/posts' && request.method === 'POST') return createPost(request, env);
  const mediaMatch = path.match(/^\/media\/(.+)$/);
  if (mediaMatch) {
    const key = decodeURIComponent(mediaMatch[1]);
    const response = await media(request, env, key);
    const keyDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalPostMediaKey(key) || key));
    console.log(JSON.stringify({
      event: 'media_delivery', requestId: request.headers.get('cf-ray'),
      keyHash: [...new Uint8Array(keyDigest)].map(v => v.toString(16).padStart(2, '0')).join(''),
      method: request.method, range: request.headers.get('range'), status: response.status,
      contentType: response.headers.get('content-type'), contentRange: response.headers.get('content-range'),
      contentLength: response.headers.get('content-length'),
    }));
    return response;
  }
  if (path.startsWith('/api/')) return error('not_found', 404);
  return env.ASSETS ? env.ASSETS.fetch(request) : error('not_found', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS' && AI_CORS_PATH.test(path)) {
      const origin = allowedCorsOrigin(request, env);
      if (!origin) return error('origin_not_allowed', 403);
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin',
      } });
    }
    try { return withAiCors(request, env, await route(request, env)); }
    catch (cause) {
      console.error('connect_request_failed', { name: cause instanceof Error ? cause.name : 'UnknownError', message: cause instanceof Error ? cause.message.slice(0, 160) : 'unknown' });
      // Keep the direct Worker response readable to the browser even when the
      // route itself throws. Without CORS here the frontend treats the error as
      // a network failure and replays the request through the Vercel rewrite.
      // That can duplicate a generation attempt after a late failure.
      return withAiCors(request, env, error(cause instanceof Error && cause.message === 'invalid_json' ? 'invalid_json' : 'internal_error', 500));
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const body = message.body as PushJob;
        await env.DB?.prepare(`UPDATE notifications SET payload_json = json_set(coalesce(payload_json, '{}'), '$.queuedAt', ?) WHERE id = ?`).bind(now(), body.notificationId).run();
        message.ack();
      } catch (cause) {
        console.error('connect_push_queue_failed', cause);
        message.retry();
      }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.DB) {
      await Promise.all([cleanupAiStorage(env.DB), refreshEndpointPolicies(env)]);
      await scheduledAiPredeploy(env);
    }
  },
} satisfies ExportedHandler<Env>;
