import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.env.CONNECT_BASE_URL || '').replace(/\/$/, '');
const token = process.env.MIGRATION_TOKEN || '';
if (!baseUrl || !token) throw new Error('CONNECT_BASE_URL and MIGRATION_TOKEN are required');
const exportPath = resolve(process.env.MIGRATION_EXPORT_PATH || 'migration/firestore-public-export.json');
const migrationUserIds = new Set((process.env.MIGRATION_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const migrationPostIds = new Set((process.env.MIGRATION_POST_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
if (!migrationUserIds.size && !migrationPostIds.size) throw new Error('MIGRATION_USER_IDS or MIGRATION_POST_IDS is required for scoped verification');
const exported = JSON.parse(await readFile(exportPath, 'utf8')) as { profiles: Array<Record<string, unknown>>; posts: Array<Record<string, unknown>>; comments: Array<Record<string, unknown>> };
const postsById = new Map(exported.posts.map((post) => [String(post.id), post]));
const selectedPostIds = new Set(exported.posts.filter((post) => migrationUserIds.has(String(post.authorId)) || migrationPostIds.has(String(post.id))).map((post) => String(post.id)));
const pending = [...selectedPostIds];
while (pending.length) {
  const post = postsById.get(pending.pop() || '');
  const quoted = typeof post?.quotedPostId === 'string' ? post.quotedPostId : '';
  if (quoted && postsById.has(quoted) && !selectedPostIds.has(quoted)) { selectedPostIds.add(quoted); pending.push(quoted); }
}
const comments = exported.comments.filter((comment) => selectedPostIds.has(String(comment.postId)));
const profileIds = new Set([
  ...exported.posts.filter((post) => selectedPostIds.has(String(post.id))).map((post) => String(post.authorId)),
  ...comments.map((comment) => String(comment.authorId)),
]);
const expected = {
  profiles: exported.profiles.filter((profile) => profileIds.has(String(profile.id))).map((profile) => String(profile.id)),
  posts: [...selectedPostIds],
  comments: comments.map((comment) => String(comment.id)),
};

const headers: Record<string, string> = { 'content-type': 'application/json', 'x-migration-token': token };
const response = await fetch(`${baseUrl}/api/admin/integrity`, { method: 'POST', headers, body: JSON.stringify(expected) });
const body = await response.json().catch(() => ({}));
const output = { checkedAt: new Date().toISOString(), baseUrl, status: response.status, expectedCounts: Object.fromEntries(Object.entries(expected).map(([key, ids]) => [key, ids.length])), body };
const outputPath = resolve(process.env.INTEGRITY_OUTPUT_PATH || `docs/migration-integrity-${new Date().toISOString().slice(0, 10)}.json`);
await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
console.log(JSON.stringify({ outputPath, status: response.status, body }));
if (!response.ok || body?.pass !== true) process.exitCode = 1;
