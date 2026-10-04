import { getViewer } from './auth';
import { error, id, json, now } from './lib';
import type { Env, Viewer } from './types';

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, unknown>;
  createTime?: string;
  updateTime?: string;
};
type FirestorePage = { documents?: FirestoreDocument[]; nextPageToken?: string };
type ModerationReason = 'spam' | 'harassment' | 'illegal' | 'other';
type ListCursor = { reportOffset: number; firestorePageToken: string; reportPhaseDone: boolean };

const REASONS = new Set<ModerationReason>(['spam', 'harassment', 'illegal', 'other']);
const REASON_LABELS: Record<ModerationReason, string> = {
  spam: 'スパム',
  harassment: '嫌がらせ',
  illegal: '違法コンテンツ',
  other: 'その他',
};
const SCRUBBED_FIELDS = [
  'text', 'body', 'content', 'imageURLs', 'imageURL', 'imageAlts', 'attachments',
  'videoURL', 'gifURL', 'audioURL', 'fileURL', 'poll', 'quotedPost', 'quotedPostSnapshot',
  'moderationStatus', 'deletedAt', 'deleteReason', 'deletedBy', 'updatedAt',
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function decodeValue(value: unknown): unknown {
  const raw = record(value);
  if ('stringValue' in raw) return raw.stringValue;
  if ('integerValue' in raw) return Number(raw.integerValue);
  if ('doubleValue' in raw) return Number(raw.doubleValue);
  if ('booleanValue' in raw) return raw.booleanValue;
  if ('timestampValue' in raw) return raw.timestampValue;
  if ('nullValue' in raw) return null;
  if ('arrayValue' in raw) {
    const values = record(raw.arrayValue).values;
    return Array.isArray(values) ? values.map(decodeValue) : [];
  }
  if ('mapValue' in raw) {
    const fields = record(record(raw.mapValue).fields);
    return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, decodeValue(field)]));
  }
  return value;
}

function decodedFields(document: FirestoreDocument): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record(document.fields)).map(([key, value]) => [key, decodeValue(value)]));
}

function encodeValue(value: unknown): Record<string, unknown> {
  const timestamp = record(value).__firestoreTimestamp;
  if (typeof timestamp === 'string') return { timestampValue: timestamp };
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) } };
  }
  return { nullValue: null };
}

export function encodeFirestoreFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, encodeValue(value)]));
}

function toMillis(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const raw = record(value);
  if (typeof raw.seconds === 'number') return raw.seconds * 1000;
  return 0;
}

function postIdFromName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.slice(name.lastIndexOf('/') + 1);
}

function authorIdFrom(fields: Record<string, unknown>): string {
  for (const key of ['userId', 'authorId', 'uid', 'creatorId']) {
    if (typeof fields[key] === 'string' && fields[key]) return fields[key] as string;
  }
  return '';
}

function bearerToken(request: Request): string | null {
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] || null;
}

async function authorize(request: Request, env: Env, admin = false): Promise<{ viewer: Viewer; token: string } | Response> {
  const token = bearerToken(request);
  if (!token) return error('unauthorized', 401);
  const { viewer } = await getViewer(env, request);
  if (!viewer) return error('unauthorized', 401);
  if (admin && viewer.role !== 'admin') return error('forbidden', 403);
  if (!env.DB || !env.FIREBASE_PROJECT_ID) return error('moderation_unavailable', 503);
  return { viewer, token };
}

function isResponse(value: { viewer: Viewer; token: string } | Response): value is Response {
  return value instanceof Response;
}

