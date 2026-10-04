import { id, now, type QueryContext, run } from '../lib';

export async function createPostRecord(ctx: QueryContext, input: {
  authorId: string; body: string; visibility: string; media: unknown[]; hashtags: string[]; mentions: string[];
  replyToPostId?: string | null; quotedPostId?: string | null;
}): Promise<string> {
  const postId = id();
  const stamp = now();
  let threadRootId: string | null = null;
  if (input.replyToPostId) {
    const parent = await ctx.db.prepare('SELECT id, thread_root_id FROM posts WHERE id = ? AND deleted_at IS NULL').bind(input.replyToPostId).first<{ id: string; thread_root_id: string | null }>();
    if (!parent) throw new Error('reply_target_not_found');
    threadRootId = parent.thread_root_id || parent.id;
  }
  await run(ctx, `INSERT INTO posts(
      id, author_id, body, visibility, media_json, hashtags_json, mentions_json,
      reply_to_post_id, thread_root_id, quoted_post_id, counts_json, created_at, updated_at,
      content_version, access_version, media_version, structure_version
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`, [
    postId, input.authorId, input.body, input.visibility, JSON.stringify(input.media), JSON.stringify(input.hashtags),
    JSON.stringify(input.mentions), input.replyToPostId || null, threadRootId, input.quotedPostId || null,
    JSON.stringify({ likes: 0, comments: 0, shares: 0 }), stamp, stamp,
  ]);
  return postId;
}

export async function createCommentRecord(ctx: QueryContext, input: { postId: string; authorId: string; body: string; parentCommentId?: string | null }): Promise<string> {
  const commentId = id();
  if (input.parentCommentId) {
    const parent = await ctx.db.prepare('SELECT id FROM comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL').bind(input.parentCommentId, input.postId).first();
    if (!parent) throw new Error('comment_parent_not_found');
  }
  const stamp = now();
  await run(ctx, `INSERT INTO comments(id, post_id, author_id, body, parent_comment_id, created_at, updated_at, content_version, access_version, media_version, structure_version)
    VALUES(?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)`, [commentId, input.postId, input.authorId, input.body, input.parentCommentId || null, stamp, stamp]);
  return commentId;
}

type StoredPollOption = { text?: unknown; votes?: unknown; [key: string]: unknown };
type StoredPoll = { question?: unknown; options?: unknown; totalVotes?: unknown; expiresAt?: unknown; [key: string]: unknown };
type PollVoteResult = { ok: true } | { ok: false; code: 'poll_not_found' | 'poll_expired' | 'poll_already_voted' | 'invalid_poll_option' | 'poll_update_conflict' };

function pollExpiryMillis(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function writablePoll(value: unknown): { poll: StoredPoll; options: Array<StoredPollOption & { text: string; votes: string[] }> } | null {
  if (!value || typeof value !== 'object') return null;
  const poll = value as StoredPoll;
  const rawOptions = Array.isArray(poll.options)
    ? poll.options
    : poll.options && typeof poll.options === 'object'
      ? Object.values(poll.options as Record<string, unknown>)
      : [];
  const options = rawOptions.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const option = value as StoredPollOption;
    const text = typeof option.text === 'string' ? option.text.trim() : '';
    if (!text) return [];
    const existingVotes = Array.isArray(option.votes)
      ? option.votes.filter((vote): vote is string => typeof vote === 'string')
      : typeof option.votes === 'number' && Number.isFinite(option.votes)
        ? Array.from({ length: Math.max(0, Math.floor(option.votes)) }, (_, voteIndex) => `legacy-${index}-${voteIndex}`)
        : [];
    return [{ ...option, text, votes: existingVotes }];
  });
  return options.length ? { poll, options } : null;
}

