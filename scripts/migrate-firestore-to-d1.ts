import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveAvatarURL } from '../src/avatar.ts';

type FirestoreValue = Record<string, unknown>;
type Document = { name: string; fields?: Record<string, FirestoreValue> };
type ImportRecord = Record<string, unknown>;

const projectId = process.env.FIREBASE_PROJECT_ID || 'connect-b5e82';
const baseUrl = (process.env.CONNECT_BASE_URL || '').replace(/\/$/, '');
const token = process.env.MIGRATION_TOKEN || '';
const exportPath = resolve(process.env.MIGRATION_EXPORT_PATH || 'migration/firestore-public-export.json');
const exportOnly = process.argv.includes('--export-only');
const copyMedia = process.argv.includes('--copy-media');
const allowAllPublic = process.argv.includes('--allow-all-public');
const migrationUserIds = new Set((process.env.MIGRATION_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const migrationPostIds = new Set((process.env.MIGRATION_POST_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));

function valueOf(value: FirestoreValue | undefined): unknown {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return ((value.arrayValue as { values?: FirestoreValue[] }).values || []).map(valueOf);
  if ('mapValue' in value) return Object.fromEntries(Object.entries((value.mapValue as { fields?: Record<string, FirestoreValue> }).fields || {}).map(([key, item]) => [key, valueOf(item)]));
  return null;
}

function docId(document: Document): string { return document.name.split('/').pop() || ''; }
function unwrap(document: Document): ImportRecord { return { id: docId(document), ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, valueOf(value)])) }; }

async function listCollection(collection: string): Promise<ImportRecord[]> {
  const output: ImportRecord[] = [];
  let pageToken = '';
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Firestore ${collection} export failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { documents?: Document[]; nextPageToken?: string };
    output.push(...(body.documents || []).map(unwrap));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return output;
}

