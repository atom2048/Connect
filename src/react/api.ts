export type Profile = {
  id: string;
  displayName: string;
  username: string;
  email?: string | null;
  bio?: string;
  avatarUrl?: string | null;
  avatarColor?: string;
  counts?: Record<string, number>;
  /** True only when a post's owner profile no longer exists. */
  isUnavailable?: boolean;
};

export type PollOption = {
  text?: string;
  /** The API returns a count. Legacy/preview data may still contain user IDs. */
  votes?: number | string[];
  selected?: boolean;
};

export type PostPoll = {
  question?: string;
  options?: PollOption[] | Record<string, PollOption>;
  totalVotes?: number;
  expiresAt?: number | string | null;
  votedOptionIndex?: number | null;
};

export type Post = {
  id: string;
  authorId: string;
  author: Profile;
  body: string;
  visibility: string;
  media?: Array<{ url?: string; type?: string; alt?: string }>;
  counts: { likes: number; comments: number; shares: number };
  liked?: boolean;
  bookmarked?: boolean;
  poll?: PostPoll | null;
  createdAt: number;
  contentType?: string | null;
  contentKind?: string | null;
  isSponsored?: boolean;
  sponsored?: boolean;
  isAd?: boolean;
};

export type Viewer = { id: string; name: string; email: string; image?: string | null };

export type AskAiResponse = {
  answer: string;
  insufficientContext: boolean;
  insufficientReason?: 'MEDIA_NOT_AVAILABLE' | 'MEDIA_ANALYSIS_NOT_ALLOWED' | 'UNSUPPORTED_MEDIA';
  citations: Array<{ ref: string; type: 'profile' | 'post' | 'comment'; id: string; relation: 'current' | 'reply_parent' | 'quote' | 'thread' | 'reply' }>;
  coverage: { modalityRequested: 'text' | 'vision'; modalityUsed: 'text' | 'vision'; imagesTotal: number; imagesAnalyzed: number; animatedImagesTruncated: number; videosTotal: number; videosAnalyzed: 0; unsupportedImages: number; contextTruncated: boolean; answerTruncated: boolean };
  degraded: boolean;
  degradedReason?: 'vision_unavailable' | 'capacity' | 'unsupported_media';
  requestId: string;
  feedbackToken?: string;
};

export type Bootstrap = { viewer: Viewer | null; profile: Profile | null; feed: Post[]; nextCursor: string | null; database: boolean };

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type ReactionMutationResponse = {
  postId: string;
  kind: 'like' | 'bookmark';
  active: boolean;
  liked: boolean;
  bookmarked: boolean;
  counts: { likes: number };
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const rawPayload = await response.text();
  let payload: { error?: unknown } = {};
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload) as { error?: unknown };
    } catch {
      if (response.ok) throw new ApiError('invalid_response', response.status);
    }
  }
  if (!response.ok) {
    const retryAfterHeader = response.headers.get('Retry-After');
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(0, retryAfterSeconds * 1000)
      : undefined;
    throw new ApiError(typeof payload?.error === 'string' ? payload.error : `request_failed_${response.status}`, response.status, retryAfterMs);
  }
  return payload as T;
}

/**
 * Hash routing is intentional for the SPA, but the generated URL is absolute
 * and contains the post ID so opening it directly always lands on the detail
 * page, including on a fresh browser session.
 */
export function postUrl(postId: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = `#/post/${encodeURIComponent(postId)}`;
  return url.toString();
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // A permission-rejected Clipboard API can still have a working legacy
      // copy path, especially in an embedded or non-secure browsing context.
    }
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.inset = '0 auto auto 0';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error('clipboard_unavailable');
}

export async function copyPostUrl(postId: string): Promise<void> {
  await copyText(postUrl(postId));
}

export async function sharePost(post: Pick<Post, 'id' | 'body'>): Promise<'shared' | 'copied' | 'cancelled'> {
  const url = postUrl(post.id);
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Connectの投稿', text: post.body.slice(0, 120), url });
      return 'shared';
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return 'cancelled';
      // A share sheet can be present but unavailable in the current browsing
      // context. Preserve the user's intent with the clipboard fallback.
    }
  }
  await copyText(url);
  return 'copied';
}

export const formatTime = (timestamp: number) => {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return 'いま';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}分前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}時間前`;
  return new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' }).format(timestamp);
};

export const initials = (profile: Pick<Profile, 'displayName'>) => profile.displayName.trim().slice(0, 1) || 'C';

export const fallbackPosts: Post[] = [
  { id: 'preview-1', authorId: 'preview-connect', author: { id: 'preview-connect', displayName: 'Connect team', username: 'connect', avatarColor: '#4f46e5' }, body: '見つけやすく、読みやすく、迷わずつながれるConnectへ。', visibility: 'public', counts: { likes: 12, comments: 2, shares: 1 }, createdAt: Date.now() - 60_000 },
  { id: 'preview-2', authorId: 'preview-user', author: { id: 'preview-user', displayName: 'たいようさん', username: 'Taiyoh_pua', avatarColor: '#0f766e' }, body: '今日は新宿のカフェで作業。静かな場所を見つけると、集中が続く。', visibility: 'public', counts: { likes: 8, comments: 1, shares: 0 }, createdAt: Date.now() - 7_200_000 },
];