export async function recordPollVote(ctx: QueryContext, input: { postId: string; viewerId: string; optionIndex: number }): Promise<PollVoteResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await ctx.db.prepare('SELECT poll_json FROM posts WHERE id = ? AND deleted_at IS NULL').bind(input.postId).first<{ poll_json: string | null }>();
    let parsedValue: unknown = null;
    try { parsedValue = row?.poll_json ? JSON.parse(row.poll_json) : null; } catch { parsedValue = null; }
    const parsed = writablePoll(parsedValue);
    if (!parsed) return { ok: false, code: 'poll_not_found' };
    const expiry = pollExpiryMillis(parsed.poll.expiresAt);
    if (expiry > 0 && expiry <= now()) return { ok: false, code: 'poll_expired' };
    if (!parsed.options[input.optionIndex]) return { ok: false, code: 'invalid_poll_option' };
    if (parsed.options.some((option) => option.votes.includes(input.viewerId))) return { ok: false, code: 'poll_already_voted' };
    parsed.options[input.optionIndex].votes.push(input.viewerId);
    const totalVotes = parsed.options.reduce((sum, option) => sum + option.votes.length, 0);
    const updatedPoll = { ...parsed.poll, options: parsed.options, totalVotes };
    const result = await run(ctx, 'UPDATE posts SET poll_json = ?, structure_version = structure_version + 1, updated_at = ? WHERE id = ? AND poll_json = ?', [JSON.stringify(updatedPoll), now(), input.postId, row?.poll_json || null]);
    if (Number(result.meta.changes || 0) > 0) return { ok: true };
  }
  return { ok: false, code: 'poll_update_conflict' };
}

export async function updatePostContent(ctx: QueryContext, postId: string, authorId: string, body: string): Promise<void> {
  const result = await run(ctx, 'UPDATE posts SET body = ?, content_version = content_version + 1, updated_at = ? WHERE id = ? AND author_id = ? AND deleted_at IS NULL', [body, now(), postId, authorId]);
  if (!result.meta.changes) throw new Error('post_not_found');
}

export async function updatePostAccess(ctx: QueryContext, postId: string, authorId: string, visibility: string, deletedAt: number | null = null): Promise<void> {
  const result = await run(ctx, 'UPDATE posts SET visibility = ?, deleted_at = ?, access_version = access_version + 1, updated_at = ? WHERE id = ? AND author_id = ?', [visibility, deletedAt, now(), postId, authorId]);
  if (!result.meta.changes) throw new Error('post_not_found');
}

export async function replacePostMedia(ctx: QueryContext, postId: string, authorId: string, media: unknown[]): Promise<void> {
  const result = await run(ctx, 'UPDATE posts SET media_json = ?, media_version = media_version + 1, updated_at = ? WHERE id = ? AND author_id = ? AND deleted_at IS NULL', [JSON.stringify(media), now(), postId, authorId]);
  if (!result.meta.changes) throw new Error('post_not_found');
}

export async function updateAuthorAiPreferences(ctx: QueryContext, userId: string, input: { acceptedPolicyVersion: string; textAnalysis: string; mediaAnalysis: string }): Promise<void> {
  const stamp = now();
  await run(ctx, `INSERT INTO ai_author_preferences(user_id, accepted_policy_version, preference_version, text_analysis, media_analysis, created_at, updated_at)
    VALUES(?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET accepted_policy_version=excluded.accepted_policy_version,
      preference_version=ai_author_preferences.preference_version + 1, text_analysis=excluded.text_analysis,
      media_analysis=excluded.media_analysis, updated_at=excluded.updated_at`, [userId, input.acceptedPolicyVersion, input.textAnalysis, input.mediaAnalysis, stamp, stamp]);
}

export async function updatePostAiConsent(ctx: QueryContext, postId: string, authorId: string, input: { acceptedPolicyVersion: string; enabled: boolean }): Promise<void> {
  const stamp = now();
  const state = input.enabled ? 'AUTHORIZED_CONTEXT' : 'DISABLED';
  const result = await run(ctx, `INSERT INTO post_ai_consents(
      post_id, author_id, accepted_policy_version, consent_version, text_analysis, media_analysis, created_at, updated_at
    ) SELECT p.id, p.author_id, ?, 1, ?, ?, ?, ?
      FROM posts p WHERE p.id=? AND p.author_id=? AND p.deleted_at IS NULL
    ON CONFLICT(post_id) DO UPDATE SET accepted_policy_version=excluded.accepted_policy_version,
      author_id=excluded.author_id, consent_version=post_ai_consents.consent_version + 1,
      text_analysis=excluded.text_analysis, media_analysis=excluded.media_analysis, updated_at=excluded.updated_at`, [
    input.acceptedPolicyVersion, state, state, stamp, stamp, postId, authorId,
  ]);
  if (!result.meta.changes) throw new Error('post_not_found');
}

