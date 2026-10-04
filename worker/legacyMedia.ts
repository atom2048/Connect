import type { Env } from './types';

/** One post namespace for both upload generations; never infer an owner from metadata. */
export function canonicalPostMediaKey(key: string, authorId?: string): string | null {
  const parts = key.split('/');
  const namespaced = parts[0] === 'posts';
  if (!namespaced && ['migration', 'profiles', 'legacy'].includes(parts[0])) return null;
  const owner = parts[namespaced ? 1 : 0];
  const path = parts.slice(namespaced ? 2 : 1);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(owner || '') || (authorId && owner !== authorId)) return null;
  if (!path.length || path[0] === 'profiles' || !path.every(p => Boolean(p) && p !== '.' && p !== '..' && /^[A-Za-z0-9_.-]+$/.test(p))) return null;
  return `posts/${owner}/${path.join('/')}`;
}

export function postMediaObjectKeys(key: string): string[] {
  const canonical = canonicalPostMediaKey(key);
  return canonical ? [canonical, canonical.slice('posts/'.length)] : [key];
}

function sourceKey(value: string, projectId: string, authorId: string): string | null {
  try {
    if (value.startsWith('/media/') && !value.startsWith('//')) {
      return canonicalPostMediaKey(decodeURIComponent(new URL(value, 'https://connect.invalid').pathname.slice(7)), authorId);
    }
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const buckets = [`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`];
    if (url.hostname === 'firebasestorage.googleapis.com') {
      const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      return match && buckets.includes(match[1]) ? canonicalPostMediaKey(decodeURIComponent(match[2]), authorId) : null;
    }
    if (url.hostname === 'storage.googleapis.com') {
      const [bucket, ...path] = url.pathname.slice(1).split('/');
      return buckets.includes(bucket) ? canonicalPostMediaKey(decodeURIComponent(path.join('/')), authorId) : null;
    }
  } catch { /* Malformed/foreign URLs cannot select an R2 object. */ }
  return null;
}

/** Resolve only exact, owner-checked objects. No filename/index guesses or public ACL bypass. */
export async function resolveLegacyMediaObjects(env: Env, authorId: string, items: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  if (!env.MEDIA || !env.FIREBASE_PROJECT_ID) return items;
  return Promise.all(items.map(async item => {
    if (typeof item.url !== 'string') return item;
    if (item.url.startsWith('/media/posts/') && canonicalPostMediaKey(item.url.slice(7).split(/[?#]/, 1)[0], authorId)) return item;
    const key = sourceKey(item.url, env.FIREBASE_PROJECT_ID!, authorId);
    if (!key) return item;
    let metadata: R2Object | null = null;
    for (const candidate of postMediaObjectKeys(key)) {
      metadata = await env.MEDIA!.head(candidate);
      if (metadata) break;
    }
    if (!metadata) return item;
    const resolved: Record<string, unknown> = {
      ...item, url: `/media/${key}`, storagePath: key, objectKey: key,
      originalUrl: item.originalUrl || item.url,
      mimeType: metadata.httpMetadata?.contentType || item.mimeType,
      bytes: metadata.size,
    };
    for (const field of ['previewUrl', 'thumbnailUrl'] as const) {
      if (typeof item[field] !== 'string' || !item[field]) continue;
      const previewKey = sourceKey(item[field], env.FIREBASE_PROJECT_ID!, authorId);
      let found = false;
      if (previewKey) for (const candidate of postMediaObjectKeys(previewKey)) {
        if (await env.MEDIA!.head(candidate)) { found = true; break; }
      }
      if (previewKey && found) {
        resolved[field] = `/media/${previewKey}`;
        if (field === 'previewUrl') resolved.previewStoragePath = previewKey;
      } else {
        // A stale external preview must not override the verified original.
        delete resolved[field];
        if (field === 'previewUrl') delete resolved.previewStoragePath;
      }
    }
    return resolved;
  }));
}