function firestoreDocumentUrl(env: Env, postId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID || '')}/databases/(default)/documents/posts/${encodeURIComponent(postId)}`;
}

const SUMMARY_FIELDS = ['userId', 'authorId', 'uid', 'creatorId', 'text', 'body', 'content', 'createdAt', 'deletedAt', 'deleteReason', 'moderationStatus'];

async function readFirestoreDocument(env: Env, token: string, postId: string, summary = false): Promise<{ document: FirestoreDocument | null; status: number }> {
  const url = new URL(firestoreDocumentUrl(env, postId));
  if (summary) for (const field of SUMMARY_FIELDS) url.searchParams.append('mask.fieldPaths', field);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(7_000),
  });
  if (response.status === 404) return { document: null, status: 404 };
  if (!response.ok) return { document: null, status: response.status };
  return { document: await response.json<FirestoreDocument>(), status: response.status };
}

async function patchFirestoreDocument(
  env: Env,
  token: string,
  postId: string,
  fields: Record<string, unknown>,
  mask: string[],
  exists: boolean,
  rawFields = false,
): Promise<Response> {
  const url = new URL(firestoreDocumentUrl(env, postId));
  for (const field of mask) url.searchParams.append('updateMask.fieldPaths', field);
  url.searchParams.set('currentDocument.exists', String(exists));
  return fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: rawFields ? fields : encodeFirestoreFields(fields) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function sendAuthorNotification(
  env: Env,
  token: string,
  postId: string,
  authorId: string,
  actionId: string,
  adminId: string,
  reason: ModerationReason,
): Promise<boolean> {
  const notificationId = `post_moderated_${actionId}`.slice(0, 150);
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID || '')}/databases/(default)/documents/notifications/${encodeURIComponent(notificationId)}`);
  url.searchParams.set('currentDocument.exists', 'false');
  const fields: Record<string, unknown> = {
    userId: authorId,
    type: 'post_moderated',
    eventId: actionId,
    postId,
    context: `削除理由：${REASON_LABELS[reason]}`,
    deepLink: `/#/moderation-appeal/${postId}`,
    read: false,
    createdAt: { __firestoreTimestamp: new Date().toISOString() },
  };
  const encoded = Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key,
    encodeValue(value),
  ]));
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encoded }),
    signal: AbortSignal.timeout(8_000),
  });
  if (response.ok) return true;
  if (response.status === 409 || response.status === 400) {
    const existingUrl = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID || '')}/databases/(default)/documents/notifications/${encodeURIComponent(notificationId)}`);
    const existing = await fetch(existingUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (existing?.ok) {
      const current = decodedFields(await existing.json<FirestoreDocument>());
      return current.type === 'post_moderated' && current.userId === authorId && current.postId === postId;
    }
  }
  console.warn('moderation_notification_write_failed', { postId, adminId, status: response.status });
  return false;
}

type AdminPost = {
  id: string;
  authorId: string;
  authorName: string;
  username: string;
  body: string;
  createdAt: string | number | null;
  reportCount: number;
  deletedAt: string | number | null;
  deleteReason: string | null;
  bodyTruncated?: boolean;
};

type FilterState = { postId: string; author: string; body: string; minReports: number; from: number; to: number; includeDeleted: boolean };

function matchesPost(post: AdminPost, filters: FilterState): boolean {
  if (filters.postId && !post.id.toLowerCase().includes(filters.postId)) return false;
  if (filters.author && !`${post.authorId} ${post.authorName} ${post.username}`.toLowerCase().includes(filters.author)) return false;
  if (filters.body && !post.body.toLowerCase().includes(filters.body)) return false;
  const createdAt = toMillis(post.createdAt);
  if (filters.from && createdAt < filters.from) return false;
  if (filters.to && createdAt >= filters.to) return false;
  if (post.reportCount < filters.minReports) return false;
  if (!filters.includeDeleted && post.deletedAt) return false;
  return true;
}

function decodeCursor(value: string): ListCursor | null {
  try {
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
    const parsed = JSON.parse(decoded) as Partial<ListCursor>;
    if (typeof parsed.reportOffset !== 'number' || typeof parsed.firestorePageToken !== 'string' || typeof parsed.reportPhaseDone !== 'boolean') return null;
    return parsed as ListCursor;
  } catch { return null; }
}

function encodeCursor(cursor: ListCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function parseFilters(url: URL): FilterState {
  const fromValue = url.searchParams.get('from') || '';
  const toValue = url.searchParams.get('to') || '';
  const from = fromValue ? Date.parse(`${fromValue}T00:00:00.000Z`) : 0;
  const toStart = toValue ? Date.parse(`${toValue}T00:00:00.000Z`) : 0;
  return {
    postId: (url.searchParams.get('postId') || '').trim().toLowerCase().slice(0, 160),
    author: (url.searchParams.get('author') || '').trim().toLowerCase().slice(0, 120),
    body: (url.searchParams.get('body') || '').trim().toLowerCase().slice(0, 200),
    minReports: Math.max(0, Math.min(Number(url.searchParams.get('minReports')) || 0, 100_000)),
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(toStart) && toStart ? toStart + 24 * 60 * 60 * 1000 : 0,
    includeDeleted: url.searchParams.get('includeDeleted') === 'true',
  };
}

async function countReports(db: D1Database, postIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (let start = 0; start < postIds.length; start += 60) {
    const ids = postIds.slice(start, start + 60);
    if (!ids.length) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT post_id, COUNT(*) AS report_count FROM post_reports WHERE post_id IN (${placeholders}) GROUP BY post_id`).bind(...ids).all<{ post_id: string; report_count: number }>();
    for (const row of rows.results || []) result.set(row.post_id, Number(row.report_count || 0));
  }
  return result;
}