export async function upsertImportedPost(ctx: QueryContext, values: unknown[], firestoreUpdateTime: string | null = null): Promise<void> {
  await run(ctx, `INSERT INTO posts(id, author_id, body, visibility, media_json, hashtags_json, mentions_json, reply_to_post_id, thread_root_id, quoted_post_id, poll_json, counts_json, created_at, updated_at, deleted_at, firestore_update_time) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET author_id=excluded.author_id, body=excluded.body, visibility=excluded.visibility, media_json=excluded.media_json, hashtags_json=excluded.hashtags_json, mentions_json=excluded.mentions_json, reply_to_post_id=excluded.reply_to_post_id, thread_root_id=excluded.thread_root_id, quoted_post_id=excluded.quoted_post_id, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
      firestore_update_time=COALESCE(excluded.firestore_update_time,posts.firestore_update_time),
      content_version=posts.content_version + CASE WHEN posts.body IS NOT excluded.body THEN 1 ELSE 0 END,
      access_version=posts.access_version + CASE WHEN posts.visibility IS NOT excluded.visibility OR posts.deleted_at IS NOT excluded.deleted_at THEN 1 ELSE 0 END,
      media_version=posts.media_version + CASE WHEN posts.media_json IS NOT excluded.media_json THEN 1 ELSE 0 END,
      structure_version=posts.structure_version + CASE WHEN posts.reply_to_post_id IS NOT excluded.reply_to_post_id OR posts.thread_root_id IS NOT excluded.thread_root_id OR posts.quoted_post_id IS NOT excluded.quoted_post_id THEN 1 ELSE 0 END`, [...values, firestoreUpdateTime]);
}

export async function updateImportedPostVisibility(ctx: QueryContext, postId: string, authorId: string, visibility: string): Promise<void> {
  await run(ctx, `UPDATE posts SET visibility=?,access_version=access_version+1,updated_at=?
    WHERE id=? AND author_id=? AND visibility<>?`, [visibility, now(), postId, authorId, visibility]);
}

export async function markImportedPostDeleted(ctx: QueryContext, postId: string, authorId: string): Promise<void> {
  const stamp = now();
  await run(ctx, `UPDATE posts SET deleted_at=?,access_version=access_version+1,updated_at=?
    WHERE id=? AND author_id=? AND deleted_at IS NULL`, [stamp, stamp, postId, authorId]);
}

export async function upsertImportedComment(ctx: QueryContext, input: { values: unknown[]; postId: string; authorId: string; createdAt: number }): Promise<void> {
  await run(ctx, `INSERT OR IGNORE INTO posts(id, author_id, body, visibility, counts_json, created_at, updated_at, deleted_at) VALUES(?, ?, '', 'private', '{}', ?, ?, ?)`, [input.postId, input.authorId, input.createdAt, input.createdAt, now()]);
  await run(ctx, `INSERT INTO comments(id, post_id, author_id, body, parent_comment_id, created_at, updated_at, deleted_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body, parent_comment_id=excluded.parent_comment_id, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
      content_version=comments.content_version + CASE WHEN comments.body IS NOT excluded.body THEN 1 ELSE 0 END,
      access_version=comments.access_version + CASE WHEN comments.deleted_at IS NOT excluded.deleted_at THEN 1 ELSE 0 END,
      structure_version=comments.structure_version + CASE WHEN comments.parent_comment_id IS NOT excluded.parent_comment_id THEN 1 ELSE 0 END`, input.values);
}

export async function replaceImportedMedia(ctx: QueryContext, postId: string, media: unknown[]): Promise<void> {
  await run(ctx, 'UPDATE posts SET media_json = ?, media_version = media_version + 1, updated_at = ? WHERE id = ?', [JSON.stringify(media), now(), postId]);
}