function mediaValues(record: ImportRecord): Array<{ url: string; type?: string; alt?: string }> {
  const values = Array.isArray(record.imageURLs) ? record.imageURLs : Array.isArray(record.images) ? record.images : [];
  const urls = values.filter((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value));
  if (typeof record.imageURL === 'string' && /^https?:\/\//i.test(record.imageURL)) urls.push(record.imageURL);
  if (typeof record.videoURL === 'string' && /^https?:\/\//i.test(record.videoURL)) urls.push(record.videoURL);
  return [...new Set(urls)].slice(0, 8).map((url) => ({ url }));
}

function normalizeProfile(record: ImportRecord): ImportRecord {
  return { id: String(record.id || record.uid || ''), displayName: record.displayName || record.name || record.username || 'Connect user', username: record.username || record.handle || `user_${String(record.id || '').slice(0, 18)}`, email: null, bio: record.bio || record.description || '', avatarUrl: resolveAvatarURL(record) || null, createdAt: record.createdAt || null, updatedAt: record.updatedAt || record.createdAt || null };
}

function normalizePost(record: ImportRecord): ImportRecord {
  return {
    id: String(record.id || ''), authorId: String(record.userId || record.authorId || record.uid || record.creatorId || ''),
    body: record.text || record.body || record.content || '', visibility: record.visibility || 'public', media: mediaValues(record),
    hashtags: record.hashtags || [], mentions: record.mentions || [], quotedPostId: record.quotedPostId || null,
    replyToPostId: record.replyToPostId || null, threadId: record.threadId || null,
    threadIndex: Number.isFinite(Number(record.threadIndex)) ? Number(record.threadIndex) : null,
    counts: { likes: Number(record.likesCount || 0), comments: Number(record.commentsCount || 0), shares: Number(record.repostsCount || 0) },
    createdAt: record.createdAt || null, updatedAt: record.updatedAt || record.createdAt || null, deletedAt: record.deletedAt || null,
  };
}

function normalizeComment(record: ImportRecord): ImportRecord {
  return { id: String(record.id || ''), postId: String(record.postId || record.post_id || ''), authorId: String(record.userId || record.authorId || record.uid || ''), body: record.text || record.body || record.content || '', parentCommentId: record.parentCommentId || record.parentId || null, createdAt: record.createdAt || null, updatedAt: record.updatedAt || record.createdAt || null, deletedAt: record.deletedAt || null };
}

function attachThreadRoots(posts: ImportRecord[]): void {
  const groups = new Map<string, ImportRecord[]>();
  for (const post of posts) {
    const threadId = typeof post.threadId === 'string' ? post.threadId : '';
    if (!threadId) continue;
    const group = groups.get(threadId) || [];
    group.push(post);
    groups.set(threadId, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => Number(left.threadIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.threadIndex ?? Number.MAX_SAFE_INTEGER));
    const rootId = String(group[0]?.id || '');
    if (!rootId) continue;
    for (const post of group) post.threadRootId = String(post.id) === rootId ? null : rootId;
  }
}

function scopePayload<T extends { profiles: ImportRecord[]; posts: ImportRecord[]; comments: ImportRecord[] }>(payload: T): T {
  if (allowAllPublic) return payload;
  if (!migrationUserIds.size && !migrationPostIds.size) throw new Error('Import requires MIGRATION_USER_IDS or MIGRATION_POST_IDS; use --allow-all-public only after explicit review');
  const byId = new Map(payload.posts.map((post) => [String(post.id), post]));
  const selectedIds = new Set(payload.posts.filter((post) => migrationUserIds.has(String(post.authorId)) || migrationPostIds.has(String(post.id))).map((post) => String(post.id)));
  const pending = [...selectedIds];
  while (pending.length) {
    const post = byId.get(pending.pop() || '');
    const quoted = typeof post?.quotedPostId === 'string' ? post.quotedPostId : '';
    if (quoted && byId.has(quoted) && !selectedIds.has(quoted)) { selectedIds.add(quoted); pending.push(quoted); }
  }
  const posts = payload.posts.filter((post) => selectedIds.has(String(post.id)));
  const comments = payload.comments.filter((comment) => selectedIds.has(String(comment.postId)));
  const profileIds = new Set([...posts.map((post) => String(post.authorId)), ...comments.map((comment) => String(comment.authorId))]);
  const profiles = payload.profiles.filter((profile) => profileIds.has(String(profile.id)));
  return { ...payload, profiles, posts, comments };
}

async function exportPublicData() {
  const [profilesRaw, postsRaw, commentsRaw] = await Promise.all([listCollection('users'), listCollection('posts'), listCollection('comments')]);
  const posts = postsRaw.map(normalizePost).filter((record) => Boolean(record.id && record.authorId) && record.visibility === 'public' && !record.deletedAt);
  attachThreadRoots(posts);
  const publicPostIds = new Set(posts.map((record) => String(record.id)));
  const comments = commentsRaw.map(normalizeComment).filter((record) => Boolean(record.id && record.postId && record.authorId) && publicPostIds.has(String(record.postId)) && !record.deletedAt);
  const requiredProfileIds = new Set([...posts.map((record) => String(record.authorId)), ...comments.map((record) => String(record.authorId))]);
  const profiles = profilesRaw.map(normalizeProfile).filter((record) => Boolean(record.id) && requiredProfileIds.has(String(record.id)));
  const known = new Set(profiles.map((record) => String(record.id)));
  for (const post of posts) if (!known.has(String(post.authorId))) { profiles.push(normalizeProfile({ id: post.authorId })); known.add(String(post.authorId)); }
  const payload = { exportedAt: new Date().toISOString(), source: { projectId, collections: { users: profilesRaw.length, posts: postsRaw.length, comments: commentsRaw.length } }, profiles, posts, comments };
  await mkdir(resolve(exportPath, '..'), { recursive: true });
  await writeFile(exportPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function importKind(kind: string, records: ImportRecord[], batchSize = 25): Promise<number> {
  if (!baseUrl || !token) throw new Error('CONNECT_BASE_URL and MIGRATION_TOKEN are required for import');
  let imported = 0;
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-migration-token': token };
    const response = await fetch(`${baseUrl}/api/admin/import`, { method: 'POST', headers, body: JSON.stringify({ kind, records: batch, batchId: `${kind}-${offset}`, copyMedia }) });
    if (!response.ok) throw new Error(`D1 ${kind} import failed at ${offset}: ${response.status} ${await response.text()}`);
    const result = await response.json() as { imported?: number };
    imported += Number(result.imported || 0);
    console.log(JSON.stringify({ kind, offset, received: batch.length, imported: result.imported || 0 }));
  }
  return imported;
}

const payload = await exportPublicData();
if (exportOnly) {
  const visibility = Object.fromEntries([...new Set(payload.posts.map((post) => String(post.visibility)))].sort().map((value) => [value, payload.posts.filter((post) => post.visibility === value).length]));
  console.log(JSON.stringify({ exportPath, profiles: payload.profiles.length, posts: payload.posts.length, comments: payload.comments.length, visibility, quotes: payload.posts.filter((post) => Boolean(post.quotedPostId)).length, threadMembers: payload.posts.filter((post) => Boolean(post.threadRootId)).length, nestedComments: payload.comments.filter((comment) => Boolean(comment.parentCommentId)).length }));
} else {
  const scoped = scopePayload(payload);
  const counts = {
    profiles: await importKind('profiles', scoped.profiles),
    posts: await importKind('posts', scoped.posts, 10),
    comments: await importKind('comments', scoped.comments, 25),
  };
  console.log(JSON.stringify({ exportPath, copyMedia, scope: { userIds: migrationUserIds.size, postIds: migrationPostIds.size, allowAllPublic }, counts }));
}
