import type { Env, PostRow, ProfileRow, Viewer } from './types';

export type QueryContext = { db: D1Database; reads: number; aiEnvironment?: Env['AI_ENVIRONMENT'] };

export const createQueryContext = (env: Env): QueryContext => ({ db: env.DB as D1Database, reads: 0, aiEnvironment: env.AI_ENVIRONMENT });

/**
 * Test-only Ask AI posts must never be part of the production content or
 * context surface. The historical smoke rows predate a dedicated fixture
 * column, so keep their exact reserved ID/marker patterns here. Do not use a
 * bare `synthetic` substring: a normal user may discuss synthetic materials
 * or synthetic data and must not disappear from the public feed.
 */
const PRODUCTION_FIXTURE_BODY_MARKERS = [
  'connect ask ai production smoke test.',
  'ask ai vision production synthetic test:',
] as const;

export function productionFixturePredicate(alias = 'p'): string {
  const body = `lower(trim(COALESCE(${alias}.body, '')))`;
  const bodyFilters = PRODUCTION_FIXTURE_BODY_MARKERS
    .map((marker) => `${body} NOT LIKE '${marker}%'`)
    .join(' AND ');
  return `(instr(lower(${alias}.id), 'ask_ai_smoke_') <> 1 AND ${bodyFilters})`;
}

export function isProductionFixturePost(idValue: string, body: string): boolean {
  const normalizedId = idValue.trim().toLowerCase();
  const normalizedBody = body.trim().toLowerCase();
  return normalizedId.startsWith('ask_ai_smoke_')
    || PRODUCTION_FIXTURE_BODY_MARKERS.some((marker) => normalizedBody.startsWith(marker));
}

export async function all<T = Record<string, unknown>>(ctx: QueryContext, sql: string, bindings: unknown[] = []): Promise<T[]> {
  ctx.reads += 1;
  const result = await ctx.db.prepare(sql).bind(...bindings).all<T>();
  return result.results ?? [];
}

export async function first<T = Record<string, unknown>>(ctx: QueryContext, sql: string, bindings: unknown[] = []): Promise<T | null> {
  ctx.reads += 1;
  return (await ctx.db.prepare(sql).bind(...bindings).first<T>()) ?? null;
}

export async function run(ctx: QueryContext, sql: string, bindings: unknown[] = []): Promise<D1Result> {
  ctx.reads += 1;
  return ctx.db.prepare(sql).bind(...bindings).run();
}

export const json = (body: unknown, init: ResponseInit = {}, reads?: number) => {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', headers.get('Cache-Control') ?? 'no-store');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (typeof reads === 'number') headers.set('X-Connect-Db-Reads', String(reads));
  return new Response(JSON.stringify(body), { ...init, headers });
};

export const error = (message: string, status = 400, reads?: number) => json({ error: message }, { status }, reads);

export const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

export const now = () => Date.now();
export const id = () => crypto.randomUUID();

export function encodeCursor(createdAt: number, postId: string): string {
  return btoa(JSON.stringify({ createdAt, postId })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function decodeCursor(value: string | null): { createdAt: number; postId: string } | null {
  if (!value) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const parsed = JSON.parse(atob(padded)) as { createdAt?: number; postId?: string };
    return typeof parsed.createdAt === 'number' && typeof parsed.postId === 'string' ? { createdAt: parsed.createdAt, postId: parsed.postId } : null;
  } catch { return null; }
}

export const normalizeLimit = (raw: string | null) => Math.min(Math.max(Number(raw || 20) || 20, 1), 50);

export function profileFromRow(row: ProfileRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    email: row.email ?? null,
    bio: row.bio ?? '',
    avatarUrl: row.avatar_url ?? null,
    coverUrl: row.cover_url ?? null,
    avatarColor: row.avatar_color || '#4f46e5',
    counts: parseJson(row.counts_json, {}),
  };
}

type AuthorProjection = Pick<PostRow, 'author_id' | 'author_profile_id' | 'author_name' | 'author_username' | 'author_avatar_url' | 'author_avatar_color'>;

/**
 * Posts own only `author_id`. The query supplies current profile data; never
 * read a profile snapshot stored on the post as the presentation source.
 */
export function authorFromRow(row: AuthorProjection): Record<string, unknown> {
  const isUnavailable = row.author_profile_id === null;
  return {
    id: row.author_id,
    displayName: isUnavailable ? '削除されたユーザー' : (row.author_name || 'Connect user'),
    username: isUnavailable ? 'deleted' : (row.author_username || 'connect'),
    avatarUrl: isUnavailable ? null : (row.author_avatar_url ?? null),
    avatarColor: isUnavailable ? '#64748b' : (row.author_avatar_color || '#4f46e5'),
    isUnavailable,
  };
}

