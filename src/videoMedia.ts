type StoredMedia = {
  kind?: unknown;
  mimeType?: unknown;
  sourceType?: unknown;
  url?: unknown;
  storagePath?: unknown;
  objectKey?: unknown;
  storage_key?: unknown;
  key?: unknown;
  originalUrl?: unknown;
  thumbnailUrl?: unknown;
  previewUrl?: unknown;
  previewStoragePath?: unknown;
};

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Read the object key from a Firebase Storage download URL without its token. */
export function storagePathFromMediaURL(value: string): string {
  try {
    if (value.startsWith('/media/') && !value.startsWith('//')) {
      const path = value.split(/[?#]/, 1)[0].slice('/media/'.length);
      return decodePath(path);
    }
    const url = new URL(value);
    const objectMarker = url.pathname.indexOf('/o/');
    if (objectMarker >= 0) return decodePath(url.pathname.slice(objectMarker + 3));

    if (url.hostname.toLowerCase() === 'storage.googleapis.com') {
      const segments = url.pathname.split('/').filter(Boolean);
      return segments.length > 1 ? decodePath(segments.slice(1).join('/')) : '';
    }
  } catch {
    return '';
  }
  return '';
}

export type PostMediaKind = 'image' | 'video';

/** Old uid/file routes need the same post-scoped lookup as posts/uid/file routes. */
export function isProtectedPostMediaRoute(route: string): boolean {
  if (/^\/media\/(?:migration|posts)\//.test(route)) return true;
  const key = storagePathFromMediaURL(route);
  const [owner, ...path] = key.split('/');
  return route.startsWith('/media/') && !['profiles', 'legacy'].includes(owner)
    && /^[A-Za-z0-9_-]{1,160}$/.test(owner) && path.length > 0 && path[0] !== 'profiles'
    && path.every(part => Boolean(part) && part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part));
}

function mediaKind(item: StoredMedia, sourceURL: string): PostMediaKind | '' {
  const kind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
  const mime = typeof item.mimeType === 'string' ? item.mimeType : typeof item.sourceType === 'string' ? item.sourceType : '';
  if (kind === 'video' || kind === 'image') return kind;
  if (mime.toLowerCase().startsWith('video/')) return 'video';
  if (mime.toLowerCase().startsWith('image/')) return 'image';
  if (/\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(sourceURL)) return 'video';
  if (/\.(?:avif|jpe?g|png|gif|webp)(?:$|[?#])/i.test(sourceURL)) return 'image';
  return '';
}

function comparableURL(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, 'https://connect.invalid');
    return `${url.origin}${decodePath(url.pathname)}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function mediaURLFields(item: StoredMedia): string[] {
  return [item.url, item.thumbnailUrl, item.previewUrl, item.originalUrl]
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
}

function mediaStoragePaths(item: StoredMedia): string[] {
  return [item.storagePath, item.objectKey, item.storage_key, item.key, item.previewStoragePath]
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
}

function comparableStoragePath(value: string): string {
  const normalized = decodePath(value).replace(/\\/g, '/').split(/[?#]/, 1)[0];
  const parts = normalized.split('/');
  if (parts[0] !== 'posts' && !['migration', 'profiles', 'legacy'].includes(parts[0])) parts.unshift('posts');
  const filename = parts.pop() || '';
  const stem = filename
    .replace(/\.[^.]+$/, '')
    .replace(/(?:[_-](?:preview|thumbnail|thumb|small|medium|optimized))$/i, '');
  return [...parts, stem].join('/');
}

function mediaRoute(value: unknown): string {
  if (typeof value !== 'string') return '';
  const candidate = value.trim().split('#', 1)[0];
  return candidate.startsWith('/media/') && !candidate.startsWith('//') && !candidate.startsWith('/media/legacy/') ? candidate : '';
}

function isAnimatedGif(item: StoredMedia, sourceURL: string): boolean {
  const mime = typeof item.mimeType === 'string' ? item.mimeType : typeof item.sourceType === 'string' ? item.sourceType : '';
  return mime.split(';', 1)[0].trim().toLowerCase() === 'image/gif'
    || /\.gif(?:$|[?#])/i.test(sourceURL)
    || (typeof item.url === 'string' && /\.gif(?:$|[?#])/i.test(item.url));
}

function preferredMediaRoute(item: StoredMedia, kind: PostMediaKind, sourceURL: string): string {
  if (kind === 'image' && isAnimatedGif(item, sourceURL)) {
    const original = safeCanonicalRoute(item.url) || safeCanonicalRoute(item.originalUrl);
    if (original) return original;
  }
  const fields = kind === 'image' ? [item.thumbnailUrl, item.previewUrl, item.url] : [item.url, item.previewUrl];
  const routes = fields.map(mediaRoute).filter(Boolean);
  // An old Firebase preview can be stale even when the original was migrated.
  // Prefer a Worker media route over a leftover external preview URL.
  return routes[0] || (fields.find((value): value is string => typeof value === 'string' && Boolean(value)) || '');
}

function safeCanonicalRoute(value: unknown): string {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!candidate.startsWith('/media/') || candidate.startsWith('//') || candidate.startsWith('/media/legacy/')) return '';
  return candidate;
}

/** Match a stale Firebase URL to the exact migrated object recorded for the post. */
export function canonicalVideoURLFromPostMedia(media: unknown, sourceURL: string): string {
  return canonicalPostMediaURLFromPostMedia(media, sourceURL, 'video');
}

/** Resolve an old Firebase or unsigned Worker URL to the post's current media route. */
export function canonicalPostMediaURLFromPostMedia(media: unknown, sourceURL: string, kind: PostMediaKind, index = 0): string {
  if (!Array.isArray(media)) return '';
  const records = media.map((entry): StoredMedia => typeof entry === 'string' ? { url: entry } : (entry && typeof entry === 'object' ? entry as StoredMedia : {}));
  const candidates = records.filter(item => mediaKind(item, sourceURL) === kind);
  if (!candidates.length) return '';

  const sourceComparable = comparableURL(sourceURL);
  const sourcePath = storagePathFromMediaURL(sourceURL);
  const exact = candidates.find(item => mediaURLFields(item).some(value => comparableURL(value) === sourceComparable));
  const byStoragePath = sourcePath
    ? candidates.find(item => mediaStoragePaths(item).some(value => decodePath(value) === sourcePath))
    : undefined;
  const sourceStorageIdentity = sourcePath ? comparableStoragePath(sourcePath) : '';
  const relatedStorageMatches = sourceStorageIdentity
    ? candidates.filter(item => mediaStoragePaths(item).some(value => comparableStoragePath(value) === sourceStorageIdentity))
    : [];
  const byRelatedStoragePath = relatedStorageMatches.length === 1 ? relatedStorageMatches[0] : undefined;
  const hasConflictingIdentity = candidates.some(item => mediaStoragePaths(item).length > 0 || typeof item.originalUrl === 'string');
  const matching = exact || byStoragePath
    || byRelatedStoragePath
    || (sourceURL.startsWith('/media/legacy/') && candidates.length === 1 ? candidates[0] : undefined)
    || (!hasConflictingIdentity ? candidates[index] : undefined);
  if (!matching) return '';

  const selected = preferredMediaRoute(matching, kind, sourceURL);
  if (selected) return safeCanonicalRoute(selected);
  if (sourceURL.startsWith('/media/legacy/')) {
    if (candidates.length === 1) return safeCanonicalRoute(candidates[0].url);
  }
  return '';
}

export function postMediaHasStoragePath(media: unknown, sourceURL: string): boolean {
  if (!Array.isArray(media)) return false;
  const sourcePath = storagePathFromMediaURL(sourceURL);
  const hasExactKey = sourcePath && media.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as StoredMedia;
    if (mediaKind(item, sourceURL) !== 'video') return false;
    return mediaStoragePaths(item).some(value => decodePath(value) === sourcePath);
  });
  if (hasExactKey) return true;
  if (sourceURL.startsWith('/media/legacy/')) {
    return media.filter((entry) => entry && typeof entry === 'object' && mediaKind(entry as StoredMedia, sourceURL) === 'video').length === 1;
  }
  return false;
}

