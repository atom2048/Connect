import {
  canonicalPostMediaURLFromPostMedia,
  isProtectedPostMediaRoute,
  postMediaHasStoragePath,
  storagePathFromMediaURL,
  type PostMediaKind,
} from './videoMedia.ts';

export type PostMediaProjection = { status: number; media: unknown };

function currentOriginMediaRoute(candidate: string): string {
  if (candidate.startsWith('/media/') && !candidate.startsWith('//') && !candidate.startsWith('/media/legacy/')) return candidate;
  try {
    const url = new URL(candidate, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/media/') && !url.pathname.startsWith('/media/legacy/')
      ? url.pathname + url.search
      : '';
  } catch {
    return '';
  }
}

/**
 * Resolve stored Firebase or old media aliases against the post-scoped Worker
 * projection, while allowing callers to supply the authenticated API lookup.
 */
export async function resolvePostMediaURLFromProjection(
  postId: string,
  sourceURL: string,
  kind: PostMediaKind,
  index: number,
  lookup: () => Promise<PostMediaProjection>,
): Promise<string> {
  const directRoute = currentOriginMediaRoute(sourceURL);
  if (directRoute && (!isProtectedPostMediaRoute(directRoute) || new URL(directRoute, window.location.origin).searchParams.has('ticket'))) return directRoute;

  const storagePath = storagePathFromMediaURL(sourceURL);
  const obsoleteMediaRoute = sourceURL.startsWith('/media/legacy/');
  if (!postId || (!storagePath && !obsoleteMediaRoute && !isProtectedPostMediaRoute(directRoute))) return sourceURL;

  const { status, media } = await lookup();
  if (status === 404) return sourceURL;
  const canonicalURL = canonicalPostMediaURLFromPostMedia(media, sourceURL, kind, index);
  if (canonicalURL) return canonicalURL;
  if (kind === 'video' && postMediaHasStoragePath(media, sourceURL)) throw new Error('post_media_object_unavailable');
  // New Firestore-first posts may not have been mirrored into D1 yet. Their
  // freshly issued Firebase download URL remains the active source until the
  // Worker read-through can provide its post-scoped route.
  return sourceURL;
}