type PollOptionRow = { text?: unknown; votes?: unknown };

function pollForViewer(value: unknown, viewerId = ''): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rawOptions = Array.isArray(record.options)
    ? record.options
    : record.options && typeof record.options === 'object'
      ? Object.values(record.options as Record<string, unknown>)
      : [];
  const options: Array<{ text: string; votes: number }> = [];
  let votedOptionIndex: number | null = null;
  for (const raw of rawOptions) {
    if (!raw || typeof raw !== 'object') continue;
    const option = raw as PollOptionRow;
    const text = typeof option.text === 'string' ? option.text.trim() : '';
    if (!text) continue;
    const votes = Array.isArray(option.votes)
      ? option.votes.filter((id): id is string => typeof id === 'string')
      : [];
    const count = Array.isArray(option.votes)
      ? votes.length
      : typeof option.votes === 'number' && Number.isFinite(option.votes)
        ? Math.max(0, Math.floor(option.votes))
        : 0;
    if (viewerId && votes.includes(viewerId) && votedOptionIndex === null) votedOptionIndex = options.length;
    options.push({ text, votes: count });
  }
  if (!options.length) return null;
  const totalVotes = typeof record.totalVotes === 'number' && Number.isFinite(record.totalVotes)
    ? Math.max(0, Math.floor(record.totalVotes))
    : options.reduce((sum, option) => sum + option.votes, 0);
  return {
    question: typeof record.question === 'string' ? record.question : '',
    options,
    totalVotes: Math.max(totalVotes, options.reduce((sum, option) => sum + option.votes, 0)),
    expiresAt: record.expiresAt ?? null,
    votedOptionIndex,
  };
}

export function postFromRow(row: PostRow, viewerId = ''): Record<string, unknown> {
  const counts = parseJson<Record<string, number>>(row.counts_json, {});
  return {
    id: row.id,
    authorId: row.author_id,
    author: authorFromRow(row),
    body: row.body,
    visibility: row.visibility,
    media: parseJson(row.media_json, []),
    hashtags: parseJson(row.hashtags_json, []),
    mentions: parseJson(row.mentions_json, []),
    quotedPostId: row.quoted_post_id ?? null,
    poll: pollForViewer(parseJson(row.poll_json, null), viewerId),
    counts: {
      likes: Number(row.likes_count ?? counts.likes ?? counts.likeCount ?? 0),
      comments: Number(row.comments_count ?? counts.comments ?? counts.commentCount ?? 0),
      shares: Number(counts.shares ?? counts.shareCount ?? 0),
    },
    liked: Boolean(row.liked),
    bookmarked: Boolean(row.bookmarked),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function viewerFromSession(value: unknown): Viewer | null {
  const session = value as { user?: { id?: string; name?: string; email?: string; image?: string | null } } | null;
  if (!session?.user?.id || !session.user.email) return null;
  return { id: session.user.id, name: session.user.name || '', email: session.user.email, image: session.user.image };
}

export function visibilityPredicate(viewerId: string | null, tableAlias = 'p'): { sql: string; bindings: unknown[] } {
  const blocked = viewerId
    ? `AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ? AND bl.blocked_id = ${tableAlias}.author_id) OR (bl.blocker_id = ${tableAlias}.author_id AND bl.blocked_id = ?))`
    : '';
  const blockedBindings = viewerId ? [viewerId, viewerId] : [];
  if (!viewerId) return { sql: `${tableAlias}.visibility = 'public' AND ${tableAlias}.deleted_at IS NULL`, bindings: [] };
  return {
    sql: `((${tableAlias}.visibility = 'public' OR ${tableAlias}.author_id = ? OR (${tableAlias}.visibility = 'friends' AND EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.requester_id = ? AND f.addressee_id = ${tableAlias}.author_id) OR (f.requester_id = ${tableAlias}.author_id AND f.addressee_id = ?)))) AND ${tableAlias}.deleted_at IS NULL ${blocked}))`,
    bindings: [viewerId, viewerId, viewerId, ...blockedBindings],
  };
}

export function cursorPredicate(cursor: { createdAt: number; postId: string } | null, alias = 'p'): { sql: string; bindings: unknown[] } {
  return cursor ? { sql: `AND (${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`, bindings: [cursor.createdAt, cursor.createdAt, cursor.postId] } : { sql: '', bindings: [] };
}