async function hydrateAdminPosts(env: Env, documents: FirestoreDocument[], reportCounts: Map<string, number>): Promise<AdminPost[]> {
  const entries = documents.map((document) => {
    const fields = decodedFields(document);
    const idValue = postIdFromName(document.name);
    return { document, fields, id: idValue, authorId: authorIdFrom(fields) };
  }).filter((entry) => entry.id && entry.authorId);
  const authorIds = [...new Set(entries.map((entry) => entry.authorId))];
  const profiles = new Map<string, { name: string; username: string }>();
  for (let start = 0; start < authorIds.length; start += 60) {
    const ids = authorIds.slice(start, start + 60);
    if (!ids.length) continue;
    const placeholders = ids.map(() => '?').join(',');
    const result = await env.DB!.prepare(`SELECT id, display_name, username FROM profiles WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string; display_name: string; username: string }>();
    for (const profile of result.results || []) profiles.set(profile.id, { name: profile.display_name, username: profile.username });
  }
  return entries.map(({ fields, id: postId, authorId }) => {
    const profile = profiles.get(authorId);
    return {
      id: postId,
      authorId,
      authorName: profile?.name || authorId,
      username: profile?.username || '',
      body: String(fields.text ?? fields.body ?? fields.content ?? ''),
      createdAt: (fields.createdAt as string | number | null) ?? null,
      reportCount: reportCounts.get(postId) || 0,
      deletedAt: (fields.deletedAt as string | number | null) ?? null,
      deleteReason: typeof fields.deleteReason === 'string' ? fields.deleteReason : null,
    };
  });
}

async function getFirestorePage(env: Env, token: string, pageToken: string): Promise<{ documents: FirestoreDocument[]; nextPageToken: string }> {
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID || '')}/databases/(default)/documents/posts`);
  url.searchParams.set('pageSize', '50');
  url.searchParams.set('orderBy', 'createdAt desc');
  for (const field of SUMMARY_FIELDS) url.searchParams.append('mask.fieldPaths', field);
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error('firestore_list_failed');
  const page = await response.json<FirestorePage>();
  return { documents: Array.isArray(page.documents) ? page.documents : [], nextPageToken: page.nextPageToken || '' };
}

async function listModerationPosts(request: Request, env: Env): Promise<Response> {
  const authorized = await authorize(request, env, true);
  if (isResponse(authorized)) return authorized;
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 20, 50));
  const filters = parseFilters(url);
  const cursorRaw = url.searchParams.get('cursor') || '';
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : { reportOffset: 0, firestorePageToken: '', reportPhaseDone: false };
  if (!cursor) return error('invalid_cursor', 400);

  const output: AdminPost[] = [];
  let reportOffset = cursor.reportOffset;
  let firestorePageToken = cursor.firestorePageToken;
  let reportPhaseDone = cursor.reportPhaseDone;
  let scanPages = 0;

  // Process the complete highest-report-count tier before recency results, so
  // reported content is prioritized even when it is older than the first feed page.
  while (!reportPhaseDone && output.length < limit && scanPages < 8) {
    const reportRows = await env.DB!.prepare(`SELECT post_id, COUNT(*) AS report_count FROM post_reports GROUP BY post_id ORDER BY report_count DESC, post_id LIMIT 40 OFFSET ?`).bind(reportOffset).all<{ post_id: string; report_count: number }>();
    const rows = reportRows.results || [];
    if (!rows.length) { reportPhaseDone = true; break; }
    const hydrated: FirestoreDocument[] = [];
    for (let start = 0; start < rows.length; start += 10) {
      const batch = rows.slice(start, start + 10);
      const results = await Promise.all(batch.map(async (row) => {
        const result = await readFirestoreDocument(env, authorized.token, row.post_id, true).catch(() => null);
        return result?.document || null;
      }));
      hydrated.push(...results.filter((document): document is FirestoreDocument => Boolean(document)));
    }
    const counts = new Map(rows.map((row) => [row.post_id, Number(row.report_count || 0)]));
    const candidates = new Map((await hydrateAdminPosts(env, hydrated, counts)).map((post) => [post.id, post]));
    let consumed = 0;
    for (const report of rows) {
      consumed += 1;
      const post = candidates.get(report.post_id);
      if (post && matchesPost(post, filters)) output.push(post);
      if (output.length >= limit) break;
    }
    reportOffset += consumed;
    scanPages += 1;
    if (consumed === rows.length && rows.length < 40) reportPhaseDone = true;
    if (output.length >= limit) break;
  }

  const seen = new Set(output.map((post) => post.id));
  while (reportPhaseDone && output.length < limit && scanPages < 8 && firestorePageToken !== '__done__') {
    const page = await getFirestorePage(env, authorized.token, firestorePageToken);
    scanPages += 1;
    firestorePageToken = page.nextPageToken || '__done__';
    if (page.documents.length) {
      const ids = page.documents.map(postIdFromName).filter(Boolean);
      const counts = await countReports(env.DB!, ids);
      const candidates = (await hydrateAdminPosts(env, page.documents, counts))
        .filter((post) => post.reportCount === 0 && !seen.has(post.id) && matchesPost(post, filters));
      candidates.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      for (const post of candidates) {
        if (output.length >= limit) break;
        output.push(post);
        seen.add(post.id);
      }
    }
  }

  output.sort((a, b) => b.reportCount - a.reportCount || toMillis(b.createdAt) - toMillis(a.createdAt));
  const hasMore = !reportPhaseDone || firestorePageToken !== '__done__';
  const scanLimitReached = scanPages >= 8 && hasMore;
  const responsePosts = output.map((post) => ({ ...post, body: post.body.slice(0, 5_000), bodyTruncated: post.body.length > 5_000 }));
  return json({ posts: responsePosts, nextCursor: hasMore ? encodeCursor({ reportOffset, firestorePageToken, reportPhaseDone }) : null, scanLimitReached }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function recordAudit(db: D1Database, values: { id: string; postId: string; authorId: string; adminId: string; action: 'delete' | 'restore'; reason: string | null; status: string; notificationStatus: string; createdAt: number }): Promise<void> {
  await db.prepare(`INSERT INTO moderation_audit(id, post_id, author_id, admin_id, action, reason_code, status, notification_status, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(values.id, values.postId, values.authorId, values.adminId, values.action, values.reason, values.status, values.notificationStatus, values.createdAt).run();
}

async function deletePost(request: Request, env: Env, postId: string): Promise<Response> {
  const authorized = await authorize(request, env, true);
  if (isResponse(authorized)) return authorized;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return error('post_not_found', 404);
  let body: { reason?: unknown };
  try { body = await request.json<{ reason?: unknown }>(); } catch { return error('invalid_json', 400); }
  if (typeof body.reason !== 'string' || !REASONS.has(body.reason as ModerationReason)) return error('invalid_reason', 400);
  const reason = body.reason as ModerationReason;
  const fetched = await readFirestoreDocument(env, authorized.token, postId).catch(() => null);
  if (!fetched || fetched.status >= 400) return error(fetched?.status === 404 ? 'post_not_found' : 'firestore_unavailable', fetched?.status === 404 ? 404 : 502);
  const fields = decodedFields(fetched.document!);
  const authorId = authorIdFrom(fields);
  if (!authorId) return error('post_author_not_found', 409);
  if (fields.deletedAt || fields.moderationStatus === 'removed') return error('post_already_deleted', 409);

  const actionId = id();
  const capturedAt = now();
  const postRow = await env.DB!.prepare('SELECT * FROM posts WHERE id = ? LIMIT 1').bind(postId).first<Record<string, unknown>>();
  const snapshot = JSON.stringify({ document: fetched.document, postRow });
  try {
    await env.DB!.batch([
      env.DB!.prepare(`INSERT INTO moderation_audit(id, post_id, author_id, admin_id, action, reason_code, status, notification_status, created_at)
        VALUES(?, ?, ?, ?, 'delete', ?, 'pending', 'pending', ?)`)
        .bind(actionId, postId, authorId, authorized.viewer.id, reason, capturedAt),
      env.DB!.prepare(`INSERT INTO moderation_snapshots(action_id, post_id, author_id, snapshot_json, captured_at, restored_at)
        VALUES(?, ?, ?, ?, ?, NULL)`)
        .bind(actionId, postId, authorId, snapshot, capturedAt),
    ]);
  } catch {
    return error('post_moderation_in_progress', 409);
  }

  const patch = await patchFirestoreDocument(env, authorized.token, postId, {
    text: '',
    body: '',
    content: '',
    imageURLs: [],
    imageURL: '',
    imageAlts: [],
    attachments: [],
    videoURL: '',
    gifURL: '',
    audioURL: '',
    fileURL: '',
    poll: null,
    quotedPost: null,
    quotedPostSnapshot: null,
    moderationStatus: 'removed',
    deletedAt: { __firestoreTimestamp: new Date(capturedAt).toISOString() },
    deleteReason: reason,
    updatedAt: { __firestoreTimestamp: new Date(capturedAt).toISOString() },
  }, SCRUBBED_FIELDS, true).catch(() => null);

  if (!patch?.ok) {
    await env.DB!.batch([
      env.DB!.prepare(`UPDATE moderation_audit SET status='failed', notification_status='not_applicable' WHERE id=?`).bind(actionId),
      env.DB!.prepare(`UPDATE moderation_snapshots SET restored_at=? WHERE action_id=?`).bind(now(), actionId),
    ]);
    return error('post_moderation_write_failed', 502);
  }

  await env.DB!.prepare(`UPDATE posts SET deleted_at=?, delete_reason=?, deleted_by=?, body='', media_json=NULL,
      hashtags_json=NULL, mentions_json=NULL, poll_json=NULL, updated_at=?, content_version=content_version+1
    WHERE id=?`).bind(capturedAt, reason, authorized.viewer.id, capturedAt, postId).run();
  const notificationSent = await sendAuthorNotification(env, authorized.token, postId, authorId, actionId, authorized.viewer.id, reason).catch(() => false);
  await env.DB!.prepare(`UPDATE moderation_audit SET status='completed', notification_status=? WHERE id=?`)
    .bind(notificationSent ? 'sent' : 'failed', actionId).run();
  return json({ ok: true, postId, actionId, notificationSent }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function restorePost(request: Request, env: Env, postId: string): Promise<Response> {
  const authorized = await authorize(request, env, true);
  if (isResponse(authorized)) return authorized;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return error('post_not_found', 404);
  const snapshotRow = await env.DB!.prepare(`SELECT action_id, author_id, snapshot_json FROM moderation_snapshots
    WHERE post_id=? AND restored_at IS NULL ORDER BY captured_at DESC LIMIT 1`).bind(postId)
    .first<{ action_id: string; author_id: string; snapshot_json: string }>();
  if (!snapshotRow) return error('moderation_snapshot_not_found', 404);
  let snapshot: { document?: FirestoreDocument; postRow?: Record<string, unknown> };
  try { snapshot = JSON.parse(snapshotRow.snapshot_json) as typeof snapshot; } catch { return error('moderation_snapshot_corrupt', 500); }
  if (!snapshot.document?.fields) return error('moderation_snapshot_corrupt', 500);

  const current = await readFirestoreDocument(env, authorized.token, postId).catch(() => null);
  const exists = Boolean(current?.document);
  if (exists) {
    const currentFields = decodedFields(current!.document!);
    if (currentFields.moderationStatus !== 'removed' || !currentFields.deletedAt) return error('post_changed_since_deletion', 409);
  } else if (current?.status !== 404) return error('firestore_unavailable', 502);

  const originalFields = record(snapshot.document.fields);
  const restored: Record<string, unknown> = Object.fromEntries(Object.entries(originalFields));
  const actionId = id();
  const restoredAt = now();
  await recordAudit(env.DB!, {
    id: actionId, postId, authorId: snapshotRow.author_id, adminId: authorized.viewer.id,
    action: 'restore', reason: null, status: 'pending', notificationStatus: 'not_applicable', createdAt: restoredAt,
  });
  const updateMask = [...new Set([...Object.keys(originalFields), ...SCRUBBED_FIELDS])];
  const patch = await patchFirestoreDocument(env, authorized.token, postId, restored, updateMask, exists, true).catch(() => null);
  if (!patch?.ok) {
    await env.DB!.prepare(`UPDATE moderation_audit SET status='failed' WHERE id=?`).bind(actionId).run();
    return error('post_restore_write_failed', 502);
  }
  const old = record(snapshot.postRow);
  if (snapshot.postRow) {
    await env.DB!.prepare(`UPDATE posts SET body=?, visibility=?, media_json=?, hashtags_json=?, mentions_json=?, poll_json=?,
      deleted_at=NULL, delete_reason=NULL, deleted_by=NULL, updated_at=?, content_version=content_version+1 WHERE id=?`)
      .bind(String(old.body || ''), String(old.visibility || 'public'), old.media_json ?? null, old.hashtags_json ?? null,
        old.mentions_json ?? null, old.poll_json ?? null, Number(old.updated_at || restoredAt), postId).run();
  }
  await env.DB!.batch([
    env.DB!.prepare(`UPDATE moderation_snapshots SET restored_at=? WHERE action_id=?`).bind(restoredAt, snapshotRow.action_id),
    env.DB!.prepare(`UPDATE moderation_audit SET status='completed' WHERE id=?`).bind(actionId),
  ]);
  return json({ ok: true, postId, actionId }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function listAudit(request: Request, env: Env): Promise<Response> {
  const authorized = await authorize(request, env, true);
  if (isResponse(authorized)) return authorized;
  const limit = Math.max(1, Math.min(Number(new URL(request.url).searchParams.get('limit')) || 50, 100));
  const offset = Math.max(0, Number(new URL(request.url).searchParams.get('offset')) || 0);
  const result = await env.DB!.prepare(`SELECT id, post_id, author_id, admin_id, action, reason_code, status, notification_status, created_at
    FROM moderation_audit ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(limit + 1, offset).all<Record<string, unknown>>();
  const rows = result.results || [];
  return json({ entries: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function retryAuthorNotification(request: Request, env: Env, actionId: string): Promise<Response> {
  const authorized = await authorize(request, env, true);
  if (isResponse(authorized)) return authorized;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(actionId)) return error('audit_not_found', 404);
  const action = await env.DB!.prepare(`SELECT post_id, author_id, admin_id, reason_code, status, notification_status
    FROM moderation_audit WHERE id=? AND action='delete' LIMIT 1`).bind(actionId)
    .first<{ post_id: string; author_id: string; admin_id: string; reason_code: string | null; status: string; notification_status: string }>();
  if (!action || action.status !== 'completed' || action.notification_status !== 'failed') return error('notification_retry_not_available', 409);
  const fetched = await readFirestoreDocument(env, authorized.token, action.post_id).catch(() => null);
  if (!fetched?.document) return error('post_not_found', fetched?.status === 404 ? 404 : 502);
  const fields = decodedFields(fetched.document);
  if (fields.moderationStatus !== 'removed' || authorIdFrom(fields) !== action.author_id) return error('post_state_changed', 409);
  const reason = REASONS.has(action.reason_code as ModerationReason) ? action.reason_code as ModerationReason : 'other';
  const sent = await sendAuthorNotification(env, authorized.token, action.post_id, action.author_id, actionId, authorized.viewer.id, reason).catch(() => false);
  await env.DB!.prepare(`UPDATE moderation_audit SET notification_status=? WHERE id=?`).bind(sent ? 'sent' : 'failed', actionId).run();
  return json({ ok: sent, notificationSent: sent }, { status: sent ? 200 : 502, headers: { 'Cache-Control': 'private, no-store' } });
}

async function listAppeals(request: Request, env: Env): Promise<Response> {
  const authorized = await authorize(request, env, true);
  if (isResponse(authorized)) return authorized;
  const limit = Math.max(1, Math.min(Number(new URL(request.url).searchParams.get('limit')) || 50, 100));
  const result = await env.DB!.prepare(`SELECT id, post_id, user_id, message, status, created_at, reviewed_at, reviewed_by
    FROM moderation_appeals ORDER BY created_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
  return json({ appeals: result.results || [] }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function updateAppealStatus(request: Request, env: Env, appealId: string): Promise<Response> {
  const authorized = await authorize(request, env, true);
  if (isResponse(authorized)) return authorized;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(appealId)) return error('appeal_not_found', 404);
  let body: { status?: unknown };
  try { body = await request.json<{ status?: unknown }>(); } catch { return error('invalid_json', 400); }
  if (!['reviewing', 'resolved', 'rejected'].includes(String(body.status || ''))) return error('invalid_appeal_status', 400);
  const result = await env.DB!.prepare(`UPDATE moderation_appeals SET status=?, reviewed_at=?, reviewed_by=? WHERE id=?`)
    .bind(body.status, now(), authorized.viewer.id, appealId).run();
  if (!result.meta.changes) return error('appeal_not_found', 404);
  return json({ ok: true, appealId, status: body.status }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function appeal(request: Request, env: Env, postId: string, submit: boolean): Promise<Response> {
  const authorized = await authorize(request, env);
  if (isResponse(authorized)) return authorized;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return error('post_not_found', 404);
  const fetched = await readFirestoreDocument(env, authorized.token, postId).catch(() => null);
  if (!fetched?.document) return error('post_not_found', fetched?.status === 404 ? 404 : 502);
  const fields = decodedFields(fetched.document);
  if (authorIdFrom(fields) !== authorized.viewer.id) return error('forbidden', 403);
  if (!fields.deletedAt || fields.moderationStatus !== 'removed') return error('post_not_moderated', 409);
  if (!submit) {
    const existing = await env.DB!.prepare(`SELECT id, status, message, created_at FROM moderation_appeals WHERE post_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1`)
      .bind(postId, authorized.viewer.id).first<Record<string, unknown>>();
    return json({ postId, deleteReason: fields.deleteReason || null, appeal: existing }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  let body: { message?: unknown };
  try { body = await request.json<{ message?: unknown }>(); } catch { return error('invalid_json', 400); }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (message.length < 10 || message.length > 2_000) return error('invalid_appeal_message', 400);
  const existing = await env.DB!.prepare(`SELECT id FROM moderation_appeals WHERE post_id=? AND user_id=? AND status IN ('pending','reviewing') LIMIT 1`)
    .bind(postId, authorized.viewer.id).first<{ id: string }>();
  if (existing) return error('appeal_already_submitted', 409);
  const appealId = id();
  await env.DB!.prepare(`INSERT INTO moderation_appeals(id, post_id, user_id, message, status, created_at)
    VALUES(?, ?, ?, ?, 'pending', ?)`).bind(appealId, postId, authorized.viewer.id, message, now()).run();
  return json({ ok: true, appealId }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
}

async function reportPost(request: Request, env: Env, postId: string): Promise<Response> {
  const authorized = await authorize(request, env);
  if (isResponse(authorized)) return authorized;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(postId)) return error('post_not_found', 404);
  let body: { reason?: unknown; details?: unknown };
  try { body = await request.json<{ reason?: unknown; details?: unknown }>(); } catch { return error('invalid_json', 400); }
  if (typeof body.reason !== 'string' || !REASONS.has(body.reason as ModerationReason)) return error('invalid_reason', 400);
  const fetched = await readFirestoreDocument(env, authorized.token, postId).catch(() => null);
  if (!fetched?.document) return error('post_not_found', fetched?.status === 404 ? 404 : 502);
  const fields = decodedFields(fetched.document);
  const authorId = authorIdFrom(fields);
  if (!authorId || fields.deletedAt || authorId === authorized.viewer.id) return error('post_not_reportable', 409);
  const details = typeof body.details === 'string' ? body.details.trim().slice(0, 500) : '';
  try {
    await env.DB!.prepare(`INSERT INTO post_reports(id, post_id, reporter_id, reason_code, details, status, created_at)
      VALUES(?, ?, ?, ?, ?, 'open', ?)`).bind(id(), postId, authorized.viewer.id, body.reason, details || null, now()).run();
  } catch {
    return error('already_reported', 409);
  }
  return json({ ok: true }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function handleModerationRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/admin/moderation/posts' && request.method === 'GET') return listModerationPosts(request, env);
  if (pathname === '/api/admin/moderation/audit' && request.method === 'GET') return listAudit(request, env);
  const retryNotificationMatch = pathname.match(/^\/api\/admin\/moderation\/audit\/([^/]+)\/retry-notification$/);
  if (retryNotificationMatch && request.method === 'POST') return retryAuthorNotification(request, env, decodeURIComponent(retryNotificationMatch[1]));
  if (pathname === '/api/admin/moderation/appeals' && request.method === 'GET') return listAppeals(request, env);
  const appealStatusMatch = pathname.match(/^\/api\/admin\/moderation\/appeals\/([^/]+)$/);
  if (appealStatusMatch && request.method === 'PATCH') return updateAppealStatus(request, env, decodeURIComponent(appealStatusMatch[1]));
  if (pathname === '/api/moderation/appeals' && request.method === 'POST') {
    const body: { postId?: unknown } = await request.clone().json<{ postId?: unknown }>().catch(() => ({} as { postId?: unknown }));
    if (typeof body.postId !== 'string') return error('post_not_found', 404);
    return appeal(request, env, body.postId, true);
  }
  if (pathname.startsWith('/api/moderation/appeals/') && request.method === 'GET') {
    return appeal(request, env, decodeURIComponent(pathname.slice('/api/moderation/appeals/'.length)), false);
  }
  const restoreMatch = pathname.match(/^\/api\/admin\/moderation\/posts\/([^/]+)\/restore$/);
  if (restoreMatch && request.method === 'POST') return restorePost(request, env, decodeURIComponent(restoreMatch[1]));
  const adminPostMatch = pathname.match(/^\/api\/admin\/posts\/([^/]+)$/);
  if (adminPostMatch && request.method === 'DELETE') return deletePost(request, env, decodeURIComponent(adminPostMatch[1]));
  const reportMatch = pathname.match(/^\/api\/posts\/([^/]+)\/report$/);
  if (reportMatch && request.method === 'POST') return reportPost(request, env, decodeURIComponent(reportMatch[1]));
  return null;
}
