import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

type MediaItem = { url?: unknown; [key: string]: unknown };
type Post = { id?: unknown; media?: unknown };
type MediaMap = { postId: string; index: number; url: string; type: string };

const baseUrl = (process.env.CONNECT_BASE_URL || '').replace(/\/$/, '');
const token = process.env.MIGRATION_TOKEN || '';
const exportPath = process.env.MIGRATION_EXPORT_PATH || 'migration/firestore-public-export.json';
const migrationUserIds = new Set((process.env.MIGRATION_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
const migrationPostIds = new Set((process.env.MIGRATION_POST_IDS || '').split(',').map((value) => value.trim()).filter(Boolean));
if (!baseUrl || !token) throw new Error('CONNECT_BASE_URL and MIGRATION_TOKEN are required');
if (!migrationUserIds.size && !migrationPostIds.size) throw new Error('MIGRATION_USER_IDS or MIGRATION_POST_IDS is required; bulk media migration is intentionally disabled');

const authHeaders: Record<string, string> = { 'x-migration-token': token };

const payload = JSON.parse(await readFile(exportPath, 'utf8')) as { posts?: Array<Post & { authorId?: unknown; quotedPostId?: unknown }> };
const posts = payload.posts || [];
const postsById = new Map(posts.map((post) => [String(post.id || ''), post]));
const selectedPostIds = new Set(posts.filter((post) => migrationUserIds.has(String(post.authorId || '')) || migrationPostIds.has(String(post.id || ''))).map((post) => String(post.id)));
const pending = [...selectedPostIds];
while (pending.length) {
  const post = postsById.get(pending.pop() || '');
  const quoted = typeof post?.quotedPostId === 'string' ? post.quotedPostId : '';
  if (quoted && postsById.has(quoted) && !selectedPostIds.has(quoted)) { selectedPostIds.add(quoted); pending.push(quoted); }
}
const candidates: Array<{ postId: string; index: number; source: string }> = [];
for (const post of posts.filter((item) => selectedPostIds.has(String(item.id || '')))) {
  const postId = typeof post.id === 'string' ? post.id : '';
  const media = Array.isArray(post.media) ? post.media : [];
  for (let index = 0; index < media.length; index += 1) {
    const item = typeof media[index] === 'string' ? { url: media[index] } : media[index] as MediaItem;
    const source = typeof item?.url === 'string' ? item.url : '';
    if (postId && /^https?:\/\//i.test(source)) candidates.push({ postId, index, source });
  }
}

async function optimize(candidate: { postId: string; index: number; source: string }): Promise<MediaMap | null> {
  const response = await fetch(candidate.source, { redirect: 'follow' });
  const type = (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (!response.ok || !type.startsWith('image/') || contentLength > 5_000_000) return null;
  const input = Buffer.from(await response.arrayBuffer());
  if (input.byteLength > 5_000_000) return null;
  const output = await sharp(input)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();
  const key = `migration/${candidate.postId}/${candidate.index}.webp`;
  const uploaded = await fetch(`${baseUrl}/api/admin/media/${key}`, {
    method: 'PUT',
    headers: { ...authHeaders, 'content-type': 'image/webp', 'content-length': String(output.byteLength) },
    body: output,
  });
  if (!uploaded.ok) throw new Error(`R2 upload failed: ${uploaded.status} ${await uploaded.text()}`);
  return { postId: candidate.postId, index: candidate.index, url: `/media/${key}`, type: 'image/webp' };
}

const optimized: MediaMap[] = [];
for (const candidate of candidates) {
  try {
    const result = await optimize(candidate);
    if (result) optimized.push(result);
  } catch (error) {
    console.warn(JSON.stringify({ kind: 'media-optimize-failed', postId: candidate.postId, index: candidate.index, error: error instanceof Error ? error.message : String(error) }));
  }
}

let mapped = 0;
for (let offset = 0; offset < optimized.length; offset += 50) {
  const batch = optimized.slice(offset, offset + 50);
  const response = await fetch(`${baseUrl}/api/admin/import`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'media-map', records: batch, batchId: `media-map-${offset}` }),
  });
  if (!response.ok) throw new Error(`D1 media map failed: ${response.status} ${await response.text()}`);
  const result = await response.json() as { imported?: number };
  mapped += Number(result.imported || 0);
}

console.log(JSON.stringify({ candidates: candidates.length, optimized: optimized.length, mapped }));
