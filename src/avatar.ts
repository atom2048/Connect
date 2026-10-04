export interface AvatarSourceProfile {
  photoURL?: unknown;
  photoUrl?: unknown;
  avatarUrl?: unknown;
  avatarURL?: unknown;
  iconUrl?: unknown;
  iconURL?: unknown;
  profilePhotoPreviewURL?: unknown;
  profileImage?: unknown;
  avatar?: unknown;
  avatar_url?: unknown;
  image?: unknown;
  imageUrl?: unknown;
  image_url?: unknown;
  photo?: unknown;
  photo_url?: unknown;
  profile_image?: unknown;
  picture?: unknown;
}

const avatarFields: (keyof AvatarSourceProfile)[] = [
  // Worker profile projections use avatarUrl; Firestore and older snapshots
  // use the remaining names. Keep the shared resolver aware of every form.
  'photoURL', 'photoUrl', 'avatarUrl', 'avatarURL', 'profilePhotoPreviewURL', 'profileImage', 'iconUrl', 'iconURL',
  'avatar', 'avatar_url', 'image', 'imageUrl', 'image_url', 'photo', 'photo_url', 'profile_image', 'picture',
];

export function hasConfiguredAvatarImage(profile: AvatarSourceProfile | null | undefined): boolean {
  return Boolean(resolveAvatarURL(profile));
}

function safeAvatarCandidate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!candidate) return '';

  // `/media/legacy` is an obsolete route. Migrated objects live below the
  // Worker-owned `/media/migration/legacy` prefix.
  if (candidate === '/media/legacy' || candidate.startsWith('/media/legacy/') || candidate.startsWith('//')) return '';
  if (candidate.startsWith('/')) return candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.pathname === '/media/legacy' || url.pathname.startsWith('/media/legacy/')) return '';
    return candidate;
  } catch {
    return '';
  }
}

function isWorkerMediaCandidate(value: string): boolean {
  if (value.startsWith('/media/')) return value !== '/media/legacy' && !value.startsWith('/media/legacy/');
  try {
    const url = new URL(value);
    return url.pathname.startsWith('/media/') && url.pathname !== '/media/legacy' && !url.pathname.startsWith('/media/legacy/');
  } catch {
    return false;
  }
}

export function resolveAvatarURL(profile: AvatarSourceProfile | null | undefined): string {
  if (!profile) return '';
  const candidates = avatarFields.map((field) => profile[field])
    .map(safeAvatarCandidate)
    .filter(Boolean);
  // Prefer the current Worker/R2 route even if an older Firebase URL is also
  // present. Firebase download URLs remain a last-resort candidate; the image
  // element's error handler decides whether that URL is still usable.
  return candidates.find(isWorkerMediaCandidate) || candidates[0] || '';
}

export function mergeLatestDisplayProfile<T extends AvatarSourceProfile>(
  stored: T | null | undefined,
  latest: Partial<T> | null | undefined,
): T | null {
  if (!stored && !latest) return null;
  const merged = { ...(stored || {}), ...(latest || {}) } as T;
  const candidates = [resolveAvatarURL(latest), resolveAvatarURL(stored), resolveAvatarURL(merged)].filter(Boolean);
  const photoURL = candidates.find(isWorkerMediaCandidate) || candidates[0] || '';
  return {
    ...merged,
    photoURL,
    avatarUrl: photoURL,
    profilePhotoPreviewURL: safeAvatarCandidate(merged.profilePhotoPreviewURL),
    profileImage: safeAvatarCandidate(merged.profileImage),
  } as T;
}
