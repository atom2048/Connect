import { getState, setState } from '../state.ts';
import { escapeHtml, formatTime, formatRelativeTime, getFirebaseErrorMessage, isIndexError, getFirestoreIndexUrl, normalizeProfileBio } from '../utils.ts';
import { t } from '../i18n.ts';
import { APP_ICON_PATH } from '../config.ts';
import { getPostContentKind } from '../contentKinds.ts';
import { resolveAvatarURL } from '../avatar.ts';
import { COMMENT_ATTACHMENT_LIMIT_BYTES, createPostMediaStoragePath, resolveAttachmentMimeType, sniffAttachmentMimeType } from '../attachments.ts';
import {
  loginWithEmail, registerWithEmail,
  sendResetPasswordEmail, verifyResetPasswordCode, confirmResetPassword,
  logout,
} from '../auth.ts';
import {
  getUserProfile, getDisplayUserProfile, getDisplayUserProfilesByIds, prefetchPostVideoURL, prefetchPostMediaURL, getPostViewerStates, enrichCommentRecords, updateUserProfile, createUserProfile,
  getFeedPosts, getUserPosts, getPostById, createPost, createQuotePost, updatePost, deletePost,
  toggleLike, hasLiked, getComments, getCommentsPage, addComment, deleteComment,
  searchUsers, getAllUsers,
  getUserFriends, getUserFriendIds, getUserFriendCount, sendFriendRequest, acceptFriendRequest,
  removeFriend, getFriendshipStatus, getPendingRequests,
  getNotifications, getUnreadNotificationCount,
  markNotificationRead, markAllNotificationsRead,
  createNotification,
  getTrendingPosts,
  votePoll, uploadFile, uploadAttachmentFile,
  toggleRepost, getRepostedPostIds, getUserComments, getUserPostCount,
  toggleCommentLike, updateComment,
  getFollowers, getFollowing, areMutualFriends,
  createFriendQrToken, verifyFriendQrPayload, createMutualFriendship,
  createStory, deleteStory, getHomeStoryGroups, getUserStoryGroup, markStoryViewed, reactToStory, voteStoryPoll, STORY_REACTIONS,
  recordPostView, recordPostProfileClick, getLikes, getUserLikedPosts, toggleBookmark, hasBookmarked, getUserBookmarks,
} from '../db.ts';
import {
  renderPostCard, renderComment,
  renderNotification, renderCreatePostForm,
  renderLoadingSpinner, renderEmptyState,
  renderLoadMoreButton, renderModal, createAvatarHTML,
  renderPoll, linkifyHashtags, renderExpandablePostText, renderUserListItem,
} from '../components.ts';
import { auth, db } from '../firebase.ts';
import { bindVideoLongPress } from '../videoLongPress.ts';
import { armModalClickShield, isBackdropDismiss } from '../modalInteractions.ts';
import { doc, getDoc, collection, updateDoc, serverTimestamp } from 'firebase/firestore';
import type { DocumentSnapshot } from 'firebase/firestore';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import type { Attachment, AuthUser, Comment, Poll, Post, Story, TimestampLike, UserProfile, Visibility } from '../types/domain.ts';
import { getPostAiConsent, setPostAiConsent, setupAskAiButtons } from '../askAi.ts';
import type { InitialLoadProgress } from '../initialLoadProgress.ts';
import { waitForInitialLoadDebugStep } from '../initialLoadDebug.ts';
import { classifyStartupError, retryWithBackoff, withTimeout } from '../startupResilience.ts';
import { getActiveStartupTraceSession } from '../startupTrace.ts';


type AppDomElement = HTMLElement & HTMLButtonElement & HTMLInputElement & HTMLTextAreaElement & HTMLImageElement & HTMLVideoElement;
type ToastType = 'info' | 'success' | 'error' | 'warning';
type ToastAction = { label: string; onClick?: () => void } | null;
type MentionRange = { query: string; start: number; end: number };
type RenderProfile = Parameters<typeof createAvatarHTML>[0];
type RenderPostInput = Parameters<typeof renderPostCard>[0];
type RenderCommentInput = Parameters<typeof renderComment>[0];
type MentionUser = { uid: string; username: string; displayName: string; photoURL?: string; avatarColor?: string };
type StoryPollOptionView = { text?: string; votes?: string[] | number };
type StoryPollView = { question?: string; options?: StoryPollOptionView[]; totalVotes?: number; expiresAt?: unknown };
type ClipboardEventLike = { clipboardData?: DataTransfer | null; preventDefault: () => void };
type PostPollDraft = { question: string; options: Array<{ text: string }>; expiresAt?: Date | string | number | null };
type PostDraft = {
  id?: string;
  text?: string;
  visibility?: Visibility | string;
  contentType?: 'user' | 'news' | 'advertisement' | 'system';
  scheduledAt?: string;
  quotedPostId?: string;
  imageNames?: string[];
  videoName?: string;
  gifUrls?: string[];
  threadTexts?: string[];
  poll?: unknown;
  updatedAt?: number;
};
type StoryBgmPreset = {
  id: string;
  title: string;
  mood: string;
  bpm: number;
  style: string;
  bass: number[];
  chords: number[][];
  lead: number[];
  drum: string;
};
type StoryBgmPlayer = {
  ctx: AudioContext;
  master: GainNode;
  nodes: Array<AudioScheduledSourceNode | AudioNode>;
  timer: ReturnType<typeof setInterval>;
};
type StoryView = Record<string, unknown> & {
  id?: string;
  authorId?: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: string;
  viewedByMe?: boolean;
  createdAt?: unknown;
  expiresAt?: unknown;
  audioPresetId?: string;
  audioTitle?: string;
  audioUrl?: string;
  muteVideo?: boolean;
  overlayText?: string;
  background?: string;
  poll?: unknown;
  options?: Array<{ text: string; votes?: number | string[] }>;
};
type StoryGroupView = Record<string, unknown> & {
  authorId?: string;
  author?: unknown;
  profile?: unknown;
  stories: StoryView[];
  hasUnseen?: boolean;
};
type FeedPostViewModel = Record<string, unknown> & {
  id?: string;
  userId?: string;
  text?: string;
  imageURLs?: string[];
  videoURL?: string;
  likesCount?: number;
  commentsCount?: number;
  repostsCount?: number;
  poll?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  scheduledAt?: unknown;
  author?: unknown;
  liked?: boolean;
  bookmarked?: boolean;
  reposted?: boolean;
  quotedPost?: FeedPostViewModel | null;
};
type CommentViewModel = Record<string, unknown> & {
  id?: string;
  postId?: string;
  userId?: string;
  text?: string;
  createdAt?: unknown;
  author?: unknown;
  liked?: boolean;
  likesCount?: number;
  parentId?: string | null;
  authorDisplayName?: string;
  authorUsername?: string;
  authorPhotoURL?: string;
  authorAvatarColor?: string;
};
type FeedState = {
  posts: FeedPostViewModel[];
  loadedCount: number;
  cursor: DocumentSnapshot | null;
  loading: boolean;
  hasMore: boolean;
  feedContainer: HTMLElement | null;
  mode: string;
  renderedPostIds: Set<string>;
};
type ImageViewerCloseOptions = { fromHistory?: boolean };
type ImageViewerItem = { url: string; alt?: string; postId?: string; mediaIndex?: number; sourceButton?: AppDomElement };
type CreatePostPayload = {
  userId: string;
  contentType?: 'user' | 'news' | 'advertisement' | 'system';
  text: string;
  imageURLs: string[];
  imageAlts: string[];
  videoURL: string;
  attachments?: Attachment[];
  threadId: string;
  visibility: string;
  scheduledAt?: Date | string | null;
  poll?: Parameters<typeof createPost>[0]['poll'];
  quotedPostId?: string;
  threadIndex?: number;
  threadCount?: number;
};

declare global {
  interface Window {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  }
}

function getEl(id: string): AppDomElement | null {
  return document.getElementById(id) as AppDomElement | null;
}

function parseJsonValue(raw: string | null): unknown {
  try {
    return JSON.parse(raw || 'null') as unknown;
  } catch (_) {
    return null;
  }
}

function readStringArray(raw: string | null): string[] {
  const parsed = parseJsonValue(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

function readDraftArray(raw: string | null): PostDraft[] {
  const parsed = parseJsonValue(raw);
  return Array.isArray(parsed) ? parsed.filter((item): item is PostDraft => typeof item === 'object' && item !== null) : [];
}

function toTimestampLike(value: unknown): TimestampLike {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value == null) return null;
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    const candidate = value as { toDate?: () => Date };
    if (typeof candidate.toDate === 'function') return { toDate: candidate.toDate.bind(value) };
  }
  return null;
}

function toUserProfile(profile: UserProfile | null | undefined): UserProfile | null {
  return profile || null;
}
function toRenderProfile(profile: unknown): RenderProfile | null {
  if (!profile || typeof profile !== 'object') return null;
  const maybe = profile as {
    uid?: unknown;
    id?: unknown;
    displayName?: unknown;
    username?: unknown;
    photoURL?: unknown;
    profileImage?: unknown;
    profilePhotoPreviewURL?: unknown;
    avatarColor?: unknown;
  };
  const uid = typeof maybe.uid === 'string' ? maybe.uid : (typeof maybe.id === 'string' ? maybe.id : '');
  const profileImage = typeof maybe.profileImage === 'string' ? maybe.profileImage : '';
  const profilePhotoPreviewURL = typeof maybe.profilePhotoPreviewURL === 'string' ? maybe.profilePhotoPreviewURL : '';
  const photoURL = typeof maybe.photoURL === 'string' && maybe.photoURL ? maybe.photoURL : profileImage;
  return {
    ...profile,
    uid,
    displayName: typeof maybe.displayName === 'string' ? maybe.displayName : 'User',
    username: typeof maybe.username === 'string' ? maybe.username : '',
    photoURL,
    profileImage,
    profilePhotoPreviewURL,
    avatarColor: typeof maybe.avatarColor === 'string' ? maybe.avatarColor : '',
  } as RenderProfile;
}

function toRenderPost(post: FeedPostViewModel | Record<string, unknown>): RenderPostInput {
  return {
    ...post,
    id: String(post.id || ''),
    userId: String(post.userId || ''),
    createdAt: toTimestampLike(post.createdAt),
    updatedAt: toTimestampLike(post.updatedAt),
    scheduledAt: toTimestampLike(post.scheduledAt),
  } as unknown as RenderPostInput;
}

function toRenderComment(comment: CommentViewModel | Record<string, unknown>): RenderCommentInput {
  return {
    ...comment,
    id: String(comment.id || ''),
    postId: String(comment.postId || ''),
    userId: String(comment.userId || ''),
    text: String(comment.text || ''),
    createdAt: toTimestampLike(comment.createdAt),
  } as RenderCommentInput;
}

function closeModalById(id: string): void {
  getEl(id)?.remove();
}

async function refreshPostDetailPage(postId: string): Promise<void> {
  const module = await import('./explore.ts');
  await module.renderPostDetailPage({ id: postId });
}
const MB = 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 15 * MB;
const MAX_VIDEO_UPLOAD_BYTES = 3 * 1024 * MB;
const MAX_VIDEO_UPLOAD_SECONDS = 180;
const MAX_POST_IMAGE_COUNT = 20;
const MAX_COMMENT_UPLOAD_BYTES = COMMENT_ATTACHMENT_LIMIT_BYTES;
const MAX_OTHER_UPLOAD_BYTES = 10 * MB;
let homeStoryGroupsCache: StoryGroupView[] = [];

function getFileExtension(file: File): string {
  return (file.name.split('.').pop() || '').toLowerCase();
}

function isImageFile(file: File): boolean {
  const ext = getFileExtension(file);
  return resolveAttachmentMimeType(file).startsWith('image/') || ['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(ext);
}

function isVideoFile(file: File): boolean {
  const ext = getFileExtension(file);
  return resolveAttachmentMimeType(file).startsWith('video/') || ['3gp', 'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm'].includes(ext);
}

function isAudioFile(file: File): boolean {
  const ext = getFileExtension(file);
  return file.type.startsWith('audio/') || ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba'].includes(ext);
}

function isCommentAttachmentInput(inputEl: HTMLInputElement | null): boolean {
  return inputEl?.id === 'comment-file-input' || inputEl?.id === 'detail-comment-file';
}

function validateUploadFile(file: File | null | undefined, inputEl: HTMLInputElement | null = null): boolean {
  if (!file) return false;
  const isVideo = isVideoFile(file);
  const isImage = isImageFile(file);
  const isCommentFile = isCommentAttachmentInput(inputEl);
  const limit = isCommentFile ? MAX_COMMENT_UPLOAD_BYTES : (isVideo ? MAX_VIDEO_UPLOAD_BYTES : (isImage ? MAX_IMAGE_UPLOAD_BYTES : MAX_OTHER_UPLOAD_BYTES));
  if (file.size > limit) {
    const label = isVideo ? '動画' : (isImage ? '画像' : 'ファイル');
    const mb = Math.floor(limit / MB);
    alert(`${label}は${mb}MB以下にしてください`);
    if (inputEl) inputEl.value = '';
    return false;
  }
  return true;
}


function extractGifUrlsFromText(text = '') {
  const matches = String(text).match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return matches
    .map(url => url.replace(/[)、。.,]+$/g, ''))
    .filter(url => /\.gif(?:\?|#|$)/i.test(url) || /(?:tenor|giphy|gfycat|media\.discordapp|c.tenor)\./i.test(url));
}

function normalizeGifUrl(url = '') {
  const cleaned = String(url).trim().replace(/[)、。.,]+$/g, '');
  if (!/^https?:\/\//i.test(cleaned)) return '';
  return cleaned;
}

function feedAbortError(): Error {
  const error = new Error('Feed request is no longer active');
  error.name = 'AbortError';
  return error;
}

function throwIfFeedAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw feedAbortError();
}

async function enrichPosts(posts: FeedPostViewModel[], currentUserId = '', initialLoad?: InitialLoadProgress, initialLoadSessionId?: number, signal?: AbortSignal): Promise<FeedPostViewModel[]> {
  throwIfFeedAborted(signal);
  const run = initialLoadSessionId ?? initialLoad?.getSessionId();
  const report = (fraction: number, processedItems?: number, totalItems?: number): void => {
    if (!initialLoad || run === undefined) return;
    initialLoad.updateTaskFraction(
      'page-data',
      fraction,
      run,
      processedItems === undefined || totalItems === undefined ? undefined : { processedItems, totalItems },
    );
  };
  if (initialLoad && run !== undefined) {
    initialLoad.startTask('page-data', run);
    report(0);
  }
  const states = currentUserId
    ? await withTimeout(getPostViewerStates(posts.map(post => post.id), currentUserId), 1200, signal)
      .catch(() => ({ liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() }))
    : { liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() };
  throwIfFeedAborted(signal);
  report(0.25);
  // authorDisplayName/authorUsername/authorPhotoURL are legacy creation-time
  // snapshots. They must never win over the profile document when rendering.
  // Resolve every author ID freshly, including the author embedded in quotes.
  const authorIds = [...new Set(posts.flatMap(post => {
    const quote = post.quotedPost && typeof post.quotedPost === 'object'
      ? post.quotedPost as Record<string, unknown>
      : null;
    return [
      post.userId,
      typeof quote?.userId === 'string' ? quote.userId : '',
    ];
  }).filter(Boolean))];
  const profileMap = new Map<string, RenderProfile | null>();
  let processedAuthors = 0;
  await Promise.all(authorIds.map(async (uid) => {
    throwIfFeedAborted(signal);
    await waitForInitialLoadDebugStep();
    profileMap.set(uid, toRenderProfile(await withTimeout(getDisplayUserProfile(uid), 2500, signal).catch((): null => null)));
    throwIfFeedAborted(signal);
    processedAuthors += 1;
    report(0.25 + (authorIds.length ? 0.25 * processedAuthors / authorIds.length : 0));
  }));
  if (authorIds.length === 0) report(0.5);
  const enriched: FeedPostViewModel[] = [];
  for (const [index, post] of posts.entries()) {
    throwIfFeedAborted(signal);
    await waitForInitialLoadDebugStep();
    // Never fall back to creation-time profile fields. If the current profile
    // is unavailable, render the same neutral state for every post by uid.
    const author = profileMap.get(post.userId) ?? null;
    const quote = post.quotedPost && typeof post.quotedPost === 'object'
      ? post.quotedPost as Record<string, unknown>
      : null;
    const quoteUserId = typeof quote?.userId === 'string' ? quote.userId : '';
    const quoteAuthor = quoteUserId ? profileMap.get(quoteUserId) : null;
    const quotedPost = quote ? {
      ...quote,
      authorDisplayName: quoteAuthor?.displayName || '',
      authorUsername: quoteAuthor?.username || '',
      authorPhotoURL: quoteAuthor?.profilePhotoPreviewURL || quoteAuthor?.photoURL || quoteAuthor?.profileImage || '',
      authorAvatarColor: quoteAuthor?.avatarColor || '',
    } : null;
    report(0.5 + (posts.length ? 0.5 * (index + 1) / posts.length : 0), index + 1, posts.length);
    enriched.push({ ...post, author, quotedPost, liked: states.liked.has(post.id), bookmarked: states.bookmarked.has(post.id), reposted: states.reposted.has(post.id) });
  }
  if (posts.length === 0) report(1, 0, 0);
  return enriched;
}

// ============================================================
// ヘルパー: コメントにユーザー情報を付与
// ============================================================
async function enrichComments(comments: CommentViewModel[], currentUserId = ''): Promise<CommentViewModel[]> {
  const enriched = await enrichCommentRecords(comments, currentUserId);
  return enriched.map(comment => ({
    ...comment,
    id: String(comment.id || ''),
    postId: String(comment.postId || ''),
    userId: String(comment.userId || ''),
    text: String(comment.text || ''),
    likesCount: comment.likesCount,
    author: toRenderProfile(comment.author),
    liked: comment.liked,
  }));
}

function renderCommentThread(comments: CommentViewModel[]): string {
  if (!comments.length) return '';

  const childrenByParent: Map<string, CommentViewModel[]> = new Map();
  const topLevel: CommentViewModel[] = [];
  comments.forEach((comment: CommentViewModel) => {
    if (comment.parentId) {
      const replies = childrenByParent.get(comment.parentId) || [];
      replies.push(comment);
      childrenByParent.set(comment.parentId, replies);
    } else {
      topLevel.push(comment);
    }
  });

  const renderNode = (comment: CommentViewModel, depth = 0): string => {
    const replies = childrenByParent.get(comment.id) || [];
    return `
      <div class="comment-thread" style="--thread-depth:${depth}">
        ${renderComment(toRenderComment(comment), comment.author, comment.liked)}
        ${replies.length ? `<div class="comment-replies">${replies.map((reply: CommentViewModel) => renderNode(reply, depth + 1)).join('')}</div>` : ''}
      </div>
    `;
  };

  return topLevel.map(comment => renderNode(comment)).join('');
}

// ============================================================
// ログインページ
// ============================================================

let feedState: FeedState = {
  posts: [],
  loadedCount: 0,
  cursor: null,
  loading: false,
  hasMore: true,
  feedContainer: null,
  mode: 'recommended',
  renderedPostIds: new Set(),
};
let feedLoadGeneration = 0;
type PostReactionState = { liked: boolean; likesCount: number };
const postReactionState = new Map<string, PostReactionState>();

function postCardsFor(postId: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.post-card[data-post-id]'))
    .filter(card => card.dataset.postId === postId);
}

function applyPostLikeState(postId: string, liked: boolean, likesCount: number, syncing = false): void {
  if (!postId) return;
  const count = Math.max(0, Math.floor(Number(likesCount) || 0));
  postReactionState.set(postId, { liked, likesCount: count });
  postCardsFor(postId).forEach(card => {
    card.querySelectorAll<AppDomElement>('[data-action="like"]').forEach(btn => {
      btn.classList.toggle('liked', liked);
      btn.classList.toggle('is-syncing', syncing);
      btn.disabled = syncing;
      btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
      btn.setAttribute('aria-busy', syncing ? 'true' : 'false');
      btn.setAttribute('aria-label', syncing
        ? `${liked ? t('いいね済み') : t('いいね')} · ${t('同期中')}`
        : liked ? t('いいね済み') : t('いいね'));
      const icon = btn.querySelector<AppDomElement>('.action-icon');
      const label = btn.querySelector<AppDomElement>('.action-label');
      if (icon) icon.textContent = liked ? '❤️' : '🤍';
      if (label) label.textContent = liked ? t('いいね済み') : t('いいね');
    });
    card.querySelectorAll<AppDomElement>('.like-count').forEach(countEl => {
      countEl.textContent = String(count);
    });
  });
  feedState.posts.forEach(post => {
    if (post.id !== postId) return;
    post.liked = liked;
    post.likesCount = count;
  });
}

function buildPostDetailUrl(postId: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = `#/post/${encodeURIComponent(postId)}`;
  return url.toString();
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // Fall through to the compatibility path below.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

async function sharePostLink(postId: string): Promise<void> {
  if (!postId) return;
  const url = buildPostDetailUrl(postId);
  const share = typeof navigator.share === 'function' ? navigator.share.bind(navigator) : null;
  if (share) {
    try {
      await share({ title: t('Connectの投稿'), text: t('Connectの投稿'), url });
      showAppToast(t('共有シートを開きました'), 'success');
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // Some browsers expose navigator.share but reject the payload. Use the
      // clipboard fallback so the action still has a useful result.
    }
  }
  if (await copyTextToClipboard(url)) showAppToast(t('投稿リンクをコピーしました'), 'success');
  else showAppToast(t('投稿リンクをコピーできませんでした'), 'error');
}

const sessionRecordedPostViews = new Set<string>();
let postViewObserver: IntersectionObserver | null = null;

export function showAppToast(message: string, type: ToastType = 'info', action: ToastAction = null): void {
  const toast = document.createElement('div');
  toast.className = `app-toast app-toast-${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    ${action ? `<button class="app-toast-action">${escapeHtml(action.label)}</button>` : ''}
  `;
  if (action) {
    toast.querySelector<AppDomElement>('.app-toast-action')?.addEventListener('click', () => {
      action.onClick?.();
      toast.remove();
    });
  }
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), action ? 9000 : 3500);
}

function getSeenFeedPostIds(userId: string): string[] {
  try {
    return readStringArray(localStorage.getItem(`connect_seen_posts_${userId}`));
  } catch (e) {
    return [];
  }
}

function rememberSeenFeedPosts(userId: string, posts: FeedPostViewModel[]): void {
  try {
    const existing = getSeenFeedPostIds(userId);
    const ids = posts.map((p: FeedPostViewModel) => p.id).filter(Boolean);
    const merged = Array.from(new Set([...ids, ...existing])).slice(0, 300);
    localStorage.setItem(`connect_seen_posts_${userId}`, JSON.stringify(merged));
  } catch (e) {}
}

function parseMentionNames(text = ''): string[] {
  return Array.from(new Set((text.match(/(^|\s)@([A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff-]+)/g) || [])
    .map(v => v.replace(/^.*@/, '').toLowerCase())
    .filter(Boolean)));
}

export async function notifyMentions(text: string, fromUserId: string, postId: string, excludeIds: string[] = [], commentId = ''): Promise<void> {
  const mentionNames = parseMentionNames(text);
  if (mentionNames.length === 0) return;
  try {
    const users = await getAllUsers();
    const excluded = new Set([fromUserId, ...excludeIds]);
    for (const user of users) {
      const names = [user.username, user.displayName].filter(Boolean).map(v => String(v).toLowerCase());
      if (!excluded.has(user.uid) && names.some(name => mentionNames.includes(name))) {
        await createNotification({
          userId: user.uid,
          type: 'mention',
          fromUserId,
          postId,
          commentId: commentId || null,
          eventId: commentId ? `${commentId}_${user.uid}` : `${postId}_${user.uid}`,
          context: text.slice(0, 80),
        }).catch(() => {});
      }
    }
  } catch (e) {}
}

let mentionUserCache: MentionUser[] | null = null;
let mentionUserCacheAt = 0;
async function getMentionUsers(): Promise<MentionUser[]> {
  if (mentionUserCache && Date.now() - mentionUserCacheAt < 5 * 60 * 1000) return mentionUserCache;
  const users = await getAllUsers().catch((): UserProfile[] => []);
  mentionUserCache = users
    .filter((user: UserProfile) => user?.uid && (user.username || user.displayName))
    .map((user: UserProfile): MentionUser => ({
      uid: user.uid,
      username: String(user.username || '').replace(/^@/, ''),
      displayName: user.displayName || user.username || 'User',
      photoURL: user.photoURL || '',
      avatarColor: user.avatarColor || '',
    }));
  mentionUserCacheAt = Date.now();
  return mentionUserCache;
}

function getActiveMentionQuery(input: HTMLInputElement | HTMLTextAreaElement | null): MentionRange | null {
  const value = input?.value || '';
  const cursor = input?.selectionStart ?? value.length;
  const before = value.slice(0, cursor);
  const match = before.match(/(^|\s)@([A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff-]{0,24})$/);
  if (!match) return null;
  return { query: match[2].toLowerCase(), start: cursor - match[2].length - 1, end: cursor };
}

function insertMention(input: HTMLInputElement | HTMLTextAreaElement | null, username: string, range: MentionRange | null): void {
  if (!input || !username || !range) return;
  const value = input.value || '';
  const insert = `@${username.replace(/^@/, '')} `;
  input.value = value.slice(0, range.start) + insert + value.slice(range.end);
  const nextCursor = range.start + insert.length;
  input.focus();
  input.setSelectionRange?.(nextCursor, nextCursor);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setupMentionSuggest(input: AppDomElement | null): void {
  if (!input || input.dataset.mentionSuggestReady === 'true') return;
  input.dataset.mentionSuggestReady = 'true';
  const box = document.createElement('div');
  box.className = 'mention-suggest hidden';
  box.setAttribute('role', 'listbox');
  input.insertAdjacentElement('afterend', box);
  let activeRange: MentionRange | null = null;

  const close = () => {
    box.classList.add('hidden');
    box.innerHTML = '';
    activeRange = null;
  };

  const render = async () => {
    const active = getActiveMentionQuery(input);
    if (!active) return close();
    activeRange = active;
    const users = await getMentionUsers();
    if (activeRange !== active) return;
    const filtered = users
      .filter(user => {
        const username = user.username.toLowerCase();
        const displayName = String(user.displayName || '').toLowerCase();
        return !active.query || username.includes(active.query) || displayName.includes(active.query);
      })
      .slice(0, 6);
    if (!filtered.length) return close();
    box.innerHTML = filtered.map((user: MentionUser) => `
      <button class="mention-suggest-item" type="button" data-username="${escapeHtml(user.username)}" role="option">
        ${createAvatarHTML(user, 28)}
        <span><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span>
      </button>
    `).join('');
    box.classList.remove('hidden');
  };

  input.addEventListener('input', render);
  input.addEventListener('keyup', render);
  input.addEventListener('blur', () => setTimeout(close, 160));
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    const item = e.target instanceof Element ? e.target.closest<AppDomElement>('.mention-suggest-item') : null;
    if (!item || !activeRange) return;
    insertMention(input, item.dataset.username, activeRange);
    close();
  });
}

const POST_DRAFTS_KEY = 'connect_post_drafts_v1';

export function readPostDrafts(userId: string): PostDraft[] {
  try {
    return readDraftArray(localStorage.getItem(`${POST_DRAFTS_KEY}_${userId}`));
  } catch (_) {
    return [];
  }
}

function writePostDrafts(userId: string, drafts: PostDraft[]): void {
  try {
    localStorage.setItem(`${POST_DRAFTS_KEY}_${userId}`, JSON.stringify((drafts || []).slice(0, 30)));
  } catch (_) {}
}

function savePostDraft(userId: string, draft: PostDraft): PostDraft | null {
  if (!userId || !draft) return null;
  const drafts = readPostDrafts(userId);
  const id = draft.id || `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const next = {
    id,
    text: draft.text || '',
    visibility: draft.visibility || 'public',
    contentType: draft.contentType || 'user',
    scheduledAt: draft.scheduledAt || '',
    quotedPostId: draft.quotedPostId || '',
    imageNames: draft.imageNames || [],
    videoName: draft.videoName || '',
    updatedAt: Date.now(),
  };
  writePostDrafts(userId, [next, ...drafts.filter((item: PostDraft) => item.id !== id)]);
  return next;
}

export function deletePostDraft(userId: string, draftId: string): void {
  if (!userId || !draftId) return;
  writePostDrafts(userId, readPostDrafts(userId).filter((draft: PostDraft) => draft.id !== draftId));
}

function getDraftFromHash() {
  try {
    const query = window.location.hash.split('?')[1] || '';
    return new URLSearchParams(query).get('draft') || '';
  } catch (_) {
    return '';
  }
}

const STORY_BACKGROUNDS = [
  'linear-gradient(135deg, #4f46e5, #8b5cf6)',
  'linear-gradient(135deg, #0ea5e9, #6366f1)',
  'linear-gradient(135deg, #f97316, #ec4899)',
  'linear-gradient(135deg, #14b8a6, #22c55e)',
];
const STORY_BGM_PRESETS = [
  {
    id: 'epic-trailer',
    title: 'Epic Trailer',
    mood: '重厚・映画予告',
    bpm: 124,
    style: 'cinematic',
    bass: [43.65, 43.65, 51.91, 38.89, 46.25, 34.65],
    chords: [[87.31, 130.81, 196.0, 261.63], [103.83, 155.56, 233.08, 311.13], [77.78, 116.54, 174.61, 233.08], [92.5, 138.59, 207.65, 277.18], [69.3, 103.83, 155.56, 207.65], [98.0, 146.83, 220.0, 293.66]],
    lead: [392.0, 523.25, 587.33, 698.46, 783.99, 698.46, 587.33, 523.25],
    drum: 'trailer',
  },
  {
    id: 'taiko-impact',
    title: 'Taiko Impact',
    mood: '和太鼓・突進',
    bpm: 132,
    style: 'taiko',
    bass: [73.42, 73.42, 87.31, 65.41, 98.0, 87.31, 73.42],
    chords: [[146.83, 220.0, 293.66, 440.0], [174.61, 261.63, 349.23, 523.25], [130.81, 196.0, 261.63, 392.0], [196.0, 293.66, 392.0, 587.33]],
    lead: [293.66, 349.23, 440.0, 523.25, 440.0, 392.0, 349.23, 293.66],
    drum: 'taiko',
  },
  {
    id: 'hero-rise',
    title: 'Hero Rise',
    mood: '冒険・上昇',
    bpm: 118,
    style: 'heroic',
    bass: [65.41, 82.41, 98.0, 73.42, 87.31, 110.0],
    chords: [[130.81, 164.81, 196.0, 261.63], [164.81, 207.65, 246.94, 329.63], [196.0, 246.94, 293.66, 392.0], [146.83, 185.0, 220.0, 293.66], [174.61, 220.0, 261.63, 349.23], [220.0, 277.18, 329.63, 440.0]],
    lead: [523.25, 587.33, 659.25, 783.99, 880.0, 987.77, 880.0, 783.99],
    drum: 'march',
  },
  {
    id: 'dark-tension',
    title: 'Dark Tension',
    mood: '緊張・追跡',
    bpm: 116,
    style: 'dark',
    bass: [55.0, 58.27, 51.91, 61.74, 46.25, 55.0],
    chords: [[55.0, 82.41, 110.0, 164.81], [58.27, 87.31, 116.54, 174.61], [51.91, 77.78, 103.83, 155.56], [61.74, 92.5, 123.47, 185.0]],
    lead: [220.0, 233.08, 261.63, 311.13, 293.66, 261.63, 233.08],
    drum: 'pulse',
  },
  {
    id: 'emotional-climax',
    title: 'Emotional Climax',
    mood: '感動・高揚',
    bpm: 112,
    style: 'strings',
    bass: [65.41, 98.0, 82.41, 110.0, 73.42, 87.31],
    chords: [[130.81, 164.81, 196.0, 261.63], [196.0, 246.94, 293.66, 392.0], [164.81, 207.65, 246.94, 329.63], [220.0, 277.18, 329.63, 440.0], [146.83, 185.0, 220.0, 293.66], [174.61, 220.0, 261.63, 349.23]],
    lead: [392.0, 493.88, 523.25, 659.25, 783.99, 659.25, 587.33, 523.25],
    drum: 'slow-build',
  },
  {
    id: 'victory-fanfare',
    title: 'Victory Fanfare',
    mood: '勝利・祝祭',
    bpm: 140,
    style: 'fanfare',
    bass: [98.0, 130.81, 146.83, 196.0, 174.61, 220.0],
    chords: [[196.0, 246.94, 293.66, 392.0], [261.63, 329.63, 392.0, 523.25], [293.66, 369.99, 440.0, 587.33], [220.0, 277.18, 329.63, 440.0], [349.23, 440.0, 523.25, 698.46], [392.0, 493.88, 587.33, 783.99]],
    lead: [587.33, 783.99, 880.0, 987.77, 1174.66, 987.77, 880.0, 783.99],
    drum: 'fanfare',
  },
];
const MAX_STORY_TEXT = 280;
const MAX_STORY_IMAGE_BYTES = 8 * MB;
const MAX_STORY_VIDEO_BYTES = 100 * MB;
const MAX_STORY_AUDIO_BYTES = 15 * MB;
const MAX_STORY_VIDEO_SECONDS = 60;
const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const FEED_DOM_SOFT_LIMIT = 100;
let storyBgmPlayer: StoryBgmPlayer | null = null;

function validateStoryFile(file: File | null | undefined): boolean {
  if (!file) return true;
  const mimeType = resolveAttachmentMimeType(file);
  const isImage = mimeType.startsWith('image/');
  const isVideo = mimeType.startsWith('video/');
  if (!isImage && !isVideo) {
    showAppToast(t('画像または動画ファイルを選択してください'), 'error');
    return false;
  }
  const limit = isVideo ? MAX_STORY_VIDEO_BYTES : MAX_STORY_IMAGE_BYTES;
  if (file.size > limit) {
    showAppToast(`${isVideo ? t('動画') : t('画像')}は${Math.floor(limit / MB)}MB以下にしてください`, 'error');
    return false;
  }
  return true;
}

function validateStoryAudio(file: File | null | undefined): boolean {
  if (!file) return true;
  if (!file.type.startsWith('audio/')) {
    showAppToast(t('音声ファイルを選択してください'), 'error');
    return false;
  }
  if (file.size > MAX_STORY_AUDIO_BYTES) {
    showAppToast(`${t('BGMは')} ${Math.floor(MAX_STORY_AUDIO_BYTES / MB)}MB${t('以下にしてください')}`, 'error');
    return false;
  }
  return true;
}

function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'none';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration || 0);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    video.src = url;
  });
}

function stopStoryPresetBgm() {
  if (storyBgmPlayer?.timer) clearInterval(storyBgmPlayer.timer);
  if (storyBgmPlayer?.master) {
    try { storyBgmPlayer.master.gain.cancelScheduledValues(0); } catch (e) {}
    try { storyBgmPlayer.master.gain.value = 0; } catch (e) {}
  }
  storyBgmPlayer?.nodes?.forEach((node: AudioScheduledSourceNode | AudioNode) => {
    try { if ('stop' in node && typeof node.stop === 'function') node.stop(); } catch (e) {}
    try { node.disconnect?.(); } catch (e) {}
  });
  try { storyBgmPlayer?.ctx?.close?.(); } catch (e) {}
  storyBgmPlayer = null;
}

function playStoryPresetBgm(presetId: string): void {
  stopStoryPresetBgm();
  const preset = STORY_BGM_PRESETS.find(item => item.id === presetId);
  if (!preset) return;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;
  const ctx = new AudioContextCtor();
  const master = ctx.createGain();
  master.gain.value = 0.18;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = ['dark', 'strings'].includes(preset.style) ? 1800 : 2600;
  lowpass.Q.value = 0.7;
  lowpass.connect(ctx.destination);
  master.connect(lowpass);
  let step = 0;

  const trackNode = <T extends AudioScheduledSourceNode | AudioNode>(node: T): T => {
    storyBgmPlayer?.nodes?.push(node);
    return node;
  };
  const makeGain = (volume: number, start: number, attack = 0.01, release = 0.35, target: AudioNode = master): GainNode => {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + release);
    gain.connect(target);
    return gain;
  };
  const note = (freq: number, start: number, duration: number, type: OscillatorType = 'sine', volume = 0.14, detune = 0, attack = 0.015, target: AudioNode = master): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.detune.value = detune;
    osc.connect(makeGain(volume, start, attack, Math.max(0.08, duration), target));
    trackNode(osc);
    osc.start(start);
    osc.stop(start + duration + 0.04);
  };
  const noise = (start: number, duration: number, volume: number, filterFreq: number, type: BiquadFilterType = 'highpass'): void => {
    const buffer = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * duration), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    source.connect(filter).connect(makeGain(volume, start, 0.004, duration));
    trackNode(source);
    source.start(start);
    source.stop(start + duration);
  };
  const impact = (start: number, power = 1): void => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(95 * power, start);
    osc.frequency.exponentialRampToValueAtTime(32, start + 0.34);
    osc.connect(makeGain(0.85, start, 0.006, 0.42));
    trackNode(osc);
    osc.start(start);
    osc.stop(start + 0.46);
    noise(start, 0.12, 0.24, 180, 'lowpass');
  };
  const taiko = (start: number, pitch = 80): void => {
    note(pitch, start, 0.28, 'sine', 0.62, 0, 0.004);
    noise(start, 0.16, 0.2, 320, 'bandpass');
  };
  const cymbal = (start: number, soft = false): void => noise(start, soft ? 0.22 : 0.36, soft ? 0.06 : 0.11, 3600, 'highpass');
  const snare = (start: number): void => noise(start, 0.16, 0.18, 780, 'bandpass');
  const brass = (freq: number, start: number, duration: number, volume = 0.075): void => {
    note(freq, start, duration, 'sawtooth', volume, -7, 0.07, lowpass);
    note(freq * 1.005, start, duration, 'sawtooth', volume * 0.65, 7, 0.07, lowpass);
  };
  const strings = (freq: number, start: number, duration: number, volume = 0.052): void => {
    note(freq, start, duration, 'triangle', volume, -5, 0.16, lowpass);
    note(freq * 2, start, duration, 'sine', volume * 0.35, 4, 0.16, lowpass);
  };
  const chord = (freqs: number[], start: number, duration: number): void => {
    freqs.forEach((freq: number) => {
      if (['strings', 'dark'].includes(preset.style)) strings(freq, start, duration, 0.06);
      else brass(freq, start, duration, ['fanfare', 'heroic'].includes(preset.style) ? 0.09 : 0.065);
    });
  };
  const bass = (freq: number, start: number, duration: number): void => {
    note(freq, start, duration, 'sine', 0.35, 0, 0.008);
    if (preset.style !== 'dark') note(freq * 2, start, duration * 0.8, 'triangle', 0.08, 0, 0.02, lowpass);
  };
  const lead = (freq: number, start: number): void => {
    if (['fanfare', 'heroic', 'cinematic'].includes(preset.style)) brass(freq, start, 0.22, 0.08);
    else if (preset.style === 'taiko') note(freq, start, 0.16, 'triangle', 0.06, 0, 0.02, lowpass);
    else strings(freq, start, 0.28, 0.05);
  };

  const playStep = () => {
    const beat = 60 / preset.bpm;
    const sixteenth = beat / 2;
    const now = ctx.currentTime + 0.02;
    const chordIndex = Math.floor(step / 8) % preset.chords.length;
    const local = step % 16;

    if (local === 0) impact(now, preset.style === 'dark' ? 0.75 : 1);
    if (['trailer', 'fanfare'].includes(preset.drum) && local === 8) impact(now, 0.88);
    if (preset.drum === 'taiko' && [0, 3, 6, 8, 11, 14].includes(local)) taiko(now, local % 8 === 0 ? 72 : 98);
    if (preset.drum === 'march' && [0, 4, 8, 12].includes(local)) taiko(now, 92);
    if (preset.drum === 'pulse' && [0, 8].includes(local)) taiko(now, 58);
    if ([4, 12].includes(local) && !['pulse', 'slow-build'].includes(preset.drum)) snare(now);
    if ([2, 6, 10, 14].includes(local) && !['pulse'].includes(preset.drum)) cymbal(now, preset.style === 'strings');

    if (local % 8 === 0) chord(preset.chords[chordIndex], now, beat * (preset.style === 'minimal' ? 3.4 : 2.7));
    if ([0, 3, 8, 11].includes(local)) bass(preset.bass[Math.floor(step / 4) % preset.bass.length], now, sixteenth * 1.2);

    const leadPattern = preset.style === 'dark' ? [4, 12] : preset.style === 'strings' ? [2, 6, 10, 14] : [1, 3, 6, 9, 11, 14];
    if (leadPattern.includes(local)) lead(preset.lead[step % preset.lead.length], now);

    if (preset.style === 'dark' && local === 15) noise(now, 0.18, 0.08, 1200, 'lowpass');
    if (preset.style === 'cinematic' && local === 15) cymbal(now, false);

    step = (step + 1) % 64;
  };
  storyBgmPlayer = {
    ctx,
    master,
    nodes: [],
    timer: setInterval(playStep, Math.max(95, (60 / preset.bpm / 2) * 1000)),
  };
  playStep();
}

function renderBgmPresetList(query = ''): string {
  const q = query.trim().toLowerCase();
  const items = STORY_BGM_PRESETS.filter(p => !q || `${p.title} ${p.mood}`.toLowerCase().includes(q));
  return items.map(p => `
    <button class="story-bgm-preset" data-bgm-id="${p.id}" type="button">
      <strong>${escapeHtml(p.title)}</strong>
      <span>${escapeHtml(p.mood)} · ${escapeHtml(p.style)} · ${p.bpm} BPM</span>
    </button>
  `).join('') || `<div class="story-bgm-empty">${t('BGMが見つかりません')}</div>`;
}

function renderStoryAvatar(profile: RenderProfile | null, size = 56, state = 'none', options: { plus?: boolean } = {}): string {
  const ringClass = state === 'unseen' ? 'story-ring-unseen' : (state === 'seen' ? 'story-ring-seen' : 'story-ring-none');
  const plus = options.plus ? '<span class="story-add-badge">＋</span>' : '';
  return `<span class="story-avatar-ring ${ringClass}" style="width:${size + 10}px;height:${size + 10}px;">${createAvatarHTML(profile, size)}${plus}</span>`;
}

function getLocalViewedStoryMap(userId: string): Record<string, number> {
  if (!userId) return {};
  try {
    const key = `connect_viewed_stories_${userId}`;
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    const now = Date.now();
    const cleaned: Record<string, number> = {};
    Object.entries(raw).forEach(([storyId, expiresAt]) => {
      if (Number(expiresAt) > now) cleaned[storyId] = Number(expiresAt);
    });
    if (Object.keys(cleaned).length !== Object.keys(raw).length) {
      localStorage.setItem(key, JSON.stringify(cleaned));
    }
    return cleaned;
  } catch (_) {
    return {};
  }
}

function rememberLocalViewedStory(userId: string, story: StoryView | null | undefined): void {
  if (!userId || !story?.id) return;
  try {
    const key = `connect_viewed_stories_${userId}`;
    const viewed = getLocalViewedStoryMap(userId);
    const expiresAt = (() => { const ts = toTimestampLike(story.expiresAt); return typeof ts === 'object' && ts !== null && 'toDate' in ts ? ts.toDate().getTime() : 0; })()
      || (() => { const ts = toTimestampLike(story.createdAt); return typeof ts === 'object' && ts !== null && 'toDate' in ts ? ts.toDate().getTime() : 0; })() + 24 * 60 * 60 * 1000
      || Date.now() + 24 * 60 * 60 * 1000;
    viewed[story.id] = Math.max(Date.now() + 60 * 1000, expiresAt);
    localStorage.setItem(key, JSON.stringify(viewed));
  } catch (_) {}
}

export function applyLocalViewedStories<T extends { stories?: unknown[] }>(groups: T[] = [], userId = ''): T[] {
  const viewed = getLocalViewedStoryMap(userId);
  return (groups || []).filter(Boolean).map((group: T): T => {
    const stories = (group.stories || []).map((story: unknown) => {
      const item = story as StoryView;
      return item.id && viewed[item.id] ? { ...item, viewedByMe: true } : item;
    });
    return { ...group, stories, hasUnseen: stories.some((story: StoryView) => !story.viewedByMe) };
  });
}

function syncViewedStoryLocally(authorId: string, storyId = ''): void {
  if (!authorId) return;
  homeStoryGroupsCache = (homeStoryGroupsCache || []).map((group: StoryGroupView) => {
    if (group.authorId !== authorId) return group;
    const stories = (group.stories || []).map((story: StoryView) => (
      !storyId || story.id === storyId ? { ...story, viewedByMe: true } : story
    ));
    return { ...group, stories, hasUnseen: stories.some((story: StoryView) => !story.viewedByMe) };
  });
  const safeAuthorId = window.CSS?.escape ? CSS.escape(authorId) : String(authorId).replace(/["\\]/g, '\\$&');
  document.querySelectorAll<AppDomElement>(`[data-story-author-id="${safeAuthorId}"]`).forEach(node => {
    node.classList.remove('story-ring-unseen');
    node.classList.remove('story-avatar-clickable');
    node.classList.add('story-ring-none');
  });
  document.querySelectorAll<AppDomElement>(`.story-chip[data-author-id="${safeAuthorId}"] .story-avatar-ring`).forEach(node => {
    node.classList.remove('story-ring-unseen');
    node.classList.add('story-ring-none');
  });
  document.querySelectorAll<AppDomElement>(`.story-chip[data-author-id="${safeAuthorId}"]`).forEach(node => node.remove());
  document.querySelectorAll<AppDomElement>(`.profile-story-open[data-author-id="${safeAuthorId}"]`).forEach(node => node.remove());
}

async function renderHomeStories() {
  const currentUser = getState('user');
  const shelf = getEl('story-shelf');
  if (!currentUser || !shelf) return;
  shelf.innerHTML = renderLoadingSpinner();
  try {
    const groups = applyLocalViewedStories(await getHomeStoryGroups(currentUser.uid), currentUser.uid);
    homeStoryGroupsCache = Array.isArray(groups) ? groups.filter(group => group?.stories?.length) : [];
    const ownProfile = toRenderProfile(getState('userProfile') || currentUser);
    const ownGroup = groups.find(g => g.authorId === currentUser.uid);
    let html = `
      <button class="story-chip story-chip-own" data-action="add-story" aria-label="${t('ストーリーを追加')}">
        ${renderStoryAvatar(ownProfile, 56, ownGroup ? (ownGroup.hasUnseen ? 'unseen' : 'seen') : 'none', { plus: true })}
        <span>${t('追加')}</span>
      </button>
    `;
    html += groups
      .filter(group => group.authorId !== currentUser.uid && group.hasUnseen)
      .map(group => `
        <button class="story-chip" data-action="open-story" data-author-id="${group.authorId}" aria-label="${escapeHtml(toRenderProfile(group.author)?.displayName || 'User')} ${t('のストーリー')}">
          ${renderStoryAvatar(toRenderProfile(group.author), 56, 'unseen')}
          <span>${escapeHtml(toRenderProfile(group.author)?.displayName || 'User')}</span>
        </button>
      `).join('');
    shelf.innerHTML = html;
    shelf.querySelector<AppDomElement>('[data-action="add-story"]')?.addEventListener('click', openStoryComposer);
    shelf.querySelectorAll<AppDomElement>('[data-action="open-story"]').forEach(btn => {
      btn.addEventListener('click', () => openStoryViewer(btn.dataset.authorId, homeStoryGroupsCache));
    });
  } catch (e) {
    shelf.innerHTML = renderEmptyState(t('ストーリーを読み込めませんでした'), '😵');
  }
}

function openStoryComposer() {
  const currentUser = getState('user');
  if (!currentUser) return;
  let selectedFile: File | null = null;
  let selectedAudioPreset: StoryBgmPreset | null = null;
  let muteVideo = true;
  let background = STORY_BACKGROUNDS[Math.floor(Math.random() * STORY_BACKGROUNDS.length)];
  const html = `
    <div class="story-composer-overlay" id="story-composer" role="dialog" aria-modal="true" aria-label="${t('ストーリーを作成')}">
      <div class="story-composer-card">
        <div class="story-composer-header">
          <h3>${t('ストーリーを作成')}</h3>
          <button type="button" class="modal-close" id="story-composer-close" aria-label="${t('閉じる')}">×</button>
        </div>
        <textarea id="story-text" class="form-input story-textarea" maxlength="${MAX_STORY_TEXT}" placeholder="${t('気軽に近況を書いてみましょう')}"></textarea>
        <div class="story-bg-options">
          ${STORY_BACKGROUNDS.map(bg => `<button class="story-bg-option" data-bg="${escapeHtml(bg)}" style="background:${bg}" aria-label="${t('背景を選択')}"></button>`).join('')}
        </div>
        <input type="file" id="story-file" style="display:none">
        <button class="btn btn-secondary" id="story-file-btn">${t('画像/動画を追加')}</button>
        <div class="story-edit-panel">
          <label class="story-edit-toggle">
            <input type="checkbox" id="story-mute-video" checked>
            <span>${t('動画の元音声をミュート')}</span>
          </label>
          <div class="story-bgm-search">
            <input class="form-input" id="story-bgm-search" placeholder="${t('BGMを検索…')}">
            <div class="story-bgm-presets" id="story-bgm-presets">${renderBgmPresetList()}</div>
          </div>
          <span class="story-audio-name" id="story-audio-name"></span>
        </div>
        <div class="story-poll-editor">
          <label class="story-edit-toggle"><input type="checkbox" id="story-poll-enabled"><span>${t('投票を追加')}</span></label>
          <div id="story-poll-fields" class="story-poll-fields hidden">
            <input class="form-input" id="story-poll-question" maxlength="80" placeholder="${t('質問')}">
            <input class="form-input story-poll-option-input" maxlength="60" placeholder="${t('選択肢')} 1">
            <input class="form-input story-poll-option-input" maxlength="60" placeholder="${t('選択肢')} 2">
            <input class="form-input story-poll-option-input" maxlength="60" placeholder="${t('選択肢')} 3（${t('任意')}）">
            <input class="form-input story-poll-option-input" maxlength="60" placeholder="${t('選択肢')} 4（${t('任意')}）">
          </div>
        </div>
        <div id="story-preview" class="story-preview" style="background:${background}"><span>${t('プレビュー')}</span></div>
        <div id="story-status" class="post-submit-status hidden" role="status" aria-live="polite"></div>
        <div id="story-error" class="post-retry-box hidden"><span></span><button class="btn btn-secondary btn-sm" id="story-retry">${t('再試行')}</button></div>
        <button class="btn btn-primary" id="story-submit" disabled>${t('投稿する')}</button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  

  const modal = getEl('story-composer');
  const textEl = getEl('story-text');
  const submit = getEl('story-submit');
  const fileInput = getEl('story-file');
  const audioName = getEl('story-audio-name');
  const bgmSearch = getEl('story-bgm-search');
  const bgmPresets = getEl('story-bgm-presets');
  const muteInput = getEl('story-mute-video');
  const pollEnabled = getEl('story-poll-enabled');
  const pollFields = getEl('story-poll-fields');
  const pollQuestion = getEl('story-poll-question');
  const pollOptionInputs = Array.from(document.querySelectorAll<AppDomElement>('.story-poll-option-input'));
  const preview = getEl('story-preview');
  const status = getEl('story-status');
  const error = getEl('story-error');
  const setStatus = (msg: string, visible = true): void => {
    status.textContent = msg;
    status.classList.toggle('hidden', !visible);
  };
  const getStoryPollDraft = () => {
    if (!pollEnabled?.checked) return null;
    const question = (pollQuestion?.value || '').trim();
    const options = pollOptionInputs.map(input => input.value.trim()).filter(Boolean).slice(0, 4);
    if (!question || options.length < 2) return null;
    return { question, options: options.map(text => ({ text })), expiresAt: Date.now() + STORY_LIFETIME_MS };
  };
  const refresh = () => {
    const pollDraft = getStoryPollDraft();
    submit.disabled = !(textEl.value.trim() || selectedFile || pollDraft);
    if (!selectedFile) {
      preview.style.background = background;
      preview.innerHTML = `<span>${escapeHtml(textEl.value.trim() || t('プレビュー'))}</span>`;
    }
  };
  const close = () => {
    stopStoryPresetBgm();
    modal?.remove();
  };

  getEl('story-composer-close')?.addEventListener('click', close);
  modal?.addEventListener('click', (e) => { if (e.target === modal) close(); });
  textEl?.addEventListener('input', refresh);
  pollEnabled?.addEventListener('change', () => {
    pollFields?.classList.toggle('hidden', !pollEnabled.checked);
    refresh();
  });
  pollQuestion?.addEventListener('input', refresh);
  pollOptionInputs.forEach(input => input.addEventListener('input', refresh));
  getEl('story-file-btn')?.addEventListener('click', () => fileInput?.click());
  muteInput?.addEventListener('change', () => {
    muteVideo = !!muteInput.checked;
    const video = preview?.querySelector<AppDomElement>('video');
    if (video) video.muted = muteVideo;
  });
  const bindBgmPresetButtons = () => {
    bgmPresets?.querySelectorAll<AppDomElement>('.story-bgm-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedAudioPreset = STORY_BGM_PRESETS.find(p => p.id === btn.dataset.bgmId) || null;
        bgmPresets.querySelectorAll<AppDomElement>('.story-bgm-preset').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
        if (audioName) audioName.textContent = selectedAudioPreset ? `♪ ${selectedAudioPreset.title}` : '';
        if (selectedAudioPreset) playStoryPresetBgm(selectedAudioPreset.id);
      });
    });
  };
  bindBgmPresetButtons();
  bgmSearch?.addEventListener('input', () => {
    bgmPresets.innerHTML = renderBgmPresetList(bgmSearch.value);
    bindBgmPresetButtons();
  });
  document.querySelectorAll<AppDomElement>('.story-bg-option').forEach(btn => {
    btn.addEventListener('click', () => {
      background = btn.dataset.bg || background;
      refresh();
    });
  });
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) await sniffAttachmentMimeType(file);
    if (!file || !validateStoryFile(file)) {
      fileInput.value = '';
      return;
    }
    if (isVideoFile(file)) {
      const duration = await getVideoDuration(file);
      if (duration > MAX_STORY_VIDEO_SECONDS) {
        showAppToast(`${t('動画は')} ${MAX_STORY_VIDEO_SECONDS}${t('秒以内にしてください')}`, 'error');
        fileInput.value = '';
        return;
      }
    }
    selectedFile = file;
    const url = URL.createObjectURL(file);
    preview.style.background = 'transparent';
    preview.innerHTML = resolveAttachmentMimeType(file).startsWith('video/')
      ? `<video src="${url}" controls ${muteVideo ? 'muted' : ''} playsinline></video>`
      : `<img src="${url}" alt="${t('ストーリープレビュー')}">`;
    refresh();
  });
  const submitStory = async () => {
    const text = textEl.value.trim();
    const poll = getStoryPollDraft();
    if (!text && !selectedFile && !poll) return;
    submit.disabled = true;
    error.classList.add('hidden');
    try {
      let mediaUrl = '';
      let storyAttachment: import('../types/domain.ts').Attachment | null = null;
      let mediaType = text ? 'text' : 'text';
      if (selectedFile) {
        mediaType = resolveAttachmentMimeType(selectedFile).startsWith('video/') ? 'video' : 'image';
        setStatus(mediaType === 'video' ? t('動画をアップロード中...') : t('画像をアップロード中...'));
        const ext = selectedFile.name.split('.').pop() || (mediaType === 'video' ? 'mp4' : 'jpg');
        storyAttachment = await uploadAttachmentFile(selectedFile, `stories/${currentUser.uid}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
        mediaUrl = storyAttachment.url;
      }
      setStatus(t('ストーリーを投稿中...'));
      const story = await createStory({
        authorId: currentUser.uid,
        text,
        mediaUrl,
        mediaType,
        audioUrl: '',
        audioTitle: selectedAudioPreset?.title || '',
        audioPresetId: selectedAudioPreset?.id || '',
        muteVideo,
        overlayText: text,
        background,
        visibility: 'public',
        poll,
        thumbnailUrl: storyAttachment?.thumbnailUrl || storyAttachment?.previewUrl || '',
        previewStoragePath: storyAttachment?.previewStoragePath || '',
        mediaStoragePath: storyAttachment?.storagePath || '',
        mediaWidth: storyAttachment?.width,
        mediaHeight: storyAttachment?.height,
        mediaDuration: storyAttachment?.duration,
      });
      const friends = await getUserFriendIds(currentUser.uid).catch((): never[] => []);
      for (const friendId of friends.slice(0, 20)) {
        await createNotification({
          userId: friendId,
          type: 'friend_story',
          fromUserId: currentUser.uid,
          storyId: story.id,
          eventId: `${story.id}_${friendId}`,
          context: text.slice(0, 80),
        }).catch(() => {});
      }
      showAppToast(t('ストーリーを投稿しました'), 'success');
      close();
      await renderHomeStories();
    } catch (e) {
      const msg = `${t('投稿に失敗しました')}: ${getFirebaseErrorMessage(e)}`;
      error.querySelector<AppDomElement>('span').textContent = msg;
      error.classList.remove('hidden');
      showAppToast(msg, 'error');
    } finally {
      setStatus('', false);
      refresh();
    }
  };
  submit?.addEventListener('click', submitStory);
  getEl('story-retry')?.addEventListener('click', submitStory);
  refresh();
}

export async function openStoryViewer(authorId: string, storyGroups: StoryGroupView[] | null = null): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser || !authorId) return;
  let groups: StoryGroupView[] = Array.isArray(storyGroups)
    ? storyGroups.filter((group: StoryGroupView) => group?.authorId && group?.stories?.length)
    : [];
  try {
    if (!groups.length) {
      const group = await getUserStoryGroup(authorId, currentUser.uid);
      groups = group?.stories?.length ? [group] : [];
    }
  } catch (e) {}
  if (!groups.length) {
    showAppToast(t('このストーリーは期限切れです'), 'error');
    await renderHomeStories();
    return;
  }

  let groupIndex = Math.max(0, groups.findIndex(group => group.authorId === authorId));
  let index = Math.max(0, groups[groupIndex].stories.findIndex((s: StoryView) => !s.viewedByMe));
  let startX = 0;
  let startY = 0;

  const cleanupViewer = async () => {
    document.removeEventListener('keydown', window.__storyViewerKey || (() => {}));
    getEl('story-bgm')?.pause?.();
    stopStoryPresetBgm();
    getEl('story-viewer')?.remove();
    await renderHomeStories();
  };

  const move = async (delta: number): Promise<void> => {
    const group = groups[groupIndex];
    if (!group) return cleanupViewer();
    const nextStoryIndex = index + delta;
    if (nextStoryIndex >= 0 && nextStoryIndex < group.stories.length) {
      index = nextStoryIndex;
      await render();
      return;
    }
    const nextGroupIndex = groupIndex + delta;
    if (nextGroupIndex < 0 || nextGroupIndex >= groups.length) {
      if (delta > 0) await cleanupViewer();
      return;
    }
    groupIndex = nextGroupIndex;
    const nextGroup = groups[groupIndex];
    index = delta > 0 ? Math.max(0, nextGroup.stories.findIndex((s: StoryView) => !s.viewedByMe)) : nextGroup.stories.length - 1;
    await render();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') cleanupViewer();
    if (e.key === 'ArrowRight') move(1);
    if (e.key === 'ArrowLeft') move(-1);
  };

  const render = async () => {
    const group = groups[groupIndex];
    const story = group.stories[index];
    if (!story) return;
    const isOwner = story.authorId === currentUser.uid;
    const media = story.mediaType === 'image'
      ? `<img class="story-viewer-media" src="${escapeHtml(story.mediaUrl)}" alt="${t('ストーリー画像')}">`
      : story.mediaType === 'video'
        ? `<video id="story-video" class="story-viewer-media" src="${escapeHtml(story.mediaUrl)}" autoplay ${story.muteVideo !== false ? 'muted' : ''} playsinline></video>`
        : `<div class="story-viewer-text" style="background:${escapeHtml(story.background || STORY_BACKGROUNDS[0])}">${escapeHtml(story.text || '')}</div>`;
    const bgm = story.audioUrl ? `<audio id="story-bgm" src="${escapeHtml(story.audioUrl)}" loop></audio>` : '';
    const videoControls = story.mediaType === 'video' ? `
      <div class="story-video-controls" data-no-close>
        <button id="story-video-play" aria-label="${t('再生/停止')}">⏯</button>
        <button id="story-video-mute" aria-label="${t('ミュート切替')}">${story.muteVideo !== false ? '🔇' : '🔊'}</button>
        <button id="story-video-fullscreen" aria-label="${t('全画面')}">⛶</button>
      </div>
    ` : '';
    const textOverlay = story.mediaType !== 'text' && story.text
      ? `<div class="story-viewer-caption">${escapeHtml(story.text)}</div>`
      : '';
    const poll = story.poll as StoryPollView | null;
    const storyPoll = poll?.options?.length ? (() => {
      const total = poll.totalVotes || 0;
      const voted = poll.options.some((option: StoryPollOptionView) => Array.isArray(option.votes) && option.votes.includes(currentUser.uid));
      const optionsHtml = poll.options.map((option: StoryPollOptionView, pollIndex: number) => {
        const votes = Array.isArray(option.votes) ? option.votes.length : Number(option.votes || 0);
        const pct = total ? Math.round(votes / total * 100) : 0;
        return `<button class="story-poll-option ${voted ? 'is-voted' : ''}" data-story-poll-option="${pollIndex}" ${voted ? 'disabled' : ''}><span>${escapeHtml(option.text || '')}</span><strong>${voted ? pct + '%' : ''}</strong></button>`;
      }).join('');
      return `<div class="story-poll" data-story-poll-id="${escapeHtml(story.id)}"><div class="story-poll-question">${escapeHtml(poll.question || t('投票'))}</div>${optionsHtml}<small>${total}${t('票')}</small></div>`;
    })() : '';
    const progress = group.stories.map((_, i) => `<span class="story-progress-seg ${i <= index ? 'active' : ''}"></span>`).join('');
    const overlay = getEl('story-viewer');
    if (!overlay) return;
    overlay.innerHTML = `
      <div class="story-viewer-card" role="dialog" aria-modal="true" aria-label="${t('ストーリー')}">
        <div class="story-progress">${progress}</div>
        <div class="story-viewer-top">
          <a href="#/profile/${story.authorId}" class="story-viewer-author" id="story-viewer-author-link" data-navigate>
            ${createAvatarHTML(toRenderProfile(group.author), 36)}
            <span>${escapeHtml(toRenderProfile(group.author)?.displayName || 'User')}</span>
            <small>${story.createdAt ? formatRelativeTime(toTimestampLike(story.createdAt)) : ''}</small>
          </a>
          <div class="story-viewer-actions">
            ${isOwner ? `<button class="story-delete" id="story-delete" aria-label="${t('削除')}">🗑️</button>` : ''}
            <button type="button" class="story-close" id="story-close" aria-label="${t('閉じる')}">×</button>
          </div>
        </div>
        <button class="story-nav story-nav-prev" id="story-prev" aria-label="${t('前へ')}">‹</button>
        <div class="story-viewer-stage">${media}${bgm}${videoControls}${story.audioTitle ? `<div class="story-bgm-pill">♪ ${escapeHtml(story.audioTitle)}</div>` : ''}${textOverlay}${storyPoll}<div class="story-video-loading">${t('読み込み中...')}</div></div>
        <button class="story-nav story-nav-next" id="story-next" aria-label="${t('次へ')}">›</button>
        ${!isOwner ? `
          <div class="story-reaction-bar">
            <div class="story-reactions">
              ${STORY_REACTIONS.map(r => `<button class="story-reaction" data-reaction="${escapeHtml(r)}" aria-label="${t('リアクション')} ${escapeHtml(r)}">${escapeHtml(r)}</button>`).join('')}
            </div>
          </div>
        ` : `<div class="story-owner-meta">${story.reactionCount || 0}${t('件のリアクション')}</div>`}
      </div>
    `;
    story.viewedByMe = true;
    rememberLocalViewedStory(currentUser.uid, story);
    group.hasUnseen = group.stories.some(s => !s.viewedByMe && s.authorId !== currentUser.uid);
    syncViewedStoryLocally(story.authorId, story.id);
    if (story.authorId !== currentUser.uid) {
      markStoryViewed(story.id, currentUser.uid).catch(() => {});
    }
    const bgmEl = getEl('story-bgm');
    bgmEl?.play?.().catch(() => {});
    if (story.audioPresetId) playStoryPresetBgm(story.audioPresetId);
    else stopStoryPresetBgm();

    document.removeEventListener('keydown', window.__storyViewerKey || (() => {}));
    window.__storyViewerKey = onKey;
    document.addEventListener('keydown', onKey);
    getEl('story-close')?.addEventListener('click', cleanupViewer);
    getEl('story-viewer-author-link')?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const href = e.currentTarget instanceof HTMLAnchorElement ? e.currentTarget.getAttribute('href') : null;
      await cleanupViewer();
      if (href) window.location.hash = href.replace(/^#/, '');
    });
    getEl('story-prev')?.addEventListener('click', () => move(-1));
    getEl('story-next')?.addEventListener('click', () => move(1));
    document.querySelector<AppDomElement>('.story-viewer-stage')?.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
    });
    document.querySelector<AppDomElement>('.story-viewer-stage')?.addEventListener('pointerup', (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) < 46 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      move(dx < 0 ? 1 : -1);
    });
    getEl('story-video-play')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const video = getEl('story-video');
      if (!video) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    getEl('story-video-mute')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const video = getEl('story-video');
      if (!video) return;
      video.muted = !video.muted;
      if (e.currentTarget instanceof HTMLElement) e.currentTarget.textContent = video.muted ? '🔇' : '🔊';
    });
    getEl('story-video-fullscreen')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const video = getEl('story-video');
      video?.requestFullscreen?.();
    });

    getEl('story-delete')?.addEventListener('click', async () => {
      if (!confirm(t('このストーリーを削除してもよろしいですか？'))) return;
      await deleteStory(story.id, currentUser.uid);
      showAppToast(t('ストーリーを削除しました'), 'success');
      group.stories.splice(index, 1);
      if (group.stories.length === 0) {
        groups.splice(groupIndex, 1);
        if (!groups.length) await cleanupViewer();
        else {
          groupIndex = Math.min(groupIndex, groups.length - 1);
          index = 0;
          await render();
        }
      }
      else {
        index = Math.min(index, group.stories.length - 1);
        await render();
      }
    });
    document.querySelectorAll<AppDomElement>('[data-story-poll-option]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          story.poll = await voteStoryPoll(story.id, Number(btn.dataset.storyPollOption), currentUser.uid);
          await render();
        } catch (error) {
          showAppToast(t('投票に失敗しました') + ': ' + getFirebaseErrorMessage(error), 'error');
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll<AppDomElement>('.story-reaction').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await reactToStory(story.id, currentUser.uid, btn.dataset.reaction);
          await createNotification({
            userId: story.authorId,
            type: 'story_reaction',
            fromUserId: currentUser.uid,
            storyId: story.id,
            reactionType: btn.dataset.reaction || '',
            eventId: `${story.id}_${currentUser.uid}_${btn.dataset.reaction || '_'}`,
            context: btn.dataset.reaction,
          });
          showAppToast(t('リアクションを送信しました'), 'success');
        } catch (e) {
          showAppToast(t('リアクション送信に失敗しました'), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  };

  getEl('story-viewer')?.remove();
  document.body.insertAdjacentHTML('beforeend', '<div class="story-viewer-overlay" id="story-viewer"></div>');
  getEl('story-viewer')?.addEventListener('click', (e) => {
    if ((e.target instanceof HTMLElement ? e.target.id : '') === 'story-viewer') {
      getEl('story-close')?.click();
    }
  });
  await render();
}

type FeedRenderOptions = { initialLoad?: InitialLoadProgress; initialLoadSessionId?: number; signal?: AbortSignal };

export async function renderFeedPage(options: FeedRenderOptions = {}) {
  const currentUser = getState('user');
  const currentProfile = getState('userProfile');
  const hasCurrentProfile = Boolean(currentUser && currentProfile?.uid === currentUser.uid);
  const initialLoad = options.initialLoad;
  const initialLoadSessionId = options.initialLoadSessionId ?? initialLoad?.getSessionId();
  // A route change or a retry invalidates every previous request before the
  // new feed state is exposed to the user.
  feedLoadGeneration += 1;
  document.body.classList.remove('composer-fullscreen-open');

  const container = getEl('page-content');
  container.innerHTML = `
    <div class="feed-page">
      <div class="feed-container" id="feed-container">
        ${currentUser ? renderCreatePostForm(hasCurrentProfile ? currentProfile : currentUser, { avatarLoading: !hasCurrentProfile }) : `<div class="guest-cta-card"><strong>${t('ログインすると投稿できます')}</strong><p>${t('公開投稿はこのまま読めます。反応や投稿にはログインが必要です。')}</p><a class="btn btn-primary" href="#/login">${t('ログイン')}</a></div>`}
        <div class="feed-tabs" role="tablist" aria-label="${t('フィード切り替え')}">
          <button class="feed-tab active" data-feed-mode="recommended" role="tab" aria-selected="true">${t('おすすめ')}</button>
          <button class="feed-tab" data-feed-mode="friends" role="tab" aria-selected="false">${t('友達')}</button>
        </div>
        <div class="feed-posts" id="feed-posts">
          ${renderLoadingSpinner()}
        </div>
      </div>
    </div>
  `;

  // 初期データ読み込み
  feedState.feedContainer = getEl('feed-posts');
  feedState.posts = [];
  feedState.loadedCount = 0;
  feedState.cursor = null;
  feedState.loading = false;
  feedState.hasMore = true;
  feedState.renderedPostIds = new Set();
  feedState.mode = currentUser ? (localStorage.getItem(`connect_feed_mode_${currentUser.uid}`) || 'recommended') : 'recommended';
  document.querySelectorAll<AppDomElement>('.feed-tab').forEach(tab => {
    const active = tab.dataset.feedMode === feedState.mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.addEventListener('click', async () => {
      if (feedState.mode === tab.dataset.feedMode) return;
      feedState.mode = tab.dataset.feedMode || 'recommended';
      if (currentUser) localStorage.setItem(`connect_feed_mode_${currentUser.uid}`, feedState.mode);
      document.querySelectorAll<AppDomElement>('.feed-tab').forEach(tEl => {
        const isActive = tEl.dataset.feedMode === feedState.mode;
        tEl.classList.toggle('active', isActive);
        tEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      feedState.posts = [];
      feedState.loadedCount = 0;
      feedState.cursor = null;
      feedState.hasMore = true;
      feedState.renderedPostIds = new Set();
      feedState.feedContainer.innerHTML = renderLoadingSpinner();
       await loadFeedPosts({ signal: options.signal });
    });
  });

  if (currentUser) {
    setupPostCreation();
  }

  // 初回ルートの完了は、ユーザーが読むフィードの初期データが描画されてからにする。
  // これにより起動ゲージは、実際の取得・補完処理が終わるまで完了しない。
  await loadFeedPosts({ throwOnInitialFailure: true, initialLoad, initialLoadSessionId, signal: options.signal });

  // 無限スクロール
  setupInfiniteScroll();
  if (initialLoad && initialLoadSessionId !== undefined) initialLoad.completeTask('page-dom', initialLoadSessionId);
}

type LoadFeedPostsOptions = { throwOnInitialFailure?: boolean; initialLoad?: InitialLoadProgress; initialLoadSessionId?: number; signal?: AbortSignal };

async function loadFeedPosts({ throwOnInitialFailure = false, initialLoad, initialLoadSessionId, signal }: LoadFeedPostsOptions = {}) {
  const currentUser = getState('user');
  const run = initialLoadSessionId ?? initialLoad?.getSessionId();
  if (feedState.loading || !feedState.hasMore) return;
  const requestGeneration = ++feedLoadGeneration;
  const isCurrentGeneration = (): boolean => requestGeneration === feedLoadGeneration;
  const isCurrentInitialSession = (): boolean => !initialLoad || run === undefined
    || (initialLoad.getSessionId() === run && initialLoad.getSnapshot().status === 'loading');
  const isCurrentRequest = (): boolean => isCurrentGeneration() && isCurrentInitialSession() && !signal?.aborted;
  feedState.loading = true;
  if (initialLoad && run !== undefined) initialLoad.startTask('page-request', run);

  try {
    const viewerId = currentUser?.uid || '';
    const seenPostIds = viewerId ? getSeenFeedPostIds(viewerId) : [];
    let cursor = feedState.cursor;
    let fetchedPosts: FeedPostViewModel[] = [];
    let uniqueEnriched: FeedPostViewModel[] = [];
    let attempts = 0;
    const existingIds = new Set(feedState.posts.map(post => post.id).filter(Boolean));
    const wasInitialLoad = feedState.posts.length === 0;

    const trace = getActiveStartupTraceSession();
    const maxAttempts = wasInitialLoad ? 3 : 2;
    while (attempts < 3 && uniqueEnriched.length === 0 && (attempts === 0 || cursor)) {
      if (!isCurrentRequest()) return;
      await waitForInitialLoadDebugStep();
      const result = await retryWithBackoff(
        () => withTimeout(
          getFeedPosts(viewerId, cursor, 10, feedState.mode, seenPostIds),
          wasInitialLoad ? 12000 : 15000,
          signal,
        ),
        {
          maxAttempts,
          baseDelayMs: 180,
          maxDelayMs: 1400,
          signal,
          onRetry: ({ info, retryCount, delayMs }) => {
            trace?.event('feed-retry', 'retry', {
              endpointCategory: 'firestore-feed',
              retryCount,
              delayMs,
              errorType: info.kind,
              httpStatus: info.httpStatus,
            });
          },
        },
      );
      if (!isCurrentRequest()) return;
      fetchedPosts = result.posts || [];
      cursor = result.cursor || null;
      feedState.loadedCount = result.loadedCount;
      if (fetchedPosts.length === 0) break;
      const enriched = await enrichPosts(fetchedPosts, viewerId, initialLoad, run, signal);
      if (!isCurrentRequest()) return;
      uniqueEnriched = enriched.filter(post => post.id && !existingIds.has(post.id) && !feedState.renderedPostIds.has(post.id));
      attempts += 1;
    }

    if (!isCurrentRequest()) return;
    if (initialLoad && run !== undefined) initialLoad.completeTask('page-request', run);
    if (initialLoad && run !== undefined && fetchedPosts.length === 0) initialLoad.completeTask('page-data', run);

    feedState.posts = [...feedState.posts, ...uniqueEnriched];
    feedState.cursor = cursor;
    feedState.hasMore = Boolean(cursor && fetchedPosts.length > 0);
    if (viewerId) rememberSeenFeedPosts(viewerId, fetchedPosts);

    if (wasInitialLoad) {
      renderFeedPosts();
    } else {
      appendFeedPosts(uniqueEnriched);
    }
  } catch (e) {
    if (!isCurrentRequest()) return;
    const info = classifyStartupError(e);
    console.error('Feed load failed', { errorType: info.kind, httpStatus: info.httpStatus, retryable: info.kind === 'network' || info.kind === 'timeout' || info.kind === 'rate_limit' || info.kind === 'server' });
    const container = feedState.feedContainer;
    if (container && feedState.posts.length === 0) {
      const errMsg = getFirebaseErrorMessage(e);
      container.innerHTML = `
        <div class="error-card">
          <div class="error-icon">😵</div>
          <h3 class="error-title">${t('読み込みに失敗しました')}</h3>
          <p class="error-text">${errMsg}</p>
          <button class="btn btn-primary retry-feed-btn" style="margin-top:12px;">${t('再試行')}</button>
        </div>
      `;
      container.querySelector<AppDomElement>('.retry-feed-btn')?.addEventListener('click', () => {
        feedState.loading = false;
        loadFeedPosts();
      });
    }
    if (throwOnInitialFailure) throw e;
  } finally {
    if (isCurrentGeneration()) feedState.loading = false;
  }
}

function renderFeedPosts() {
  const container = feedState.feedContainer;
  if (!container) return;

  cleanupPostVideoObservers(container);
  feedState.renderedPostIds = new Set();

  if (feedState.posts.length === 0) {
    container.innerHTML = renderEmptyState(
      t('まだ投稿がありません。最初の投稿を作成しましょう！'),
      '🎉'
    );
    return;
  }

  let html = '';

  feedState.posts.forEach((post) => {
    if (post.id) feedState.renderedPostIds.add(post.id);
    const author = toRenderProfile(post.author);
    html += renderPostCard(toRenderPost(post), author, post.liked, post.reposted);
  });

  if (feedState.hasMore) {
    html += renderLoadMoreButton();
  }

  container.innerHTML = html;
  const firstContentImage = container.querySelector<HTMLImageElement>('.post-card .post-images img, .post-card .post-images-carousel img');
  if (firstContentImage) {
    firstContentImage.loading = 'eager';
    firstContentImage.fetchPriority = 'high';
  }

  setupPostEventListeners(container);
  recordVisiblePostViews(container);
  bindFeedLoadMore(container);
}

function appendFeedPosts(posts: FeedPostViewModel[]): void {
  const container = feedState.feedContainer;
  if (!container) return;

  container.querySelector('#btn-load-more')?.parentElement?.remove();

  let html = '';
  posts.forEach((post) => {
    if (!post.id || feedState.renderedPostIds.has(post.id)) return;
    feedState.renderedPostIds.add(post.id);
    html += renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted);
  });

  if (feedState.hasMore) {
    html += renderLoadMoreButton();
  }

  if (!html) {
    bindFeedLoadMore(container);
    return;
  }

  const staging = document.createElement('div');
  staging.innerHTML = html;
  setupPostEventListeners(staging);
  const fragment = document.createDocumentFragment();
  while (staging.firstChild) fragment.appendChild(staging.firstChild);
  container.appendChild(fragment);
  recordVisiblePostViews(container);
  pruneFeedDom(container);
  bindFeedLoadMore(container);
}

function pruneFeedDom(container: HTMLElement): void {
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.post-card[data-post-id]:not(.post-card-pruned)'));
  if (cards.length <= FEED_DOM_SOFT_LIMIT) return;
  const removable = cards.slice(0, Math.max(0, cards.length - FEED_DOM_SOFT_LIMIT));
  removable.forEach(card => {
    const postId = card.dataset.postId || '';
    const placeholder = document.createElement('div');
    placeholder.className = 'post-card post-card-pruned';
    placeholder.dataset.postId = postId;
    placeholder.innerHTML = `<span>${t('古い投稿を軽量表示にしました')}</span>${postId ? `<a href="#/post/${encodeURIComponent(postId)}" data-navigate>${t('開く')}</a>` : ''}`;
    card.replaceWith(placeholder);
  });
}

function bindFeedLoadMore(container: HTMLElement): void {
  const loadMore = container.querySelector<AppDomElement>('#btn-load-more');
  if (!loadMore || loadMore.dataset.feedLoadBound === 'true') return;
  loadMore.dataset.feedLoadBound = 'true';
  loadMore.addEventListener('click', async () => {
    loadMore.textContent = t('読み込み中...');
    loadMore.disabled = true;
    await loadFeedPosts();
  });
}

function recordVisiblePostViews(container: HTMLElement | null): void {
  const cards = Array.from(container?.querySelectorAll<AppDomElement>('.post-card[data-post-id]') || []);
  if (typeof IntersectionObserver === 'undefined') {
    const viewerId = getState('user')?.uid || '';
    cards.forEach(card => recordPostViewOnce(card, viewerId));
    return;
  }

  if (!postViewObserver) {
    postViewObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.4) return;
        const card = entry.target as AppDomElement;
        postViewObserver?.unobserve(card);
        window.setTimeout(() => recordPostViewOnce(card, getState('user')?.uid || ''), 350);
      });
    }, { threshold: [0.4] });
  }

  cards.forEach(card => {
    const postId = card.dataset.postId;
    if (!postId || card.dataset.viewRecorded === 'true' || sessionRecordedPostViews.has(postId)) return;
    card.dataset.viewRecorded = 'true';
    postViewObserver?.observe(card);
  });
}

function recordPostViewOnce(card: AppDomElement, viewerId: string): void {
  const postId = card.dataset.postId;
  if (!postId || sessionRecordedPostViews.has(postId)) return;
  sessionRecordedPostViews.add(postId);
  recordPostView(postId, viewerId).catch(() => {});
}

const observedPostVideos = new Set<HTMLVideoElement>();
let postVideoObserver: IntersectionObserver | null = null;

function getPostVideoObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (postVideoObserver) return postVideoObserver;
  postVideoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const video = entry.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (!entry.isIntersecting || entry.intersectionRatio <= 0) {
        video.dataset.connectInViewport = 'false';
        video.pause();
      } else {
        video.dataset.connectInViewport = 'true';
        const sourceURL = video.dataset.src || '';
        const postId = video.closest<HTMLElement>('.post-video')?.dataset.postId || '';
        if (postId && sourceURL && video.dataset.videoPrefetchStarted !== 'true') {
          video.dataset.videoPrefetchStarted = 'true';
          void prefetchPostVideoURL(postId, sourceURL).then((url) => {
            if (video.isConnected && video.dataset.src === sourceURL) video.dataset.resolvedSrc = url;
          }).catch(() => {
            delete video.dataset.videoPrefetchStarted;
          });
        }
      }
    });
  }, { threshold: [0, 0.25] });
  return postVideoObserver;
}

function cleanupPostVideoObservers(scope: HTMLElement | null = null): void {
  const observer = postVideoObserver;
  observedPostVideos.forEach(video => {
    if (!video.isConnected || (scope && scope.contains(video))) {
      observer?.unobserve(video);
      observedPostVideos.delete(video);
      delete video.dataset.videoObserved;
    }
  });
}

function setupPostVideoPlayback(container: HTMLElement | null): void {
  if (!container) return;
  cleanupPostVideoObservers();
  const observer = getPostVideoObserver();
  container.querySelectorAll<HTMLVideoElement>('.post-video video').forEach(video => {
    video.loop = true;
    bindVideoLongPress(video);
    if (video.dataset.videoObserved === 'true') return;
    video.dataset.videoObserved = 'true';
    observedPostVideos.add(video);
    observer?.observe(video);
  });
}

type ProfileHoverFriendshipStatus = 'self' | 'none' | 'friends' | 'pending_sent' | 'pending_received';

type ProfileHoverEntry = {
  profile: UserProfile | null;
  postsCount: number;
  friendsCount: number;
  friendshipStatus: ProfileHoverFriendshipStatus;
  cachedAt: number;
};

let profileHoverInitialized = false;
let profileHoverTimer: ReturnType<typeof setTimeout> | null = null;
let profileHoverHideTimer: ReturnType<typeof setTimeout> | null = null;
let profileHoverCard: HTMLElement | null = null;
const profileHoverCache = new Map<string, ProfileHoverEntry>();
let activeProfileHoverUid = '';

function normalizeHoverProfile(uid: string, profile: UserProfile | null): UserProfile {
  return profile || { uid, displayName: 'User', username: '' };
}

function closeProfileHoverCard(): void {
  if (profileHoverTimer) clearTimeout(profileHoverTimer);
  if (profileHoverHideTimer) clearTimeout(profileHoverHideTimer);
  profileHoverTimer = null;
  profileHoverHideTimer = null;
  activeProfileHoverUid = '';
  profileHoverCard?.remove();
  profileHoverCard = null;
}

function scheduleProfileHoverClose(): void {
  if (profileHoverHideTimer) clearTimeout(profileHoverHideTimer);
  profileHoverHideTimer = setTimeout(() => closeProfileHoverCard(), 160);
}

function positionProfileHoverCard(anchor: HTMLElement, card: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const margin = 12;
  let left = rect.left;
  let top = rect.bottom + 10;
  if (left + cardRect.width + margin > window.innerWidth) left = window.innerWidth - cardRect.width - margin;
  if (top + cardRect.height + margin > window.innerHeight) top = rect.top - cardRect.height - 10;
  card.style.left = `${Math.max(margin, left)}px`;
  card.style.top = `${Math.max(margin, top)}px`;
}

async function readProfileHoverEntry(uid: string): Promise<ProfileHoverEntry> {
  const cached = profileHoverCache.get(uid);
  const cacheFresh = Boolean(cached && Date.now() - cached.cachedAt < 5 * 60 * 1000);
  const currentUser = getState('user');
  const friendshipStatusPromise: Promise<ProfileHoverFriendshipStatus> = !currentUser
    ? Promise.resolve('none')
    : currentUser.uid === uid
      ? Promise.resolve('self')
      : cacheFresh && cached
        ? Promise.resolve(cached.friendshipStatus)
      : getFriendshipStatus(currentUser.uid, uid).catch((): ProfileHoverFriendshipStatus => 'none');
  const [profile, postsCount, friendsCount, friendshipStatus] = await Promise.all([
    getDisplayUserProfile(uid).catch((): null => null),
    cacheFresh && cached ? Promise.resolve(cached.postsCount) : getUserPostCount(uid).catch((): number => 0),
    cacheFresh && cached ? Promise.resolve(cached.friendsCount) : getUserFriendCount(uid).catch((): number => 0),
    friendshipStatusPromise,
  ]);
  const normalizedProfile: UserProfile | null = profile ? {
    uid: profile.uid || profile.id || uid,
    displayName: profile.displayName || 'User',
    username: profile.username || '',
    bio: normalizeProfileBio(profile.bio),
    photoURL: resolveAvatarURL(profile),
    profileImage: typeof profile.profileImage === 'string' ? profile.profileImage : '',
    profilePhotoPreviewURL: typeof profile.profilePhotoPreviewURL === 'string' ? profile.profilePhotoPreviewURL : '',
    avatarColor: profile.avatarColor || '',
    friendsCount: typeof profile.friendsCount === 'number' ? profile.friendsCount : undefined,
    postsCount: typeof profile.postsCount === 'number' ? profile.postsCount : undefined,
  } : null;
  const entry: ProfileHoverEntry = { profile: normalizedProfile, postsCount, friendsCount, friendshipStatus, cachedAt: Date.now() };
  profileHoverCache.set(uid, entry);
  return entry;
}

function renderProfileHoverAction(uid: string, status: ProfileHoverFriendshipStatus): string {
  if (status === 'self') {
    return `<a class="profile-hover-action profile-hover-action-link" href="#/profile/${encodeURIComponent(uid)}" data-navigate>${t('プロフィール')}</a>`;
  }
  if (status === 'friends') {
    return `<button type="button" class="profile-hover-action is-friend" data-action="profile-hover-remove-friend" data-uid="${escapeHtml(uid)}">${t('友達')}</button>`;
  }
  if (status === 'pending_sent') {
    return `<button type="button" class="profile-hover-action" disabled>${t('申請中')}</button>`;
  }
  if (status === 'pending_received') {
    return `<button type="button" class="profile-hover-action" data-action="profile-hover-accept-friend" data-uid="${escapeHtml(uid)}">${t('承認')}</button>`;
  }
  return `<button type="button" class="profile-hover-action" data-action="profile-hover-add-friend" data-uid="${escapeHtml(uid)}">${t('友達追加')}</button>`;
}

function renderProfileHoverCard(uid: string, entry: ProfileHoverEntry): string {
  const profile = normalizeHoverProfile(uid, entry.profile);
  const displayName = escapeHtml(profile.displayName || 'User');
  const username = escapeHtml(profile.username || 'user');
  const bio = escapeHtml(profile.bio || '');
  return `
    <div class="profile-hover-top">
      <a class="profile-hover-avatar-link" href="#/profile/${encodeURIComponent(uid)}" data-navigate>${createAvatarHTML(profile, 64)}</a>
      ${renderProfileHoverAction(uid, entry.friendshipStatus)}
    </div>
    <a class="profile-hover-name" href="#/profile/${encodeURIComponent(uid)}" data-navigate>${displayName}</a>
    <a class="profile-hover-username" href="#/profile/${encodeURIComponent(uid)}" data-navigate>@${username}</a>
    ${bio ? `<p>${bio}</p>` : ''}
    <div class="profile-hover-stats">
      <span><strong>${entry.postsCount}</strong>${t('件のポスト')}</span>
      <span><strong>${entry.friendsCount}</strong>${t('人の友達')}</span>
    </div>
  `;
}

async function handleProfileHoverAction(button: AppDomElement): Promise<void> {
  const currentUser = getState('user');
  const uid = button.dataset.uid || '';
  if (!currentUser || !uid) {
    showAppToast(t('ログインが必要です'), 'error');
    return;
  }
  if (uid === currentUser.uid) return;
  const action = button.dataset.action || '';
  button.setAttribute('disabled', 'true');
  try {
    if (action === 'profile-hover-remove-friend') {
      await removeFriend(currentUser.uid, uid);
      profileHoverCache.delete(uid);
      button.classList.remove('is-friend');
      button.dataset.action = 'profile-hover-add-friend';
      button.textContent = t('友達追加');
      showAppToast(t('友達を解除しました'), 'success');
      return;
    }
    if (action === 'profile-hover-accept-friend') {
      await acceptFriendRequest(currentUser.uid, uid);
      profileHoverCache.delete(uid);
      button.classList.add('is-friend');
      button.dataset.action = 'profile-hover-remove-friend';
      button.textContent = t('友達');
      showAppToast(t('友達リクエストを承認しました'), 'success');
      return;
    }
    if (action === 'profile-hover-add-friend') {
      await sendFriendRequest(currentUser.uid, uid);
      profileHoverCache.delete(uid);
      button.textContent = t('申請中');
      return;
    }
  } catch (error: unknown) {
    showAppToast(getFirebaseErrorMessage(error), 'error');
    button.removeAttribute('disabled');
  }
}

async function showProfileHoverCard(anchor: HTMLElement, uid: string): Promise<void> {
  activeProfileHoverUid = uid;
  const card = document.createElement('div');
  card.className = 'profile-hover-card';
  card.dataset.profileHoverCard = 'true';
  card.innerHTML = renderLoadingSpinner();
  card.addEventListener('pointerenter', () => {
    if (profileHoverHideTimer) clearTimeout(profileHoverHideTimer);
  });
  card.addEventListener('pointerleave', scheduleProfileHoverClose);
  profileHoverCard?.remove();
  profileHoverCard = card;
  document.body.appendChild(card);
  positionProfileHoverCard(anchor, card);
  try {
    const entry = await readProfileHoverEntry(uid);
    if (activeProfileHoverUid !== uid || profileHoverCard !== card) return;
    card.innerHTML = renderProfileHoverCard(uid, entry);
    card.querySelectorAll<AppDomElement>('[data-action^="profile-hover-"]').forEach(button => {
      button.addEventListener('click', (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        handleProfileHoverAction(button).catch((error: unknown) => showAppToast(getFirebaseErrorMessage(error), 'error'));
      });
    });
    positionProfileHoverCard(anchor, card);
  } catch (_error) {
    if (activeProfileHoverUid !== uid || profileHoverCard !== card) return;
    card.innerHTML = renderProfileHoverCard(uid, { profile: null, postsCount: 0, friendsCount: 0, friendshipStatus: 'none', cachedAt: Date.now() });
    positionProfileHoverCard(anchor, card);
  }
}

function ensureProfileHoverCards(): void {
  if (profileHoverInitialized) return;
  profileHoverInitialized = true;
  document.addEventListener('pointerover', (event: PointerEvent) => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLElement>('[data-profile-hover-uid]');
    if (!anchor) return;
    const uid = anchor.dataset.profileHoverUid;
    if (!uid) return;
    if (profileHoverHideTimer) clearTimeout(profileHoverHideTimer);
    if (profileHoverTimer) clearTimeout(profileHoverTimer);
    profileHoverTimer = setTimeout(() => {
      showProfileHoverCard(anchor, uid).catch(() => {});
    }, 260);
  });
  document.addEventListener('pointerout', (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLElement>('[data-profile-hover-uid]');
    if (!anchor) return;
    const related = event.relatedTarget;
    if (related instanceof Node && (anchor.contains(related) || profileHoverCard?.contains(related))) return;
    scheduleProfileHoverClose();
  });
  document.addEventListener('pointerdown', (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (profileHoverCard?.contains(target)) return;
    if (target instanceof Element && target.closest('[data-profile-hover-uid]')) return;
    closeProfileHoverCard();
  });
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeProfileHoverCard();
  });
}

ensureProfileHoverCards();


export async function decorateStoryAvatars(container: HTMLElement | null): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser || !container) return;
  const nodes = Array.from(container.querySelectorAll<AppDomElement>('[data-story-author-id]'));
  const authorIds = Array.from(new Set(nodes.map(n => n.dataset.storyAuthorId).filter(Boolean)));
  if (authorIds.length === 0) return;
  const cachedByAuthor = new Map<string, StoryGroupView>((homeStoryGroupsCache || []).filter((g): g is StoryGroupView => !!g?.authorId).map((g): [string, StoryGroupView] => [g.authorId || '', g]));
  const missingIds = authorIds.filter(id => !cachedByAuthor.has(id));
  const groups = applyLocalViewedStories(
    await Promise.all(missingIds.map((id: string): Promise<StoryGroupView | null> => getUserStoryGroup(id, currentUser.uid).catch((_error: unknown): null => null) as Promise<StoryGroupView | null>)),
    currentUser.uid
  );
  const byAuthor = new Map<string, StoryGroupView>([...cachedByAuthor, ...groups.filter((g): g is StoryGroupView => !!g?.authorId).map((g): [string, StoryGroupView] => [g.authorId || '', g])]);
  nodes.forEach(node => {
    const group = byAuthor.get(node.dataset.storyAuthorId);
    if (!group) return;
    node.classList.remove('story-ring-unseen', 'story-ring-seen', 'story-ring-none');
    node.classList.toggle('story-avatar-clickable', !!group.hasUnseen);
    if (!group.hasUnseen) {
      node.classList.add('story-ring-none');
      return;
    }
    node.classList.add('story-ring-unseen');
    if (node.dataset.storyOpenBound === 'true') return;
    node.dataset.storyOpenBound = 'true';
    node.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStoryViewer(group.authorId);
    });
  });
}

function closeImageAltPopup(): void {
  document.querySelectorAll<AppDomElement>('.post-image-alt-popup').forEach(el => el.remove());
}

function openImageAltPopup(anchor: HTMLElement, text: string): void {
  closeImageAltPopup();
  const popup = document.createElement('div');
  popup.className = 'post-image-alt-popup';
  popup.setAttribute('role', 'dialog');
  popup.innerHTML = `<button type="button" class="post-image-alt-close" aria-label="${t('閉じる')}">×</button><p>${escapeHtml(text)}</p>`;
  document.body.appendChild(popup);
  const rect = anchor.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const margin = 12;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (left + popupRect.width + margin > window.innerWidth) left = window.innerWidth - popupRect.width - margin;
  if (top + popupRect.height + margin > window.innerHeight) top = rect.top - popupRect.height - 8;
  popup.style.left = `${Math.max(margin, left)}px`;
  popup.style.top = `${Math.max(margin, top)}px`;
  popup.querySelector<AppDomElement>('.post-image-alt-close')?.addEventListener('click', closeImageAltPopup);
}

function toggleImageAltButton(btn: AppDomElement, event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  const text = btn.dataset.altText || '';
  if (!text) return;
  const wasOpen = btn.getAttribute('aria-expanded') === 'true';
  document.querySelectorAll<AppDomElement>('[data-action="image-alt"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
  if (wasOpen) {
    closeImageAltPopup();
    return;
  }
  btn.setAttribute('aria-expanded', 'true');
  openImageAltPopup(btn, text);
}

function setupImageAltButtons(container: HTMLElement | Document = document): void {
  container.querySelectorAll<AppDomElement>('[data-action="image-alt"]').forEach(btn => {
    if (btn.dataset.altBound === 'true') return;
    btn.dataset.altBound = 'true';
    btn.addEventListener('pointerdown', (event: PointerEvent) => {
      event.stopPropagation();
    }, true);
  });
}

document.addEventListener('click', (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest<AppDomElement>('[data-action="image-alt"]');
  if (!btn) return;
  toggleImageAltButton(btn, event);
}, true);

document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest<AppDomElement>('[data-action="image-alt"]');
  if (!btn) return;
  toggleImageAltButton(btn, event);
}, true);

document.addEventListener('pointerdown', (event: PointerEvent) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.post-image-alt-popup') || target.closest('[data-action="image-alt"]')) return;
  document.querySelectorAll<AppDomElement>('[data-action="image-alt"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
  closeImageAltPopup();
}, true);
document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  if (!document.querySelector('.post-image-alt-popup')) return;
  event.stopImmediatePropagation();
  document.querySelectorAll<AppDomElement>('[data-action="image-alt"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
  closeImageAltPopup();
});
function setupImageOpenListeners(container: HTMLElement | null): void {
  if (!container) return;
  setupImageAltButtons(container);
  container.querySelectorAll<AppDomElement>('[data-action="open-image"]').forEach(btn => {
    if (btn.dataset.imageOpenBound === 'true') return;
    btn.dataset.imageOpenBound = 'true';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll<AppDomElement>('.image-lightbox').forEach(el => el.remove());
      const card = btn.closest<AppDomElement>('.post-card');
      const items = Array.from(card?.querySelectorAll<AppDomElement>('[data-action="open-image"]') || [])
        .map((el): ImageViewerItem | null => {
          const image = el.querySelector<HTMLImageElement>('img[data-post-media-image="true"]');
          const resolvedURL = image?.dataset.resolvedSrc || image?.currentSrc || image?.getAttribute('src') || el.dataset.imageUrl || '';
          if (!resolvedURL) return null;
          // Keep the click target in sync with the exact URL currently rendered in the post.
          el.dataset.imageUrl = resolvedURL;
          return {
            url: resolvedURL,
            alt: el.querySelector<AppDomElement>('[data-action="image-alt"]')?.dataset.altText || '',
            postId: el.dataset.postId || card?.dataset.postId || '',
            mediaIndex: Number(el.dataset.mediaIndex || el.dataset.imageIndex || 0),
            sourceButton: el,
          };
        })
        .filter((item): item is ImageViewerItem => item !== null);
      const startIndex = Math.max(0, items.findIndex(item => item.url === btn.dataset.imageUrl));
      openImageViewer(items, startIndex);
    });
  });
}

let postMediaImageResolverBound = false;
function bindPostMediaImageResolver(): void {
  if (postMediaImageResolverBound) return;
  postMediaImageResolverBound = true;
  document.addEventListener('error', (event: Event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.postMediaImage !== 'true') return;
    const fallback = image.parentElement?.querySelector<HTMLElement>('.post-image-media-fallback, .profile-media-image-fallback, .image-viewer-media-fallback');
    const showFallback = (): void => {
      image.hidden = true;
      if (fallback) fallback.hidden = false;
      const tile = image.closest<HTMLElement>('.post-image, .post-image-carousel-item, .profile-media-tile');
      if (tile) tile.dataset.mediaUnavailable = 'true';
    };
    if (image.dataset.mediaResolutionAttempted === 'true') {
      showFallback();
      return;
    }
    const postId = image.dataset.postId || '';
    const sourceURL = image.dataset.mediaSource || image.getAttribute('src') || '';
    const index = Number(image.dataset.mediaIndex || 0);
    if (!postId || !sourceURL) {
      showFallback();
      return;
    }
    image.dataset.mediaResolutionAttempted = 'true';
    void prefetchPostMediaURL(postId, sourceURL, 'image', index).then((resolvedURL) => {
      if (!image.isConnected) return;
      const resolved = new URL(resolvedURL, window.location.origin).href;
      const original = new URL(sourceURL, window.location.origin).href;
      if (resolved === original) {
        showFallback();
        return;
      }
      image.dataset.resolvedSrc = resolvedURL;
      image.src = resolvedURL;
      image.closest<AppDomElement>('[data-action="open-image"]')?.setAttribute('data-image-url', resolvedURL);
    }).catch(() => {
      if (image.isConnected) showFallback();
      console.warn('[Connect] post image source resolution failed', { postId, index });
    });
  }, true);
}

async function handleRepostToggle(btn: AppDomElement): Promise<void> {
  if (btn.disabled) return;
  const currentUser = getState('user');
  if (!currentUser) { showAppToast(t('ログインが必要です'), 'error'); return; }
  const postId = btn.dataset.postId;
  const card = btn.closest('.post-card');
  const post = postId ? feedState.posts.find(item => item.id === postId) : null;
  const wasReposted = btn.classList.contains('reposted');
  const countEl = card?.querySelector<AppDomElement>('.repost-count');
  const beforeCount = parseInt(countEl?.textContent || '0') || 0;
  btn.disabled = true;
  btn.classList.toggle('reposted', !wasReposted);
  btn.querySelector<AppDomElement>('.action-label').textContent = wasReposted ? t('リポスト') : t('リポスト済み');
  if (countEl) countEl.textContent = String(wasReposted ? Math.max(0, beforeCount - 1) : beforeCount + 1);
  try {
    if (!postId) return;
    const result = await toggleRepost(postId, currentUser.uid);
    btn.classList.toggle('reposted', result.reposted);
    btn.querySelector<AppDomElement>('.action-label').textContent = result.reposted ? t('リポスト済み') : t('リポスト');
    if (result.reposted && result.eventId && post?.userId && post.userId !== currentUser.uid) {
      void createNotification({
        userId: post.userId,
        type: 'repost',
        fromUserId: currentUser.uid,
        postId,
        eventId: result.eventId,
      }).catch((): void => {});
    }
  } catch (error) {
    btn.classList.toggle('reposted', wasReposted);
    btn.querySelector<AppDomElement>('.action-label').textContent = wasReposted ? t('リポスト済み') : t('リポスト');
    if (countEl) countEl.textContent = String(beforeCount);
    showAppToast(`${t('リポストに失敗しました')}: ${getFirebaseErrorMessage(error)}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

type PostActionMenuItem = { action: string; icon: string; label: string };
type ManagedPostActionMenu = HTMLElement & { closePostActionMenu?: () => void };

function closePostActionMenus(): void {
  document.querySelectorAll<ManagedPostActionMenu>('.post-action-menu').forEach(menu => {
    if (menu.closePostActionMenu) menu.closePostActionMenu();
    else menu.remove();
  });
}

function openPostActionMenu(
  anchorBtn: AppDomElement,
  menuClass: string,
  items: readonly PostActionMenuItem[],
  onSelect: (action: string) => void | Promise<void>,
): void {
  closePostActionMenus();
  const menu = document.createElement('div') as ManagedPostActionMenu;
  const menuId = `post-action-menu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rect = anchorBtn.getBoundingClientRect();
  const estimatedWidth = 212;
  const estimatedHeight = Math.max(64, items.length * 52 + 16);
  let closed = false;

  menu.id = menuId;
  menu.className = `post-action-menu ${menuClass}`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('投稿の操作'));
  menu.style.left = `${Math.min(window.innerWidth - estimatedWidth - 10, Math.max(10, rect.left))}px`;
  menu.style.top = `${Math.min(window.innerHeight - estimatedHeight - 10, rect.bottom + 8)}px`;
  menu.innerHTML = items.map(item => `
    <button type="button" role="menuitem" data-post-menu-action="${escapeHtml(item.action)}">
      <span aria-hidden="true">${escapeHtml(item.icon)}</span>${escapeHtml(item.label)}
    </button>
  `).join('');
  anchorBtn.setAttribute('aria-expanded', 'true');
  anchorBtn.setAttribute('aria-controls', menuId);

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    anchorBtn.setAttribute('aria-expanded', 'false');
    anchorBtn.removeAttribute('aria-controls');
    menu.remove();
  };
  const onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && (menu.contains(target) || anchorBtn.contains(target))) return;
    close();
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    anchorBtn.focus({ preventScroll: true });
  };

  menu.closePostActionMenu = close;
  menu.addEventListener('click', event => {
    const target = event.target;
    const action = target instanceof Element ? target.closest<HTMLElement>('[data-post-menu-action]')?.dataset.postMenuAction : '';
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    void onSelect(action);
  });
  document.body.appendChild(menu);
  requestAnimationFrame(() => {
    if (closed) return;
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  });
}

function openRepostActionMenu(anchorBtn: AppDomElement): void {
  const postId = anchorBtn.dataset.postId || '';
  if (!postId) return;
  const reposted = anchorBtn.classList.contains('reposted');
  openPostActionMenu(anchorBtn, 'repost-action-menu', [
    {
      action: reposted ? 'undo-repost' : 'repost',
      icon: reposted ? '↩' : '↪',
      label: reposted ? t('リポストを取り消す') : t('リポスト'),
    },
    { action: 'quote', icon: '✎', label: t('引用する') },
  ], async action => {
    if (action === 'quote') {
      await openQuoteRepostModal(postId);
      return;
    }
    await handleRepostToggle(anchorBtn);
  });
}

function openShareActionMenu(anchorBtn: AppDomElement): void {
  const postId = anchorBtn.dataset.postId || '';
  if (!postId) return;
  openPostActionMenu(anchorBtn, 'share-action-menu', [
    { action: 'share', icon: '↗', label: t('共有') },
    { action: 'copy', icon: '🔗', label: t('リンクをコピー') },
  ], async action => {
    if (action === 'share') {
      await sharePostLink(postId);
      return;
    }
    if (await copyTextToClipboard(buildPostDetailUrl(postId))) showAppToast(t('投稿リンクをコピーしました'), 'success');
    else showAppToast(t('投稿リンクをコピーできませんでした'), 'error');
  });
}

async function openLikesModal(postId: string): Promise<void> {
  const modalId = 'likes-modal';
  closeModalById(modalId);
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="${modalId}" role="dialog" aria-modal="true">
      <div class="modal-container likes-modal-container">
        <div class="modal-header"><h3 class="modal-title">${t('いいねしたユーザー')}</h3><button type="button" class="modal-close" id="likes-modal-close" aria-label="${t('閉じる')}">&times;</button></div>
        <div class="modal-body" id="likes-modal-body">${renderLoadingSpinner()}</div>
      </div>
    </div>
  `);
  const body = getEl('likes-modal-body');
  getEl('likes-modal-close')?.addEventListener('click', () => closeModalById(modalId));
  getEl(modalId)?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModalById(modalId); });
  try {
    const likes = await getLikes(postId);
    const profilesById = await getDisplayUserProfilesByIds(likes.map((like) => like.userId));
    const profiles = likes.map((like): RenderProfile | null => toRenderProfile(profilesById[like.userId]));
    const users = profiles.filter((user): user is RenderProfile => !!user);
    body.innerHTML = users.length ? `
      <div class="like-user-list">
        ${users.map(user => `<a class="like-user-row" href="#/profile/${encodeURIComponent(user.uid)}"><span>${createAvatarHTML(user, 40)}</span><strong>${escapeHtml(user.displayName || user.username || t('ユーザー'))}</strong><small>@${escapeHtml(user.username || '')}</small></a>`).join('')}
      </div>
    ` : renderEmptyState(t('まだいいねはありません'), '♡');
  } catch (error) {
    body.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}
export function setupPostEventListeners(container: HTMLElement | null): void {
  if (!container) return;
  bindPostMediaImageResolver();
  void setupAskAiButtons(container);
  container.querySelectorAll<AppDomElement>('.post-video, .post-video video, [data-no-open]').forEach(el => {
    el.addEventListener('click', (e) => {
      const target = e.target;
      if (target instanceof Element && target.closest('[data-action="load-video"]')) return;
      e.stopPropagation();
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  });

  setupImageOpenListeners(container);
  setupPostVideoPlayback(container);

  container.querySelectorAll<AppDomElement>('[data-action="share-menu"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openShareActionMenu(btn);
    });
  });

  // いいね
  container.querySelectorAll<AppDomElement>('[data-action="like"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const currentUser = getState('user');
      if (!currentUser) { showAppToast(t('ログインが必要です'), 'error'); return; }
      const postId = btn.dataset.postId || '';
      if (!postId) return;
      const cards = postCardsFor(postId);
      const firstCard = cards[0] || btn.closest('.post-card');
      const firstCountEl = firstCard?.querySelector<AppDomElement>('.like-count');
      const knownState = postReactionState.get(postId);
      const wasLiked = knownState?.liked ?? btn.classList.contains('liked');
      const beforeCount = knownState?.likesCount ?? (parseInt(firstCountEl?.textContent || '0') || 0);
      const nextLiked = !wasLiked;
      const optimisticCount = Math.max(0, beforeCount + (nextLiked ? 1 : -1));
      applyPostLikeState(postId, nextLiked, optimisticCount, true);
      let result: Awaited<ReturnType<typeof toggleLike>>;
      try {
        result = await toggleLike(postId, currentUser.uid, nextLiked);
      } catch (error) {
        applyPostLikeState(postId, wasLiked, beforeCount);
        showAppToast(`${t('いいねに失敗しました')}: ${getFirebaseErrorMessage(error)}`, 'error');
        return;
      }
      const finalLiked = result.liked;
      const canonicalCount = Number.isFinite(result.likesCount) ? result.likesCount : optimisticCount;
      applyPostLikeState(postId, finalLiked, canonicalCount);
      if (result.liked) {
        // Notification delivery is best-effort and must not roll back the
        // reaction after the server has already confirmed it.
        void (async () => {
          const post = feedState.posts.find(p => p.id === postId);
          const notificationPost = post || await getPostById(postId).catch((): null => null);
          if (notificationPost && notificationPost.userId !== currentUser.uid) {
            await createNotification({
              userId: notificationPost.userId,
              type: 'like',
              fromUserId: currentUser.uid,
              postId,
              eventId: result.eventId,
              context: (notificationPost.imageURLs || []).length ? 'photo' : '',
            });
          }
        })().catch(error => console.error('Like notification failed:', error));
      }
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="comment"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const postId = btn.dataset.postId;
      openCommentModal(postId);
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="view-likes"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.postId) openLikesModal(btn.dataset.postId);
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="bookmark"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentUser = getState('user');
      if (!currentUser) { showAppToast(t('ログインが必要です'), 'error'); return; }
      const wasBookmarked = btn.classList.contains('bookmarked');
      btn.disabled = true;
      btn.classList.toggle('bookmarked', !wasBookmarked);
      btn.querySelector<AppDomElement>('.action-icon').textContent = wasBookmarked ? '📑' : '🔖';
      btn.querySelector<AppDomElement>('.action-label').textContent = wasBookmarked ? t('ブックマーク') : t('ブックマーク済み');
      try {
        const result = await toggleBookmark(btn.dataset.postId, currentUser.uid);
        btn.classList.toggle('bookmarked', result.bookmarked);
        btn.querySelector<AppDomElement>('.action-icon').textContent = result.bookmarked ? '🔖' : '📑';
        btn.querySelector<AppDomElement>('.action-label').textContent = result.bookmarked ? t('ブックマーク済み') : t('ブックマーク');
      } catch (error) {
        btn.classList.toggle('bookmarked', wasBookmarked);
        btn.querySelector<AppDomElement>('.action-icon').textContent = wasBookmarked ? '🔖' : '📑';
        btn.querySelector<AppDomElement>('.action-label').textContent = wasBookmarked ? t('ブックマーク済み') : t('ブックマーク');
        showAppToast(`${t('ブックマークに失敗しました')}: ${getFirebaseErrorMessage(error)}`, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="repost-menu"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRepostActionMenu(btn);
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="delete-post"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('この投稿を削除してもよろしいですか？'))) return;
      const postId = btn.dataset.postId;
      await deletePost(postId);
      const card = btn.closest('.post-card');
      if (card instanceof HTMLElement) card.style.display = 'none';
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="post-text-more"]').forEach(link => {
    if (link.dataset.moreBound === 'true') return;
    link.dataset.moreBound = 'true';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const parentCard = link.closest('.post-card') as HTMLElement | null;
      const postId = link.dataset.postId || parentCard?.dataset.postId;
      if (postId) window.location.hash = `#/post/${postId}`;
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="open-post"]').forEach(el => {
    el.addEventListener('click', (e) => {
      const target = e.target;
      if (target instanceof Element && (target.closest('button') || target.closest('a') || target.closest('.poll-option') || target.closest('[data-no-open]') || target.closest('video'))) return;
      const parentPost = el.closest('[data-post-id]') as HTMLElement | null;
      const postId = el.dataset.postId || parentPost?.dataset.postId;
      if (postId) {
        window.location.hash = '#/post/' + postId;
      }
    });
  });


  container.querySelectorAll<AppDomElement>('.poll-option').forEach(opt => {
    opt.addEventListener('click', async () => {
      const currentUser = getState('user');
      if (!currentUser) return;
      const pc = opt.closest('.poll-container') as HTMLElement | null;
      if (!pc) return;
      const postId = pc.dataset.postId;
      const optionIndex = parseInt(opt.dataset.option);
      try {
        const updatedPoll = await votePoll(postId, optionIndex, currentUser.uid);
        if (updatedPoll) {
          pc.outerHTML = renderPoll(updatedPoll as Parameters<typeof renderPoll>[0], postId, currentUser.uid);
        } else {
          opt.classList.add('poll-voted');
          pc.querySelectorAll<AppDomElement>('.poll-option').forEach(o => o.style.pointerEvents = 'none');
        }
      } catch (e) {
        showAppToast(`${t('投票に失敗しました')}: ${getFirebaseErrorMessage(e)}`, 'error');
      }
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="report-post"]').forEach(btn => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentUser = auth.currentUser;
      if (!currentUser) { showAppToast(t('ログインが必要です'), 'error'); return; }
      const answer = window.prompt('報告理由を選んでください：\n1. スパム\n2. 嫌がらせ\n3. 違法コンテンツ\n4. その他', '1');
      if (answer === null) return;
      const reason = ({ '1': 'spam', '2': 'harassment', '3': 'illegal', '4': 'other' } as Record<string, string>)[answer.trim()];
      if (!reason) { showAppToast('1〜4の番号を入力してください', 'error'); return; }
      btn.disabled = true;
      try {
        const response = await fetch(`/api/posts/${encodeURIComponent(btn.dataset.postId || '')}/report`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await currentUser.getIdToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
          cache: 'no-store',
        });
        const payload = await response.json().catch((): Record<string, unknown> => ({}));
        if (response.status === 409 && payload.error === 'already_reported') {
          showAppToast('この投稿はすでに報告済みです', 'info');
        } else if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'report_failed');
        } else {
          showAppToast('投稿を報告しました', 'success');
          btn.remove();
        }
      } catch {
        showAppToast('投稿を報告できませんでした。しばらくしてから再試行してください', 'error');
        btn.disabled = false;
      }
    });
  });

  container.querySelectorAll<AppDomElement>('.post-author').forEach(link => {
    if (link.dataset.profileClickBound === 'true') return;
    link.dataset.profileClickBound = 'true';
    link.addEventListener('click', () => {
      const parentCard = link.closest('.post-card') as HTMLElement | null;
      const postId = parentCard?.dataset.postId;
      if (postId) recordPostProfileClick(postId, getState('user')?.uid || '').catch(() => {});
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="edit-post"]').forEach(btn => {
    if (btn.dataset.editBound === 'true') return;
    btn.dataset.editBound = 'true';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditPostModal(btn.dataset.postId);
    });
  });

  container.querySelectorAll<AppDomElement>('[data-action="post-insights"]').forEach(btn => {
    if (btn.dataset.insightBound === 'true') return;
    btn.dataset.insightBound = 'true';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const post = btn.dataset.postId ? await getPostById(btn.dataset.postId).catch((_error: unknown): null => null) : null;
      if (post) openPostInsightsModal(post);
    });
  });

  if (container.isConnected) recordVisiblePostViews(container);
}

function openPostInsightsModal(post: FeedPostViewModel): void {
  const currentUser = getState('user');
  if (!currentUser || post.userId !== currentUser.uid) return;
  const modalId = 'post-insights-modal';
  closeModalById(modalId);
  const html = `
    <div class="modal-overlay" id="${modalId}" role="dialog" aria-modal="true">
      <div class="modal-container">
        <div class="modal-header">
          <h3 class="modal-title">${t('投稿インサイト')}</h3>
          <button type="button" class="modal-close" id="post-insights-close" aria-label="${t('閉じる')}">&times;</button>
        </div>
        <div class="modal-body">
          <div class="insight-grid">
            <div><strong>${post.viewCount || 0}</strong><span>${t('表示回数')}</span></div>
            <div><strong>${post.likesCount || 0}</strong><span>${t('いいね')}</span></div>
            <div><strong>${post.commentsCount || 0}</strong><span>${t('コメント')}</span></div>
            <div><strong>${post.repostsCount || 0}</strong><span>${t('リポスト')}</span></div>
            <div><strong>${post.profileClickCount || 0}</strong><span>${t('プロフィールクリック')}</span></div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  getEl('post-insights-close')?.addEventListener('click', () => closeModalById(modalId));
  getEl(modalId)?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModalById(modalId); });
}

async function openEditPostModal(postId: string): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser || !postId) return;
  const post = await getPostById(postId).catch((_error: unknown): null => null);
  if (!post || post.userId !== currentUser.uid) return;
  const modalId = 'edit-post-modal';
  closeModalById(modalId);
  const storedImageURLs = post.imageURLs || (post.imageURL ? [post.imageURL] : []);
  const attachmentImageURLs = Array.isArray(post.attachments)
    ? post.attachments.filter(attachment => attachment.kind === 'image' && attachment.url).map(attachment => attachment.url)
    : [];
  // Rendering prefers image attachments when present, so use the same order
  // here. This keeps every ALT input matched to the image a reader sees.
  const images = attachmentImageURLs.length ? attachmentImageURLs : storedImageURLs;
  const imageAlts = images.map((_, index) => String(post.imageAlts?.[index] || '').slice(0, 280));
  const scheduledAtValue = post.scheduledAt;
  const scheduled = scheduledAtValue && typeof scheduledAtValue === 'object' && 'toDate' in scheduledAtValue && typeof scheduledAtValue.toDate === 'function' ? scheduledAtValue.toDate() : null;
  const scheduledValue = scheduled ? new Date(scheduled.getTime() - scheduled.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  const currentContentKind = getPostContentKind(post);
  const aiConsent = await getPostAiConsent(postId).catch((): null => null);
  const aiConsentDisabled = !aiConsent || aiConsent.globalDisabled;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="${modalId}" role="dialog" aria-modal="true">
      <div class="modal-container">
        <div class="modal-header">
          <h3 class="modal-title">${t('投稿を編集')}</h3>
          <button type="button" class="modal-close" id="edit-post-close" aria-label="${t('閉じる')}">&times;</button>
        </div>
        <div class="modal-body">
          <textarea class="form-input" id="edit-post-text" rows="5" maxlength="1000">${escapeHtml(post.text || '')}</textarea>
          <label>${t('公開範囲')}<select id="edit-post-visibility" class="form-input"><option value="public">${t('全体公開')}</option><option value="friends">${t('友達のみ')}</option><option value="private">${t('自分のみ')}</option></select></label>
          <label>投稿の種類<select id="edit-post-content-kind" class="form-input"><option value="user" ${currentContentKind === 'user' ? 'selected' : ''}>ユーザー投稿</option><option value="news" ${currentContentKind === 'news' ? 'selected' : ''}>ニュース</option><option value="advertisement" ${currentContentKind === 'advertisement' ? 'selected' : ''}>広告 / PR</option><option value="system" ${currentContentKind === 'system' ? 'selected' : ''}>システム画面</option><option value="unclassified" ${currentContentKind === 'unclassified' ? 'selected' : ''}>分類未設定</option></select></label>
          <fieldset class="edit-post-ai-consent">
            <legend>Ask AI</legend>
            <label><input type="checkbox" id="edit-post-ai-consent-toggle" ${aiConsent?.enabled ? 'checked' : ''} ${aiConsentDisabled ? 'disabled' : ''}> この投稿をAIで分析できるようにする</label>
            <p class="muted-small">有効にすると、この投稿を閲覧できるユーザーの質問に答えるため、投稿本文と許可した画像がOpenRouterへ送信されます。</p>
            <p class="muted-small" id="edit-post-ai-consent-status">${!aiConsent ? 'AI分析の設定を取得できませんでした。再読み込みして再試行してください。' : aiConsent.globalDisabled ? 'アカウントのAI分析設定が「許可しない」のため、先に設定を変更してください。' : ''}</p>
          </fieldset>
          <label>${t('予約')}<input type="datetime-local" id="edit-post-scheduled" class="form-input" value="${escapeHtml(scheduledValue)}"></label>
          <div class="edit-media-note">${images.length ? `${t('現在の画像')}: ${images.length}${t('枚')}` : ''} ${post.videoURL ? t('動画あり') : ''}</div>
          ${images.length ? `<fieldset class="edit-post-image-alts" id="edit-post-image-alts"><legend>${t('画像の代替テキスト')}</legend><p class="muted-small">${t('画像ごとの内容説明は、スクリーンリーダー利用者にも表示されます。')}</p>${images.map((url, index) => `<label class="edit-post-image-alt-row" for="edit-post-image-alt-${index}"><img src="${escapeHtml(url)}" alt="" aria-hidden="true"><span>${t('画像')} ${index + 1}</span><input id="edit-post-image-alt-${index}" class="form-input edit-post-image-alt-input" type="text" maxlength="280" value="${escapeHtml(imageAlts[index])}" placeholder="${t('画像説明を入力')}"></label>`).join('')}</fieldset>` : ''}
          <input type="file" id="edit-post-images" multiple>
          <input type="file" id="edit-post-video">
          <div id="edit-post-status" class="post-submit-status hidden"></div>
          <button type="button" class="btn btn-primary" id="edit-post-save">${t('変更を保存')}</button>
        </div>
      </div>
    </div>`);
  const visibility = getEl('edit-post-visibility');
  if (visibility) visibility.value = post.visibility || 'public';
  setupMentionSuggest(getEl('edit-post-text'));
  const close = () => closeModalById(modalId);
  getEl('edit-post-close')?.addEventListener('click', close);
  getEl(modalId)?.addEventListener('click', (e) => { if (e.target === e.currentTarget) close(); });
  getEl('edit-post-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!(btn instanceof HTMLButtonElement)) return;
    const status = getEl('edit-post-status');
    btn.disabled = true;
    try {
      let imageURLs = [...storedImageURLs];
      let nextImageAlts = Array.from(document.querySelectorAll<HTMLInputElement>('#edit-post-image-alts .edit-post-image-alt-input'))
        .map(input => input.value.trim().slice(0, 280));
      let nextAttachments = Array.isArray(post.attachments) ? [...post.attachments] : [];
      let mediaChanged = false;
      const imgFiles = Array.from(getEl('edit-post-images')?.files || []);
      if (imgFiles.length) {
        mediaChanged = true;
        imageURLs = [];
        nextImageAlts = [];
        nextAttachments = nextAttachments.filter(item => item.kind !== 'image');
        for (const [index, file] of imgFiles.slice(0, 4).entries()) {
          const mimeType = await sniffAttachmentMimeType(file);
          if (!mimeType.startsWith('image/')) continue;
          status.textContent = `${t('画像をアップロード中...')} ${index + 1}`;
          status.classList.remove('hidden');
          const attachment = await uploadAttachmentFile(file, createPostMediaStoragePath(currentUser.uid, file, 'image'));
          imageURLs.push(attachment.url);
          nextAttachments.push(attachment);
          nextImageAlts.push(mimeType === 'image/gif' ? 'GIF' : '');
        }
      }
      let videoURL = post.videoURL || '';
      const videoFile = getEl('edit-post-video')?.files?.[0];
      const videoMimeType = videoFile ? await sniffAttachmentMimeType(videoFile) : '';
      if (videoFile && videoMimeType.startsWith('video/')) {
        mediaChanged = true;
        status.textContent = t('動画をアップロード中...');
        status.classList.remove('hidden');
        const attachment = await uploadAttachmentFile(videoFile, createPostMediaStoragePath(currentUser.uid, videoFile, 'video'));
        videoURL = attachment.url;
        nextAttachments = nextAttachments.filter(item => item.kind !== 'video');
        nextAttachments.push(attachment);
      }
      const scheduledInput = getEl('edit-post-scheduled')?.value || '';
      await updatePost(postId, currentUser.uid, {
        contentType: (getEl('edit-post-content-kind')?.value || 'user') as 'user' | 'news' | 'advertisement' | 'system' | 'unclassified',
        text: getEl('edit-post-text')?.value || '',
        imageURLs,
        imageAlts: nextImageAlts,
        ...(mediaChanged ? { attachments: nextAttachments } : {}),
        videoURL,
        visibility: visibility?.value || 'public',
        scheduledAt: scheduledInput ? new Date(scheduledInput) : null,
      });
      const aiConsentToggle = getEl('edit-post-ai-consent-toggle') as HTMLInputElement | null;
      if (aiConsent && !aiConsent.globalDisabled && aiConsentToggle && !aiConsentToggle.disabled) {
        await setPostAiConsent(postId, aiConsentToggle.checked);
      }
      showAppToast(t('投稿を更新しました'), 'success');
      close();
      if (window.location.hash.includes('/post/')) refreshPostDetailPage(postId);
      else renderFeedPage();
    } catch (error) {
      showAppToast(`${t('更新に失敗しました')}: ${getFirebaseErrorMessage(error)}`, 'error');
      btn.disabled = false;
    }
  });
}

async function openQuoteRepostModal(postId: string): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser) return;
  const modalId = 'quote-repost-modal';
  closeModalById(modalId);
  const html = `
    <div class="modal-overlay" id="${modalId}" role="dialog" aria-modal="true" aria-label="${t('引用リポスト')}">
      <div class="modal-container quote-repost-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${t('引用リポスト')}</h3>
          <button type="button" class="modal-close" id="quote-repost-close" aria-label="${t('閉じる')}">&times;</button>
        </div>
        <div class="modal-body">
          <textarea class="form-input quote-repost-textarea" id="quote-repost-text" rows="4" maxlength="1000" placeholder="${t('コメントを追加して引用')}..."></textarea>
          <div class="quote-repost-toolbar">
            <div class="quote-repost-media-actions">
              <input type="file" id="quote-repost-image-file" multiple style="display:none">
              <button class="create-post-option quote-repost-media-btn" id="quote-repost-add-image" type="button" aria-label="${t('画像を添付')}">📷 <span>${t('画像')}</span></button>
              <input type="file" id="quote-repost-video-file" style="display:none">
              <button class="create-post-option quote-repost-media-btn" id="quote-repost-add-video" type="button" aria-label="${t('動画を添付')}">🎬 <span>${t('動画')}</span></button>
            </div>
            <div class="quote-repost-count" id="quote-repost-count">0/1000</div>
          </div>
          <div id="quote-repost-image-previews" class="post-image-previews quote-repost-attachments"></div>
          <div id="quote-repost-video-preview" class="post-video-preview quote-repost-video-preview hidden">
            <video id="quote-repost-video-preview-video" controls preload="none" playsinline></video>
            <button class="preview-remove-btn" id="quote-repost-video-remove" type="button">✕</button>
          </div>
          <div id="quote-repost-status" class="post-submit-status hidden" role="status" aria-live="polite"></div>
          <div id="quote-repost-preview">${renderLoadingSpinner()}</div>
          <div class="quote-repost-actions">
            <button class="btn btn-secondary" id="quote-repost-cancel">${t('キャンセル')}</button>
            <button class="btn btn-primary" id="quote-repost-submit">${t('引用して投稿')}</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.body.classList.add('quote-repost-modal-open');
  let selectedImages: File[] = [];
  let selectedGifUrls: string[] = [];
  let selectedVideoFile: File | null = null;
  const hasQuoteDraftContent = () => !!((getEl('quote-repost-text')?.value || '').trim() || selectedImages.length || selectedGifUrls.length || selectedVideoFile);
  const saveQuoteDraft = () => savePostDraft(currentUser.uid, {
    text: getEl('quote-repost-text')?.value || '',
    quotedPostId: postId,
    imageNames: selectedImages.map(file => file.name),
    gifUrls: [...selectedGifUrls],
    videoName: selectedVideoFile?.name || '',
      });
  const close = (ask = false) => {
    if (ask && hasQuoteDraftContent()) {
      const save = confirm(`${t('下書き保存しますか？')}\nOK: ${t('下書き保存')} / キャンセル: ${t('破棄')}`);
      if (save) {
        saveQuoteDraft();
        showAppToast(t('下書きを保存しました'), 'success');
      }
    }
    closeModalById(modalId);
    document.body.classList.remove('quote-repost-modal-open');
  };
  getEl('quote-repost-close')?.addEventListener('click', () => close(true));
  getEl('quote-repost-cancel')?.addEventListener('click', () => close(true));
  getEl(modalId)?.addEventListener('click', (e) => { if (e.target === e.currentTarget) close(); });
  const textarea = getEl('quote-repost-text');
  const count = getEl('quote-repost-count');
  textarea?.addEventListener('input', () => { if (count) count.textContent = textarea.value.length + '/1000'; });
  const imageInput = getEl('quote-repost-image-file');
  const videoInput = getEl('quote-repost-video-file');
  const imagePreviews = getEl('quote-repost-image-previews');
  const videoPreview = getEl('quote-repost-video-preview');
  const videoPreviewVideo = getEl('quote-repost-video-preview-video');
  const statusEl = getEl('quote-repost-status');
  const setQuoteStatus = (message = '', visible = false) => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('hidden', !visible);
  };
  const renderQuoteImagePreviews = () => {
    if (!imagePreviews) return;
    const localItems = selectedImages.map((file, i) => ({ kind: 'file', index: i, url: URL.createObjectURL(file), label: resolveAttachmentMimeType(file) === 'image/gif' ? 'GIF' : '' }));
    const gifItems = selectedGifUrls.map((url, i) => ({ kind: 'gif-url', index: i, url, label: 'GIF' }));
    imagePreviews.innerHTML = [...localItems, ...gifItems].map(item => {
      return `<div class="image-preview-item"><img src="${escapeHtml(item.url)}" alt=""><button class="preview-remove-btn" type="button" data-preview-kind="${item.kind}" data-preview-index="${item.index}">✕</button>${item.label ? `<span class="preview-media-badge">${item.label}</span>` : ''}</div>`;
    }).join('');
    imagePreviews.querySelectorAll<AppDomElement>('[data-preview-index]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.previewKind === 'gif-url') selectedGifUrls.splice(Number(btn.dataset.previewIndex), 1);
        else selectedImages.splice(Number(btn.dataset.previewIndex), 1);
        renderQuoteImagePreviews();
      });
    });
  };
  getEl('quote-repost-add-image')?.addEventListener('click', () => imageInput?.click());
  getEl('quote-repost-add-video')?.addEventListener('click', () => videoInput?.click());
  imageInput?.addEventListener('change', async () => {
    const files = Array.from(imageInput.files || []);
    for (const file of files) {
      await sniffAttachmentMimeType(file);
      if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) {
        showAppToast(`${t('画像は')}${MAX_POST_IMAGE_COUNT}${t('枚までです')}`, 'error');
        break;
      }
      if (!resolveAttachmentMimeType(file).startsWith('image/')) {
        showAppToast(t('画像ファイルを選択してください'), 'error');
        continue;
      }
      if (!validateUploadFile(file, imageInput)) continue;
      selectedImages.push(file);
    }
    imageInput.value = '';
    renderQuoteImagePreviews();
  });
  videoInput?.addEventListener('change', async () => {
    const file = videoInput.files?.[0];
    if (!file) return;
    await sniffAttachmentMimeType(file);
    if (!resolveAttachmentMimeType(file).startsWith('video/')) {
      showAppToast(t('動画ファイルを選択してください'), 'error');
      videoInput.value = '';
      return;
    }
    if (!validateUploadFile(file, videoInput)) return;
    const duration = await getVideoDuration(file).catch(() => 0);
    if (duration && duration > MAX_VIDEO_UPLOAD_SECONDS) {
      showAppToast(`${t('動画は')} ${MAX_VIDEO_UPLOAD_SECONDS / 60}${t('分以内にしてください')}`, 'error');
      videoInput.value = '';
      return;
    }
    selectedVideoFile = file;
    if (videoPreviewVideo) videoPreviewVideo.src = URL.createObjectURL(file);
    videoPreview?.classList.remove('hidden');
  });
  getEl('quote-repost-video-remove')?.addEventListener('click', () => {
    selectedVideoFile = null;
    if (videoInput) videoInput.value = '';
    if (videoPreviewVideo) videoPreviewVideo.src = '';
    videoPreview?.classList.add('hidden');
  });
  const handleQuotePaste = (event: ClipboardEvent): void => {
    const items = Array.from(event.clipboardData?.items || []);
    const textPayload = event.clipboardData?.getData('text/plain') || '';
    const imageFiles = items
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    let added = false;
    for (const file of imageFiles) {
      if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) break;
      if (!validateUploadFile(file, imageInput)) continue;
      selectedImages.push(file);
      added = true;
    }
    for (const url of extractGifUrlsFromText(textPayload)) {
      const normalized = normalizeGifUrl(url);
      if (!normalized || selectedGifUrls.includes(normalized)) continue;
      if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) break;
      selectedGifUrls.push(normalized);
      added = true;
    }
    if (added) {
      event.preventDefault();
      renderQuoteImagePreviews();
      showAppToast(t('画像/GIFを添付しました'), 'success');
    }
  };
  textarea?.addEventListener('paste', handleQuotePaste);

  let original: FeedPostViewModel | null = null;
  try {
    original = await getPostById(postId);
    if (!original) throw new Error(t('引用元の投稿を表示できません'));
    original.author = await getDisplayUserProfile(original.userId || '').catch((_error: unknown): null => null);
    const preview = getEl('quote-repost-preview');
    if (preview) preview.innerHTML = renderPostCard(toRenderPost(original), toRenderProfile(original.author), false, false);
  } catch (e) {
    const preview = getEl('quote-repost-preview');
    if (preview) preview.innerHTML = '<div class="form-error">' + escapeHtml(e.message || getFirebaseErrorMessage(e)) + '</div>';
  }
  getEl('quote-repost-submit')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!(btn instanceof HTMLButtonElement)) return;
    const text = textarea?.value.trim() || '';
    btn.disabled = true;
    btn.textContent = t('投稿中...');
    try {
      const imageURLs = [];
      const attachments: Attachment[] = [];
      for (const [index, file] of selectedImages.entries()) {
        setQuoteStatus(`${t('画像をアップロード中...')} ${index + 1}/${selectedImages.length}`, true);
        const mimeType = await sniffAttachmentMimeType(file);
        if (!mimeType.startsWith('image/')) throw new Error('unsupported_image_file');
        const path = createPostMediaStoragePath(currentUser.uid, file, 'image');
        const attachment = await uploadAttachmentFile(file, path);
        imageURLs.push(attachment.url);
        attachments.push(attachment);
      }
      imageURLs.push(...selectedGifUrls);
      let videoURL = '';
      if (selectedVideoFile) {
        setQuoteStatus(t('動画をアップロード中...'), true);
        const mimeType = await sniffAttachmentMimeType(selectedVideoFile);
        if (!mimeType.startsWith('video/')) throw new Error('unsupported_video_file');
        const path = createPostMediaStoragePath(currentUser.uid, selectedVideoFile, 'video');
        const attachment = await uploadAttachmentFile(selectedVideoFile, path);
        videoURL = attachment.url;
        attachments.push(attachment);
      }
      setQuoteStatus(t('投稿を保存中...'), true);
      const quote = await createQuotePost({ userId: currentUser.uid, text, quotedPostId: postId, imageURLs, attachments, videoURL });
      quote.author = getState('userProfile');
      quote.liked = false;
      quote.reposted = false;
      if (feedState?.posts) { feedState.posts.unshift(quote); renderFeedPosts(); }
      if (original && original.userId !== currentUser.uid) {
        await createNotification({
          userId: original.userId,
          type: 'repost',
          fromUserId: currentUser.uid,
          postId,
          eventId: `quote-repost:${quote.id}`,
        });
      }
      showAppToast(t('引用リポストしました'), 'success');
      close(false);
    } catch (error) {
      setQuoteStatus('', false);
      showAppToast(t('引用リポストに失敗しました') + ': ' + getFirebaseErrorMessage(error), 'error');
      btn.disabled = false;
      btn.textContent = t('引用して投稿');
    }
  });
  setTimeout(() => textarea?.focus(), 50);
}

function setupPostCreation() {
  const textarea = getEl('create-post-textarea');
  const submitBtn = getEl('submit-post');
  const addThreadBtn = getEl('btn-add-to-thread');
  if (!textarea || !submitBtn) return;
  const currentUser = getState('user');
  if (!currentUser) return;

  const charCount = document.querySelector<AppDomElement>('.post-char-count');
  const statusEl = getEl('post-submit-status');
  const retryBox = getEl('post-retry-box');
  const retryMessage = getEl('post-retry-message');
  const retryBtn = getEl('post-retry-btn');
  const composerFab = getEl('composer-fab');
  const expandBtn = getEl('create-post-expand');
  const fullscreenModal = getEl('composer-fullscreen');
  const fullscreenTextarea = getEl('composer-fullscreen-textarea');
  const fullscreenCount = getEl('composer-fullscreen-count');
  const fullscreenSubmitBtn = getEl('composer-fullscreen-submit');
  const fullscreenMediaBtn = getEl('composer-fullscreen-add-media');
  const fullscreenPreviewsDiv = getEl('composer-fullscreen-image-previews');
  const fullscreenVideoPreviewDiv = getEl('composer-fullscreen-video-preview');
  const fullscreenVideoPreviewVideo = getEl('composer-fullscreen-video-preview-video');
  const fullscreenVideoRemoveBtn = getEl('composer-fullscreen-video-preview-remove');
  const visibilityInput = getEl('post-visibility');
  const contentKindInput = getEl('post-content-kind');
  const scheduledInput = getEl('post-scheduled-at');
  const fullscreenVisibilityInput = getEl('composer-fullscreen-visibility');
  const fullscreenContentKindInput = getEl('composer-fullscreen-content-kind');
  const fullscreenScheduledInput = getEl('composer-fullscreen-scheduled-at');
  const pollToggleBtn = getEl('composer-toggle-poll');
  const pollFields = getEl('composer-poll-fields');
  const pollQuestionInput = getEl('composer-poll-question');
  const pollOptionInputs = Array.from(document.querySelectorAll<AppDomElement>('.composer-poll-option'));
  const pollExpiryInput = getEl('composer-poll-expiry');
  const threadListEl = getEl('composer-thread-list');
  const addThreadItemBtn = getEl('composer-add-thread-item');
  const fullscreenCloseBtns = [
    getEl('composer-fullscreen-close'),
    getEl('composer-fullscreen-cancel'),
    getEl('composer-fullscreen-backdrop'),
  ].filter(Boolean);
  let composerFullscreenOpen = false;
  let selectedImages: File[] = [];
  let selectedGifUrls: string[] = [];
  let selectedImageAlts: string[] = [];
  let selectedVideoFile: File | null = null;
  let selectedThreadTexts: string[] = [];
  let currentThreadId = '';
  let lastFailedPost: { text?: string; images?: File[]; gifUrls?: string[]; imageAlts?: string[]; video?: File | null; poll?: Poll | null; isThread?: boolean; threadTexts?: string[] } | null = null;
  let activeDraftId = getDraftFromHash();
  let draftQuotedPostId = '';
  const defaultVisibility = localStorage.getItem(`connect_default_visibility_${currentUser.uid}`) || 'public';
  if (visibilityInput && !activeDraftId) visibilityInput.value = defaultVisibility;
  if (fullscreenVisibilityInput && !activeDraftId) fullscreenVisibilityInput.value = defaultVisibility;

  setupMentionSuggest(textarea);
  setupMentionSuggest(fullscreenTextarea);

  function getPollDraft() {
    if (!pollFields || pollFields.classList.contains('hidden')) return null;
    const question = (pollQuestionInput?.value || '').trim();
    const options = pollOptionInputs.map(input => input.value.trim()).filter(Boolean).slice(0, 4);
    if (!question || options.length < 2) return null;
    const hours = Math.max(1, Number(pollExpiryInput?.value || 24));
    return {
      question,
      options: options.map(text => ({ text })),
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    };
  }

  function renderThreadInputs() {
    if (!threadListEl) return;
    threadListEl.innerHTML = selectedThreadTexts.map((value, index) => `
      <div class="composer-thread-item">
        <span class="composer-thread-index">${index + 2}</span>
        <textarea class="form-input composer-thread-textarea" data-thread-index="${index}" maxlength="1000" placeholder="${t('続きのポスト')} ${index + 2}">${escapeHtml(value)}</textarea>
        <button type="button" class="preview-remove-btn composer-thread-remove" data-thread-remove="${index}" aria-label="${t('削除')}">×</button>
      </div>
    `).join('');
    threadListEl.querySelectorAll<AppDomElement>('.composer-thread-textarea').forEach(input => {
      input.addEventListener('input', () => {
        selectedThreadTexts[Number(input.dataset.threadIndex)] = input.value.slice(0, 1000);
        updatePostFormState();
        persistCurrentDraft(true);
      });
    });
    threadListEl.querySelectorAll<AppDomElement>('[data-thread-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedThreadTexts.splice(Number(btn.dataset.threadRemove), 1);
        renderThreadInputs();
        updatePostFormState();
        persistCurrentDraft(true);
      });
    });
  }

  const updatePostFormState = () => {
    const len = textarea.value.length;
    if (len > 1000) textarea.value = textarea.value.slice(0, 1000);
    const nextLen = textarea.value.length;
    if (charCount) {
      charCount.textContent = `${nextLen}/1000`;
      charCount.classList.toggle('warning', nextLen >= 850 && nextLen < 970);
      charCount.classList.toggle('danger', nextLen >= 970);
    }
    submitBtn.disabled = !(textarea.value.trim() || selectedImages.length > 0 || selectedGifUrls.length > 0 || selectedVideoFile || getPollDraft() || selectedThreadTexts.some(v => v.trim()));
    if (fullscreenCount) {
      fullscreenCount.textContent = `${nextLen}/1000`;
      fullscreenCount.classList.toggle('warning', nextLen >= 850 && nextLen < 970);
      fullscreenCount.classList.toggle('danger', nextLen >= 970);
    }
    if (fullscreenSubmitBtn) fullscreenSubmitBtn.disabled = submitBtn.disabled;
  };

  const syncAdvancedInputs = (fromFullscreen = false) => {
    const sourceVisibility = fromFullscreen ? fullscreenVisibilityInput : visibilityInput;
    const sourceScheduled = fromFullscreen ? fullscreenScheduledInput : scheduledInput;
    const targetVisibility = fromFullscreen ? visibilityInput : fullscreenVisibilityInput;
    const sourceContentKind = fromFullscreen ? fullscreenContentKindInput : contentKindInput;
    const targetContentKind = fromFullscreen ? contentKindInput : fullscreenContentKindInput;
    const targetScheduled = fromFullscreen ? scheduledInput : fullscreenScheduledInput;
    if (sourceVisibility && targetVisibility) targetVisibility.value = sourceVisibility.value;
    if (sourceContentKind && targetContentKind) targetContentKind.value = sourceContentKind.value;
    if (sourceScheduled && targetScheduled) targetScheduled.value = sourceScheduled.value;
  };

  visibilityInput?.addEventListener('change', () => syncAdvancedInputs(false));
  contentKindInput?.addEventListener('change', () => syncAdvancedInputs(false));
  scheduledInput?.addEventListener('change', () => syncAdvancedInputs(false));
  fullscreenVisibilityInput?.addEventListener('change', () => syncAdvancedInputs(true));
  fullscreenContentKindInput?.addEventListener('change', () => syncAdvancedInputs(true));
  fullscreenScheduledInput?.addEventListener('change', () => syncAdvancedInputs(true));

  const currentDraftPayload = () => ({
    id: activeDraftId,
    text: textarea.value || '',
    visibility: visibilityInput?.value || 'public',
    contentType: (contentKindInput?.value || 'user') as PostDraft['contentType'],
    scheduledAt: scheduledInput?.value || '',
    quotedPostId: draftQuotedPostId || '',
    imageNames: selectedImages.map(file => file.name),
    gifUrls: [...selectedGifUrls],
    videoName: selectedVideoFile?.name || '',
  });

  const hasDraftContent = () => !!(textarea.value.trim() || selectedImages.length || selectedGifUrls.length || selectedVideoFile || scheduledInput?.value || getPollDraft() || selectedThreadTexts.some(v => v.trim()));

  const persistCurrentDraft = (silent = true) => {
    if (!hasDraftContent()) return null;
    const saved = savePostDraft(currentUser.uid, currentDraftPayload());
    activeDraftId = saved?.id || activeDraftId;
    if (!silent) showAppToast(t('下書きを保存しました'), 'success');
    return saved;
  };

  const setSubmitStatus = (message = '', visible = false) => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('hidden', !visible);
  };

  const setRetryState = (message = '', visible = false) => {
    if (!retryBox) return;
    if (retryMessage) retryMessage.textContent = message;
    retryBox.classList.toggle('hidden', !visible);
  };

  function openComposerFullscreen() {
    if (!fullscreenModal || !fullscreenTextarea) return;
    fullscreenTextarea.value = textarea.value;
    fullscreenModal.classList.remove('hidden');
    document.body.classList.add('composer-fullscreen-open');
    composerFullscreenOpen = true;
    updatePostFormState();
    requestAnimationFrame(() => fullscreenTextarea.focus());
  }

  function closeComposerFullscreen(syncText = true) {
    if (!fullscreenModal) return;
    if (syncText && fullscreenTextarea) {
      textarea.value = fullscreenTextarea.value;
      updatePostFormState();
    }
    fullscreenModal.classList.add('hidden');
    document.body.classList.remove('composer-fullscreen-open');
    composerFullscreenOpen = false;
    textarea.focus();
  }

  function requestCloseComposer() {
    if (!hasDraftContent()) return closeComposerFullscreen(true);
    const save = confirm(`${t('下書き保存しますか？')}\nOK: ${t('下書き保存')} / キャンセル: ${t('破棄')}`);
    if (save) persistCurrentDraft(false);
    closeComposerFullscreen(true);
  }

  textarea.addEventListener('input', () => {
    if (!composerFullscreenOpen && fullscreenTextarea) fullscreenTextarea.value = textarea.value;
    updatePostFormState();
    persistCurrentDraft(true);
  });

  composerFab?.addEventListener('click', openComposerFullscreen);
  expandBtn?.addEventListener('click', openComposerFullscreen);
  fullscreenTextarea?.addEventListener('input', () => {
    textarea.value = fullscreenTextarea.value;
    updatePostFormState();
    persistCurrentDraft(true);
  });
  pollToggleBtn?.addEventListener('click', () => {
    pollFields?.classList.toggle('hidden');
    updatePostFormState();
    persistCurrentDraft(true);
  });
  [pollQuestionInput, pollExpiryInput, ...pollOptionInputs].filter(Boolean).forEach(el => {
    el.addEventListener('input', () => { updatePostFormState(); persistCurrentDraft(true); });
    el.addEventListener('change', () => { updatePostFormState(); persistCurrentDraft(true); });
  });
  addThreadItemBtn?.addEventListener('click', () => {
    selectedThreadTexts.push('');
    renderThreadInputs();
    updatePostFormState();
    requestAnimationFrame(() => threadListEl?.querySelector<AppDomElement>('.composer-thread-textarea:last-child')?.focus());
  });
  const handleComposerPaste = (event: ClipboardEventLike): void => {
    const items = Array.from(event.clipboardData?.items || []);
    const textPayload = event.clipboardData?.getData('text/plain') || '';
    const imageFiles = items
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    const gifUrls = extractGifUrlsFromText(textPayload);
    let added = false;
    for (const file of imageFiles) {
      if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) break;
      if (!validateUploadFile(file, fileInput)) continue;
      selectedImages.push(file);
      selectedImageAlts.push('');
      added = true;
    }
    for (const url of gifUrls) {
      const normalized = normalizeGifUrl(url);
      if (!normalized || selectedGifUrls.includes(normalized)) continue;
      if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) break;
      selectedGifUrls.push(normalized);
      selectedImageAlts.push('GIF');
      added = true;
    }
    if (added) {
      event.preventDefault();
      renderImagePreviews();
      updatePostFormState();
      persistCurrentDraft(true);
      showAppToast(t('画像/GIFを添付しました'), 'success');
    }
  };
  textarea.addEventListener('paste', handleComposerPaste);
  fullscreenTextarea?.addEventListener('paste', handleComposerPaste);
  const handleComposerBeforeInput = (event: InputEvent): void => {
    const inputEvent = event as InputEvent & { dataTransfer?: DataTransfer | null; clipboardData?: DataTransfer | null };
    const transfer = inputEvent.dataTransfer || inputEvent.clipboardData;
    if (!transfer?.items?.length) return;
    handleComposerPaste({
      clipboardData: transfer,
      preventDefault: () => event.preventDefault(),
    });
  };
  textarea.addEventListener('beforeinput', handleComposerBeforeInput);
  fullscreenTextarea?.addEventListener('beforeinput', handleComposerBeforeInput);
  const consumeGifUrlsFromComposerText = () => {
    const value = composerFullscreenOpen && fullscreenTextarea ? fullscreenTextarea.value : textarea.value;
    const urls = extractGifUrlsFromText(value);
    if (!urls.length) return;
    let nextValue = value;
    let added = false;
    for (const url of urls) {
      const normalized = normalizeGifUrl(url);
      if (!normalized || selectedGifUrls.includes(normalized)) continue;
      if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) break;
      selectedGifUrls.push(normalized);
      selectedImageAlts.push('GIF');
      nextValue = nextValue.replace(url, '').replace(/\n{3,}/g, '\n\n').trimStart();
      added = true;
    }
    if (!added) return;
    textarea.value = nextValue;
    if (fullscreenTextarea) fullscreenTextarea.value = nextValue;
    renderImagePreviews();
    updatePostFormState();
    persistCurrentDraft(true);
    showAppToast(t('GIFを添付しました'), 'success');
  };
  textarea.addEventListener('input', () => setTimeout(consumeGifUrlsFromComposerText, 0));
  fullscreenTextarea?.addEventListener('input', () => setTimeout(consumeGifUrlsFromComposerText, 0));

  fullscreenCloseBtns.forEach(btn => btn.addEventListener('click', requestCloseComposer));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && composerFullscreenOpen) requestCloseComposer();
  });
  fullscreenSubmitBtn?.addEventListener('click', () => {
    if (fullscreenTextarea) textarea.value = fullscreenTextarea.value;
    updatePostFormState();
    if (!submitBtn.disabled) doPost(false);
  });

  const fileInput = getEl('post-image-file');
  const previewsDiv = getEl('post-image-previews');
  const countBadge = getEl('image-count-badge');

  const setImageDropState = (active: boolean): void => {
    textarea.closest('.create-post-card')?.classList.toggle('is-image-drop-target', active);
    fullscreenModal?.querySelector('.composer-fullscreen-panel')?.classList.toggle('is-image-drop-target', active);
  };
  const hasImageDrop = (transfer: DataTransfer | null): boolean => Array.from(transfer?.items || [])
    .some(item => item.kind === 'file' && (item.type.startsWith('image/') || !item.type || item.type === 'application/octet-stream'));
  const attachDroppedImages = async (files: File[]): Promise<void> => {
    let added = false;
    for (const file of files) {
      const mimeType = await sniffAttachmentMimeType(file);
      if (!mimeType.startsWith('image/')) continue;
      if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) {
        showAppToast(`${t('画像は')}${MAX_POST_IMAGE_COUNT}${t('枚までです')}`, 'error');
        break;
      }
      if (!validateUploadFile(file, fileInput)) continue;
      selectedImages.push(file);
      selectedImageAlts.push(resolveAttachmentMimeType(file) === 'image/gif' ? 'GIF' : '');
      added = true;
    }
    if (!added) return;
    renderImagePreviews();
    updatePostFormState();
    persistCurrentDraft(true);
    showAppToast(t('画像を添付しました'), 'success');
  };
  const bindImageDropTarget = (target: HTMLTextAreaElement | null): void => {
    if (!target) return;
    target.addEventListener('dragenter', event => {
      if (!hasImageDrop(event.dataTransfer)) return;
      event.preventDefault();
      setImageDropState(true);
    });
    target.addEventListener('dragover', event => {
      if (!hasImageDrop(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setImageDropState(true);
    });
    target.addEventListener('dragleave', event => {
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      setImageDropState(false);
    });
    target.addEventListener('drop', event => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      event.preventDefault();
      setImageDropState(false);
      void attachDroppedImages(files);
    });
  };
  bindImageDropTarget(textarea);
  bindImageDropTarget(fullscreenTextarea);

  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files || []);
      let mediaChanged = false;
      for (const file of files) {
        const mimeType = await sniffAttachmentMimeType(file);
        if (isVideoFile(file)) {
          if (selectedVideoFile) {
            showAppToast(t('動画は1本までです'), 'error');
            continue;
          }
          if (!validateUploadFile(file, fileInput)) continue;
          const duration = await getVideoDuration(file).catch(() => 0);
          if (duration && duration > MAX_VIDEO_UPLOAD_SECONDS) {
            showAppToast(`${t('動画は')} ${MAX_VIDEO_UPLOAD_SECONDS / 60}${t('分以内にしてください')}`, 'error');
            continue;
          }
          selectedVideoFile = file;
          if (videoPreviewVideo) videoPreviewVideo.src = URL.createObjectURL(file);
          if (videoPreviewDiv) videoPreviewDiv.classList.remove('hidden');
          if (fullscreenVideoPreviewVideo) fullscreenVideoPreviewVideo.src = URL.createObjectURL(file);
          if (fullscreenVideoPreviewDiv) fullscreenVideoPreviewDiv.classList.remove('hidden');
          mediaChanged = true;
          continue;
        }

        if (!mimeType.startsWith('image/')) {
          showAppToast(t('画像・GIF・動画ファイルを選択してください'), 'error');
          continue;
        }
        if (selectedImages.length + selectedGifUrls.length >= MAX_POST_IMAGE_COUNT) {
          showAppToast(`${t('画像は')}${MAX_POST_IMAGE_COUNT}${t('枚までです')}`, 'error');
          break;
        }
        if (!validateUploadFile(file, fileInput)) continue;
        selectedImages.push(file);
        selectedImageAlts.push(mimeType === 'image/gif' ? 'GIF' : '');
        mediaChanged = true;
      }
      fileInput.value = '';
      if (mediaChanged) {
        renderImagePreviews();
        updatePostFormState();
        persistCurrentDraft(true);
      }
    });
  }

  function renderImagePreviews() {
    const localItems = selectedImages.map((file, i) => ({ kind: 'file', index: i, url: URL.createObjectURL(file), altIndex: i, label: resolveAttachmentMimeType(file) === 'image/gif' ? 'GIF' : '' }));
    const gifItems = selectedGifUrls.map((url, i) => ({ kind: 'gif-url', index: i, url, altIndex: selectedImages.length + i, label: 'GIF' }));
    const items = [...localItems, ...gifItems];
    const html = items.map((item) => {
      const alt = selectedImageAlts[item.altIndex] || item.label || '';
      return `<div class="image-preview-item image-preview-item-with-alt"><img src="${escapeHtml(item.url)}" alt=""><button class="preview-remove-btn" data-preview-kind="${item.kind}" data-preview-index="${item.index}">✕</button>${item.label ? `<span class="preview-media-badge">${item.label}</span>` : ''}<button class="preview-alt-btn" type="button" data-alt-index="${item.altIndex}">ALT</button><input class="preview-alt-input" data-alt-input="${item.altIndex}" value="${escapeHtml(alt)}" placeholder="${t('画像説明を入力')}"></div>`;
    }).join('');
    if (previewsDiv) previewsDiv.innerHTML = html;
    if (fullscreenPreviewsDiv) fullscreenPreviewsDiv.innerHTML = html;
    if (countBadge) {
      countBadge.textContent = String(items.length);
      countBadge.classList.toggle('hidden', items.length === 0);
    }
    [previewsDiv, fullscreenPreviewsDiv].filter(Boolean).forEach(root => {
      root.querySelectorAll<AppDomElement>('.preview-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.previewIndex);
          if (btn.dataset.previewKind === 'gif-url') {
            selectedGifUrls.splice(idx, 1);
            selectedImageAlts.splice(selectedImages.length + idx, 1);
          } else {
            selectedImages.splice(idx, 1);
            selectedImageAlts.splice(idx, 1);
          }
          renderImagePreviews();
          updatePostFormState();
          persistCurrentDraft(true);
        });
      });
      root.querySelectorAll<AppDomElement>('.preview-alt-input').forEach(input => {
        input.addEventListener('input', () => {
          selectedImageAlts[parseInt(input.dataset.altInput)] = input.value.slice(0, 280);
          persistCurrentDraft(true);
        });
      });
      root.querySelectorAll<AppDomElement>('.preview-alt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const input = root.querySelector<AppDomElement>(`[data-alt-input="${btn.dataset.altIndex}"]`);
          input?.focus();
        });
      });
    });
  }

  getEl('btn-add-media')?.addEventListener('click', () => {
    fileInput?.click();
  });
  fullscreenMediaBtn?.addEventListener('click', () => {
    fileInput?.click();
  });

  const videoFileInput = getEl('post-video-file');
  const videoPreviewDiv = getEl('post-video-preview');
  const videoPreviewVideo = getEl('post-video-preview-video');
  const videoRemoveBtn = getEl('post-video-preview-remove');



  if (videoFileInput) {
    videoFileInput.addEventListener('change', async () => {
      const file = videoFileInput.files[0];
      if (!file) return;
      await sniffAttachmentMimeType(file);
      if (!resolveAttachmentMimeType(file).startsWith('video/')) {
        alert(t('動画ファイルを選択してください'));
        videoFileInput.value = '';
        return;
      }
      if (!validateUploadFile(file, videoFileInput)) return;
      const duration = await getVideoDuration(file).catch(() => 0);
      if (duration && duration > MAX_VIDEO_UPLOAD_SECONDS) {
        showAppToast(`${t('動画は')} ${MAX_VIDEO_UPLOAD_SECONDS / 60}${t('分以内にしてください')}`, 'error');
        videoFileInput.value = '';
        return;
      }
      selectedVideoFile = file;
      updatePostFormState();
      if (videoPreviewVideo) videoPreviewVideo.src = URL.createObjectURL(file);
      if (videoPreviewDiv) videoPreviewDiv.classList.remove('hidden');
      if (fullscreenVideoPreviewVideo) fullscreenVideoPreviewVideo.src = URL.createObjectURL(file);
      if (fullscreenVideoPreviewDiv) fullscreenVideoPreviewDiv.classList.remove('hidden');
      persistCurrentDraft(true);
    });
  }

  const clearSelectedVideo = () => {
      selectedVideoFile = null;
      if (videoFileInput) videoFileInput.value = '';
      if (videoPreviewDiv) videoPreviewDiv.classList.add('hidden');
      if (videoPreviewVideo) videoPreviewVideo.src = '';
      if (fullscreenVideoPreviewDiv) fullscreenVideoPreviewDiv.classList.add('hidden');
      if (fullscreenVideoPreviewVideo) fullscreenVideoPreviewVideo.src = '';
      updatePostFormState();
      persistCurrentDraft(true);
  };
  videoRemoveBtn?.addEventListener('click', clearSelectedVideo);
  fullscreenVideoRemoveBtn?.addEventListener('click', clearSelectedVideo);

  async function doPost(isThread = false) {
    const currentUser = getState('user');
    if (!currentUser) return;

    const text = textarea.value.trim();
    if (!text && selectedImages.length === 0 && selectedGifUrls.length === 0 && !selectedVideoFile && !getPollDraft() && !selectedThreadTexts.some(v => v.trim())) {
      textarea.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = t('投稿中...');
    if (fullscreenSubmitBtn) {
      fullscreenSubmitBtn.disabled = true;
      fullscreenSubmitBtn.textContent = t('投稿中...');
    }
    setRetryState('', false);
    setSubmitStatus(t('投稿を準備中...'), true);

    try {
      const imageURLs = [];
      const attachments: Attachment[] = [];
      for (const [index, file] of selectedImages.entries()) {
        setSubmitStatus(`${t('画像をアップロード中...')} ${index + 1}/${selectedImages.length}`, true);
        const mimeType = await sniffAttachmentMimeType(file);
        if (!mimeType.startsWith('image/')) throw new Error('unsupported_image_file');
        const path = createPostMediaStoragePath(currentUser.uid, file, 'image');
        const attachment = await uploadAttachmentFile(file, path);
        imageURLs.push(attachment.url);
        attachments.push(attachment);
      }
      imageURLs.push(...selectedGifUrls);

      let videoURL = '';
      if (selectedVideoFile) {
        setSubmitStatus(t('動画をアップロード中...'), true);
        const mimeType = await sniffAttachmentMimeType(selectedVideoFile);
        if (!mimeType.startsWith('video/')) throw new Error('unsupported_video_file');
        const path = createPostMediaStoragePath(currentUser.uid, selectedVideoFile, 'video');
        const attachment = await uploadAttachmentFile(selectedVideoFile, path);
        videoURL = attachment.url;
        attachments.push(attachment);
      }

      if (!currentThreadId && isThread) {
        currentThreadId = `thread_${Date.now()}_${currentUser.uid}`;
      }

      setSubmitStatus(t('投稿を保存中...'), true);
      const scheduledValue = scheduledInput?.value || '';
      const scheduledAt = scheduledValue ? new Date(scheduledValue) : null;
      const postPayload: CreatePostPayload = {
        userId: currentUser.uid,
        contentType: (contentKindInput?.value || 'user') as CreatePostPayload['contentType'],
        text,
        imageURLs,
        imageAlts: selectedImageAlts.slice(0, imageURLs.length),
        videoURL,
        attachments,
        threadId: currentThreadId,
        visibility: visibilityInput?.value || 'public',
        scheduledAt,
        poll: getPollDraft(),
      };
      const cleanThreadTexts = selectedThreadTexts.map(v => v.trim()).filter(Boolean);
      if (cleanThreadTexts.length && !postPayload.threadId) {
        postPayload.threadId = `thread_${Date.now()}_${currentUser.uid}`;
      }
      const threadCount = cleanThreadTexts.length ? cleanThreadTexts.length + 1 : 0;
      if (threadCount) {
        postPayload.threadIndex = 0;
        postPayload.threadCount = threadCount;
      }
      const newPost = draftQuotedPostId
        ? await createQuotePost({ ...postPayload, quotedPostId: draftQuotedPostId })
        : await createPost(postPayload);
      await notifyMentions(text, currentUser.uid, newPost.id);
      const extraThreadPosts = [];
      for (const [threadOffset, threadText] of cleanThreadTexts.entries()) {
        const threadPost = await createPost({
          userId: currentUser.uid,
          contentType: postPayload.contentType,
          text: threadText,
          imageURLs: [],
          videoURL: '',
          threadId: postPayload.threadId,
          threadIndex: threadOffset + 1,
          threadCount,
          visibility: postPayload.visibility,
          scheduledAt,
        });
        await notifyMentions(threadText, currentUser.uid, threadPost.id);
        threadPost.author = getState('userProfile');
        threadPost.liked = false;
        threadPost.reposted = false;
        extraThreadPosts.push(threadPost);
      }
      newPost.author = getState('userProfile');
      newPost.liked = false;
      newPost.reposted = false;

      if (!scheduledAt || scheduledAt.getTime() <= Date.now()) {
        feedState.posts.unshift(newPost, ...extraThreadPosts);
        renderFeedPosts();
      }
      showAppToast(scheduledAt && scheduledAt.getTime() > Date.now() ? t('予約投稿を保存しました') : t('投稿しました'), 'success');
      setSubmitStatus('', false);
      lastFailedPost = null;
      if (activeDraftId) deletePostDraft(currentUser.uid, activeDraftId);
      activeDraftId = '';
      draftQuotedPostId = '';

      textarea.value = '';
      if (fullscreenTextarea) fullscreenTextarea.value = '';
      if (visibilityInput) visibilityInput.value = 'public';
      if (fullscreenVisibilityInput) fullscreenVisibilityInput.value = 'public';
      if (contentKindInput) contentKindInput.value = 'user';
      if (fullscreenContentKindInput) fullscreenContentKindInput.value = 'user';
      if (scheduledInput) scheduledInput.value = '';
      if (fullscreenScheduledInput) fullscreenScheduledInput.value = '';
      if (charCount) {
        charCount.textContent = '0/1000';
        charCount.classList.remove('warning', 'danger');
      }
      selectedImages = [];
      selectedGifUrls = [];
      selectedImageAlts = [];
      selectedVideoFile = null;
      selectedThreadTexts = [];
      renderThreadInputs();
      pollFields?.classList.add('hidden');
      if (pollQuestionInput) pollQuestionInput.value = '';
      pollOptionInputs.forEach(input => { input.value = ''; });
      if (pollExpiryInput) pollExpiryInput.value = '24';
      if (fileInput) fileInput.value = '';
      if (videoFileInput) videoFileInput.value = '';
      if (videoPreviewDiv) videoPreviewDiv.classList.add('hidden');
      if (videoPreviewVideo) videoPreviewVideo.src = '';
      if (fullscreenVideoPreviewDiv) fullscreenVideoPreviewDiv.classList.add('hidden');
      if (fullscreenVideoPreviewVideo) fullscreenVideoPreviewVideo.src = '';
      if (previewsDiv) previewsDiv.innerHTML = '';
      if (fullscreenPreviewsDiv) fullscreenPreviewsDiv.innerHTML = '';
      if (countBadge) countBadge.classList.add('hidden');
      if (fullscreenTextarea) fullscreenTextarea.value = '';
      closeComposerFullscreen(false);
      updatePostFormState();

      if (isThread) {
        if (addThreadBtn) {
          addThreadBtn.style.display = 'inline-block';
          addThreadBtn.textContent = t('＋スレッドに追加');
        }
        submitBtn.textContent = t('スレッドを投稿');
      } else {
        currentThreadId = '';
        if (addThreadBtn) addThreadBtn.style.display = 'none';
      }
    } catch (e) {
      lastFailedPost = {
        text,
        images: [...selectedImages],
        gifUrls: [...selectedGifUrls],
        imageAlts: [...selectedImageAlts],
        video: selectedVideoFile,
        isThread,
      };
      const message = `${t('投稿に失敗しました')}: ${getFirebaseErrorMessage(e)}`;
      setSubmitStatus('', false);
      setRetryState(message, true);
      showAppToast(message, 'error', { label: t('再投稿'), onClick: () => retryBtn?.click() });
    } finally {
      submitBtn.disabled = false;
      if (!isThread) submitBtn.textContent = t('投稿する');
      if (fullscreenSubmitBtn) fullscreenSubmitBtn.textContent = t('投稿する');
      updatePostFormState();
    }
  }

  submitBtn.addEventListener('click', () => doPost(false));
  retryBtn?.addEventListener('click', async () => {
    if (!lastFailedPost) return;
    textarea.value = lastFailedPost.text || textarea.value;
    selectedImages = [...(lastFailedPost.images || selectedImages)];
    selectedGifUrls = [...(lastFailedPost.gifUrls || selectedGifUrls)];
    selectedImageAlts = [...(lastFailedPost.imageAlts || selectedImageAlts)];
    selectedVideoFile = lastFailedPost.video || selectedVideoFile;
    renderImagePreviews();
    if (selectedVideoFile && videoPreviewVideo && videoPreviewDiv) {
      videoPreviewVideo.src = URL.createObjectURL(selectedVideoFile);
      videoPreviewDiv.classList.remove('hidden');
    }
    updatePostFormState();
    await doPost(lastFailedPost.isThread);
  });

  if (addThreadBtn) {
    addThreadBtn.addEventListener('click', () => doPost(true));
  }
  if (activeDraftId) {
    const draft = readPostDrafts(currentUser.uid).find(item => item.id === activeDraftId);
    if (draft) {
      draftQuotedPostId = draft.quotedPostId || '';
      textarea.value = draft.text || '';
      if (fullscreenTextarea) fullscreenTextarea.value = textarea.value;
      if (visibilityInput) visibilityInput.value = draft.visibility || 'public';
      if (fullscreenVisibilityInput) fullscreenVisibilityInput.value = draft.visibility || 'public';
      if (contentKindInput) contentKindInput.value = draft.contentType || 'user';
      if (fullscreenContentKindInput) fullscreenContentKindInput.value = draft.contentType || 'user';
      if (scheduledInput) scheduledInput.value = draft.scheduledAt || '';
      if (fullscreenScheduledInput) fullscreenScheduledInput.value = draft.scheduledAt || '';
      selectedThreadTexts = Array.isArray(draft.threadTexts) ? draft.threadTexts : [];
      selectedGifUrls = Array.isArray(draft.gifUrls) ? draft.gifUrls.map(normalizeGifUrl).filter(Boolean) : [];
      renderThreadInputs();
      if (draft.poll) {
        pollFields?.classList.remove('hidden');
        const draftPoll = draft.poll as PostPollDraft;
        if (pollQuestionInput) pollQuestionInput.value = draftPoll.question || '';
        (draftPoll.options || []).forEach((option: { text?: string }, index: number) => { if (pollOptionInputs[index]) pollOptionInputs[index].value = option.text || ''; });
      }
      renderImagePreviews();
      const names = [...(draft.imageNames || []), ...(draft.gifUrls || []), draft.videoName].filter(Boolean);
      if (names.length) {
        setSubmitStatus(`${t('下書きの添付ファイル')}: ${names.join(', ')}（${t('再選択してください')}）`, true);
      }
      updatePostFormState();
      openComposerFullscreen();
    }
  }
  updatePostFormState();
}

function setupInfiniteScroll() {
  const observer = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const loadMore = entry.target.closest('#btn-load-more');
        if (loadMore || feedState.hasMore) {
          observer.unobserve(entry.target);
          await loadFeedPosts();
        }
      }
    }
  }, { rootMargin: '200px' });

  const sentinel = document.createElement('div');
  sentinel.className = 'scroll-sentinel';
  const container = getEl('feed-container');
  if (container) {
    container.appendChild(sentinel);
    observer.observe(sentinel);
  }
}

export function setupCommentLikeButtons(container: HTMLElement | null): void {
  if (!container) return;
  container.querySelectorAll<AppDomElement>('[data-action="like-comment"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const currentUser = getState('user');
      if (!currentUser) return;
      const commentId = btn.dataset.commentId;
      if (!commentId) return;
      const btnEl = btn;
      btnEl.disabled = true;
      try {
        const result = await toggleCommentLike(commentId, currentUser.uid);
        btnEl.classList.toggle('liked', result.liked);
        const icon = btnEl.querySelector<AppDomElement>('.comment-like-icon');
        if (icon) icon.textContent = '♥';
        let countEl = btnEl.querySelector<AppDomElement>('.comment-like-count');
        let count = countEl ? parseInt(countEl.textContent) || 0 : 0;
        count = result.liked ? count + 1 : Math.max(0, count - 1);
        if (count > 0) {
          if (countEl) {
            countEl.textContent = String(count);
          } else {
            const span = document.createElement('span');
            span.className = 'comment-like-count';
            span.textContent = String(count);
            btnEl.appendChild(span);
          }
        } else if (countEl) {
          countEl.remove();
        }
      } catch (error) {
        alert(t('いいねに失敗しました') + ': ' + getFirebaseErrorMessage(error));
      } finally {
        btnEl.disabled = false;
      }
    });
  });
}

export function setupCommentEditButtons(
  container: HTMLElement | null,
  onEdited?: (commentId: string, text: string) => void | Promise<void>,
): void {
  if (!container) return;
  container.querySelectorAll<AppDomElement>('[data-action="edit-comment"]').forEach(btn => {
    if (btn.dataset.editBound === 'true') return;
    btn.dataset.editBound = 'true';
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const currentUser = getState('user');
      const commentId = btn.dataset.commentId || '';
      const comment = btn.closest<HTMLElement>('.comment');
      const textEl = comment?.querySelector<HTMLElement>('.comment-text');
      if (!currentUser || !commentId || !comment || !textEl) return;
      if (comment.dataset.commentUserId && comment.dataset.commentUserId !== currentUser.uid) return;
      if (comment.classList.contains('is-editing')) return;

      const originalText = comment.dataset.commentText ?? textEl.textContent ?? '';
      comment.classList.add('is-editing');
      btn.hidden = true;
      textEl.innerHTML = `
        <textarea class="comment-edit-input" maxlength="500" aria-label="${t('コメントを編集')}">${escapeHtml(originalText)}</textarea>
        <div class="comment-edit-actions">
          <button type="button" class="btn btn-primary btn-sm" data-comment-edit-save>${t('保存')}</button>
          <button type="button" class="btn btn-secondary btn-sm" data-comment-edit-cancel>${t('キャンセル')}</button>
        </div>
      `;
      const input = textEl.querySelector<HTMLTextAreaElement>('.comment-edit-input');
      const saveButton = textEl.querySelector<HTMLButtonElement>('[data-comment-edit-save]');
      const cancelButton = textEl.querySelector<HTMLButtonElement>('[data-comment-edit-cancel]');
      const restore = (): void => {
        textEl.innerHTML = linkifyHashtags(comment.dataset.commentText ?? originalText);
        comment.classList.remove('is-editing');
        btn.hidden = false;
      };

      cancelButton?.addEventListener('click', restore);
      saveButton?.addEventListener('click', async () => {
        const nextText = input?.value.trim() || '';
        if (nextText === originalText.trim()) {
          restore();
          return;
        }
        if (!input || !saveButton) return;
        saveButton.disabled = true;
        if (cancelButton) cancelButton.disabled = true;
        saveButton.textContent = t('保存中...');
        try {
          const updated = await updateComment(commentId, currentUser.uid, { text: nextText });
          const canonicalText = String(updated.text ?? nextText);
          comment.dataset.commentText = canonicalText;
          textEl.innerHTML = linkifyHashtags(canonicalText);
          comment.classList.remove('is-editing');
          btn.hidden = false;
          await onEdited?.(commentId, canonicalText);
          showAppToast(t('コメントを更新しました'), 'success');
        } catch (error) {
          showAppToast(`${t('コメントの更新に失敗しました')}: ${getFirebaseErrorMessage(error)}`, 'error');
          if (document.body.contains(saveButton)) {
            saveButton.disabled = false;
            saveButton.textContent = t('保存');
          }
          if (cancelButton && document.body.contains(cancelButton)) cancelButton.disabled = false;
        }
      });
      requestAnimationFrame(() => input?.focus({ preventScroll: true }));
    });
  });
}


export function setupCommentDeleteButtons(container: HTMLElement | null, onDeleted?: () => void | Promise<void>): void {
  if (!container) return;
  container.querySelectorAll<AppDomElement>('[data-action="delete-comment"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const currentUser = getState('user');
      if (!currentUser) return;
      const commentId = btn.dataset.commentId;
      if (!commentId) return;
      if (!confirm(t('このコメントを削除しますか？'))) return;
      btn.disabled = true;
      try {
        await deleteComment(commentId, currentUser.uid);
        if (onDeleted) {
          await onDeleted();
        } else {
          btn.closest('.comment-thread')?.remove();
        }
      } catch (error) {
        alert(t('コメント削除に失敗しました') + ': ' + getFirebaseErrorMessage(error));
      } finally {
        if (document.body.contains(btn)) btn.disabled = false;
      }
    });
  });
}
export function openImageViewer(images: Array<string | ImageViewerItem>, startIndex = 0): void {
  if (!images.length) return;
  const items = images.map((item): ImageViewerItem => typeof item === 'string' ? { url: item } : item);
  let index = startIndex;
  let imageRenderId = 0;
  let viewerHistoryActive = false;
  let closing = false;
  const hasMultipleImages = items.length > 1;
  const appRoot = getEl('app');
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const existing = getEl('image-viewer');
  if (existing) existing.remove();
  document.querySelectorAll<AppDomElement>('.image-lightbox').forEach(el => el.remove());

  const render = (): void => {
    const img = getEl('image-viewer-img');
    const count = getEl('image-viewer-count');
    const item = items[index];
    if (img) {
      const renderId = ++imageRenderId;
      img.alt = item.alt || `${t('投稿画像')} ${index + 1}`;
      if (item.postId) {
        img.dataset.postMediaImage = 'true';
        img.dataset.postId = item.postId;
        img.dataset.mediaKind = 'image';
        img.dataset.mediaIndex = String(item.mediaIndex ?? index);
        img.dataset.mediaSource = item.url;
        delete img.dataset.mediaResolutionAttempted;
        delete img.dataset.resolvedSrc;
        img.removeAttribute('src');
        void prefetchPostMediaURL(item.postId, item.url, 'image', item.mediaIndex ?? index).then((resolvedURL) => {
          if (!img.isConnected || renderId !== imageRenderId) return;
          item.url = resolvedURL;
          img.dataset.mediaSource = resolvedURL;
          img.dataset.resolvedSrc = resolvedURL;
          item.sourceButton?.isConnected && (item.sourceButton.dataset.imageUrl = resolvedURL);
          img.src = resolvedURL;
        }).catch(() => {
          if (!img.isConnected || renderId !== imageRenderId) return;
          img.dataset.mediaResolutionAttempted = 'true';
          img.src = item.url;
        });
      } else {
        img.src = item.url;
        delete img.dataset.postMediaImage;
        delete img.dataset.postId;
        delete img.dataset.mediaKind;
        delete img.dataset.mediaIndex;
        delete img.dataset.mediaSource;
        delete img.dataset.mediaResolutionAttempted;
      }
    }
    const altBtn = getEl('image-viewer-alt');
    if (altBtn) {
      altBtn.dataset.altText = item.alt || '';
      altBtn.hidden = !item.alt;
      altBtn.setAttribute('aria-expanded', 'false');
    }
    closeImageAltPopup();
    if (count) count.textContent = `${index + 1} / ${items.length}`;
  };

  const html = `
    <div class="image-viewer" id="image-viewer" role="dialog" aria-modal="true" aria-label="${t('投稿画像を拡大')}">
      <button type="button" class="image-viewer-close" id="image-viewer-close" aria-label="${t('閉じる')}">×</button>
      ${hasMultipleImages ? `<button class="image-viewer-nav image-viewer-prev" id="image-viewer-prev" aria-label="${t('前の画像')}">‹</button>` : ''}
      <img id="image-viewer-img" class="image-viewer-img"${items[index].postId ? '' : ` src="${escapeHtml(items[index].url)}"`} alt="${escapeHtml(items[index].alt || `${t('投稿画像')} ${index + 1}`)}">
      <span class="image-viewer-media-fallback" role="status" hidden>${t('画像を読み込めませんでした')}</span>
      <button class="image-viewer-alt post-image-alt-trigger" id="image-viewer-alt" data-action="image-alt" data-no-open data-alt-text="${escapeHtml(items[index].alt || '')}" ${items[index].alt ? '' : 'hidden'} aria-label="${t('画像の説明を表示')}" aria-expanded="false">ALT</button>
      ${hasMultipleImages ? `<button class="image-viewer-nav image-viewer-next" id="image-viewer-next" aria-label="${t('次の画像')}">›</button>` : ''}
      ${hasMultipleImages ? `<div class="image-viewer-count" id="image-viewer-count">${index + 1} / ${items.length}</div>` : ''}
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
  render();
  document.body.classList.add('image-viewer-open');
  if (appRoot) appRoot.inert = true;
  try {
    history.pushState({ ...(history.state || {}), connectImageViewer: true }, '', window.location.href);
    viewerHistoryActive = true;
  } catch (e) {
    viewerHistoryActive = false;
  }

  const close = (options: ImageViewerCloseOptions = {}): void => {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('hashchange', onRouteChange);
    closeImageAltPopup();
    getEl('image-viewer')?.remove();
    document.body.classList.remove('image-viewer-open');
    if (appRoot) appRoot.inert = false;
    document.querySelectorAll<AppDomElement>('.image-lightbox').forEach(el => el.remove());
    if (viewerHistoryActive && !options.fromHistory) {
      viewerHistoryActive = false;
      history.back();
    }
    viewerHistoryActive = false;
    previouslyFocused?.focus({ preventScroll: true });
  };
  const move = (delta: number): void => {
    index = (index + delta + items.length) % items.length;
    render();
  };
  const onPopState = () => {
    if (viewerHistoryActive) close({ fromHistory: true });
  };
  const onRouteChange = () => close({ fromHistory: true });
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && document.querySelector('.post-image-alt-popup')) {
      document.querySelectorAll<AppDomElement>('[data-action="image-alt"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
      closeImageAltPopup();
      return;
    }
    if (e.key === 'Escape') close();
    if (hasMultipleImages && e.key === 'ArrowLeft') move(-1);
    if (hasMultipleImages && e.key === 'ArrowRight') move(1);
  };

  const viewer = getEl('image-viewer');
  const closeButton = getEl('image-viewer-close');
  let dismissPointerId: number | null = null;
  viewer?.addEventListener('pointerdown', (event: PointerEvent) => {
    const target = event.target;
    if (target !== closeButton && !isBackdropDismiss(target, event.currentTarget)) return;
    dismissPointerId = event.pointerId;
    event.preventDefault();
    event.stopImmediatePropagation();
    try { viewer.setPointerCapture(event.pointerId); } catch { /* no-op */ }
  }, { capture: true, passive: false });
  viewer?.addEventListener('pointerup', (event: PointerEvent) => {
    if (dismissPointerId !== event.pointerId) return;
    dismissPointerId = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    armModalClickShield();
    window.setTimeout(() => close(), 0);
  }, { capture: true, passive: false });
  viewer?.addEventListener('pointercancel', (event: PointerEvent) => {
    if (dismissPointerId !== event.pointerId) return;
    dismissPointerId = null;
    try { if (viewer.hasPointerCapture(event.pointerId)) viewer.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
  }, true);
  closeButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if ((event as MouseEvent).detail === 0) close();
  }, true);
  getEl('image-viewer-prev')?.addEventListener('click', (e) => { e.stopPropagation(); move(-1); });
  getEl('image-viewer-next')?.addEventListener('click', (e) => { e.stopPropagation(); move(1); });
  viewer?.addEventListener('click', (e) => {
    if (isBackdropDismiss(e.target, e.currentTarget) && (e as MouseEvent).detail === 0) close();
  });
  setupImageAltButtons(document);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('popstate', onPopState);
  window.addEventListener('hashchange', onRouteChange);
  closeButton?.focus({ preventScroll: true });
}

// ============================================================
// コメントモーダル
// ============================================================
async function openCommentModal(postId: string, postData: FeedPostViewModel | null = null): Promise<void> {
  getEl('modal-overlay')?.remove();
  let post = postData || feedState.posts.find(p => p.id === postId);
  if (!post) {
    try {
      const snap = await getDoc(doc(db, 'posts', postId));
      if (snap.exists()) {
        const data = snap.data();
        const author = await getDisplayUserProfile(data.userId);
        post = { id: snap.id, ...data, author };
      }
    } catch (e) {
      return;
    }
  }
  if (!post) return;

  const currentUser = getState('user');
  const firstCommentsPage = await getCommentsPage(postId, 30);
  let loadedComments = [...firstCommentsPage.comments];
  let commentsCursor = firstCommentsPage.cursor;
  let hasMoreComments = firstCommentsPage.hasMore;

  const renderLoadedComments = async (): Promise<void> => {
    const list = getEl('comments-list');
    const loadMore = getEl('comments-load-more') as HTMLButtonElement | null;
    const enriched = await enrichComments(loadedComments, currentUser?.uid);
    list.innerHTML = enriched.length === 0
      ? renderEmptyState(t('まだコメントがありません'), '💬')
      : renderCommentThread(enriched);
    if (loadMore) {
      loadMore.classList.toggle('hidden', !hasMoreComments);
      loadMore.disabled = false;
      loadMore.textContent = t('さらにコメントを読み込む');
    }
    setupCommentLikeButtons(list);
    setupCommentEditButtons(list, (commentId, text) => {
      const comment = loadedComments.find(item => item.id === commentId);
      if (comment) comment.text = text;
    });
    setupCommentDeleteButtons(list, async () => { closeModal(); await openCommentModal(postId); });
    bindCommentReplyButtons(list);
  };

  const bindCommentReplyButtons = (scope: ParentNode): void => {
    scope.querySelectorAll<AppDomElement>('[data-action="reply-comment"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = getEl('comment-input');
        const commentName = btn.closest('.comment')?.querySelector('.comment-name')?.textContent || '';
        replyToCommentId = btn.dataset.commentId || null;
        if (input) {
          input.focus();
          input.placeholder = `@${commentName}${t('に返信...')}`;
        }
        const replyingTo = getEl('replying-to');
        const replyingToText = getEl('replying-to-text');
        if (replyingTo && replyingToText) {
          replyingToText.textContent = `${commentName}${t('に返信中')}`;
          replyingTo.classList.remove('hidden');
        }
      });
    });
  };

  const initialEnriched = await enrichComments(loadedComments, currentUser?.uid);
  const commentsHtml = initialEnriched.length === 0
    ? renderEmptyState(t('まだコメントがありません'), '💬')
    : renderCommentThread(initialEnriched);

  const modalContent = `
    <div class="comment-modal-post">
      <div class="comment-modal-post-author">
        ${createAvatarHTML(toRenderProfile(post.author), 32)}
        <span class="comment-modal-post-name">${escapeHtml(toRenderProfile(post.author)?.displayName || '不明')}</span>
      </div>
      <div class="comment-modal-post-text">${renderExpandablePostText(post.text || '', { expanded: true, postId })}</div>
    </div>
    <div class="comments-list" id="comments-list">
      ${commentsHtml}
    </div>
    <button type="button" class="btn btn-secondary btn-sm comments-load-more ${hasMoreComments ? '' : 'hidden'}" id="comments-load-more">${t('さらにコメントを読み込む')}</button>
    <div class="comment-input-area">
      <div class="replying-to hidden" id="replying-to">
        <span id="replying-to-text"></span>
        <button type="button" id="cancel-reply" aria-label="${t('返信をキャンセル')}">×</button>
      </div>
      <textarea class="comment-input" id="comment-input" placeholder="${t('コメントを書く...')}" rows="2" maxlength="500"></textarea>
      <div class="comment-input-tools">
        <input type="file" id="comment-file-input" accept="*/*" style="display:none">
        <button class="btn-icon comment-attach-btn" id="comment-btn-file" type="button" title="${t('ファイルを添付')}" aria-label="${t('ファイルを添付')}"><span>＋</span><span>${t('添付')}</span></button>
        <div id="comment-media-preview" class="comment-media-preview hidden"></div>
        <button class="btn btn-primary comment-submit-btn" id="comment-submit" data-post-id="${postId}">${t('送信')}</button>
      </div>
    </div>
  `;

  const modalHTML = renderModal(t('コメント'), modalContent);
  document.body.classList.add('comment-modal-open');
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const overlay = getEl('modal-overlay');
  const closeBtn = getEl('modal-close');

  const closeModal = () => {
    if (commentPreviewUrl) {
      URL.revokeObjectURL(commentPreviewUrl);
      commentPreviewUrl = '';
    }
    if (overlay && document.body.contains(overlay)) overlay.remove();
    document.body.classList.remove('comment-modal-open');
  };

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // コメント投稿
  const commentInput = getEl('comment-input');
  const commentSubmit = getEl('comment-submit');
  const commentFileInput = getEl('comment-file-input');
  const commentMediaPreview = getEl('comment-media-preview');
  let commentSelectedFile: File | null = null;
  let commentPreviewUrl = '';
  let replyToCommentId: string | null = null;

  getEl('comment-btn-file')?.addEventListener('click', () => commentFileInput?.click());

  commentFileInput?.addEventListener('change', () => {
    const file = commentFileInput.files[0];
    if (!file) return;
    if (!validateUploadFile(file, commentFileInput)) return;
    commentSelectedFile = file;
    if (commentPreviewUrl) URL.revokeObjectURL(commentPreviewUrl);
    commentPreviewUrl = URL.createObjectURL(file);
    if (isVideoFile(file)) {
      commentMediaPreview.innerHTML = `<div class="preview-item"><video src="${commentPreviewUrl}" controls preload="none" playsinline></video><button class="preview-remove-btn">✕</button></div>`;
      commentMediaPreview.classList.remove('hidden');
      return;
    }
    if (isAudioFile(file)) {
      commentMediaPreview.innerHTML = `<div class="preview-item preview-file"><span class="preview-file-icon">♫</span><span class="preview-file-name">${escapeHtml(file.name)}</span><audio src="${commentPreviewUrl}" controls preload="none"></audio><button class="preview-remove-btn">✕</button></div>`;
      commentMediaPreview.classList.remove('hidden');
      return;
    }
    if (isImageFile(file)) {
      commentMediaPreview.innerHTML = `<div class="preview-item"><img src="${escapeHtml(commentPreviewUrl)}" alt="" decoding="async"><button class="preview-remove-btn">✕</button></div>`;
      commentMediaPreview.classList.remove('hidden');
      return;
    }
    commentMediaPreview.innerHTML = `<div class="preview-item preview-file"><span class="preview-file-icon">＋</span><span class="preview-file-name">${escapeHtml(file.name)}</span><button class="preview-remove-btn">✕</button></div>`;
    commentMediaPreview.classList.remove('hidden');
  });

  commentMediaPreview?.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.classList.contains('preview-remove-btn')) {
      commentSelectedFile = null;
      if (commentPreviewUrl) {
        URL.revokeObjectURL(commentPreviewUrl);
        commentPreviewUrl = '';
      }
      commentFileInput.value = '';
      commentMediaPreview.classList.add('hidden');
      commentMediaPreview.innerHTML = '';
    }
  });

  commentSubmit.addEventListener('click', async () => {
    const currentUser = getState('user');
    if (!currentUser || (!commentInput.value.trim() && !commentSelectedFile)) return;
    const text = commentInput.value.trim();
    commentSubmit.disabled = true;
    commentSubmit.textContent = t('送信中...');

    try {
      let imageURL = '';
      let videoURL = '';
      let audioURL = '';
      let fileURL = '';
      let fileName = '';
      let attachments: Attachment[] = [];
      if (commentSelectedFile) {
        const ext = commentSelectedFile.name.split('.').pop() || 'file';
        const path = `comments/${currentUser.uid}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const attachment = await uploadAttachmentFile(commentSelectedFile, path, () => {});
        const url = attachment.url;
        attachments = [attachment];
        if (attachment.kind === 'image') {
          imageURL = url;
        } else if (attachment.kind === 'video') {
          videoURL = url;
        } else if (attachment.kind === 'audio') {
          audioURL = url;
          fileURL = url;
          fileName = attachment.name;
        } else {
          fileURL = url;
          fileName = attachment.name;
        }
      }
      const wasReply = !!replyToCommentId;
      const replyTarget = replyToCommentId ? loadedComments.find(comment => comment.id === replyToCommentId) : null;
      const createdComment = await addComment({
        postId,
        userId: currentUser.uid,
        text,
        attachments,
        imageURL,
        videoURL,
        audioURL,
        fileURL,
        fileName,
        parentId: replyToCommentId,
      });
      replyToCommentId = null;
      commentInput.value = '';
      commentInput.placeholder = t('コメントを書く...');
      commentSelectedFile = null;
      if (commentPreviewUrl) {
        URL.revokeObjectURL(commentPreviewUrl);
        commentPreviewUrl = '';
      }
      if (commentFileInput) commentFileInput.value = '';
      if (commentMediaPreview) {
        commentMediaPreview.classList.add('hidden');
        commentMediaPreview.innerHTML = '';
      }
      getEl('replying-to')?.classList.add('hidden');
      // 通知
      const notificationUserId = wasReply && replyTarget?.userId ? replyTarget.userId : post.userId;
      if (notificationUserId !== currentUser.uid) {
        await createNotification({
          userId: notificationUserId,
          type: wasReply ? 'reply' : 'comment',
          fromUserId: currentUser.uid,
          postId,
          commentId: createdComment.id,
          eventId: createdComment.id,
          context: text.slice(0, 80),
        });
      }
      await notifyMentions(text, currentUser.uid, postId, [post.userId, notificationUserId], createdComment.id);
      const existingCommentIds = new Set(loadedComments.map(comment => comment.id));
      if (!existingCommentIds.has(createdComment.id)) loadedComments = [...loadedComments, createdComment];
      await renderLoadedComments();
    } catch (e) {
      alert(t('コメント投稿に失敗しました'));
    } finally {
      if (commentSubmit && document.body.contains(commentSubmit)) {
        commentSubmit.disabled = false;
        commentSubmit.textContent = t('送信');
      }
    }
  });

  getEl('comments-load-more')?.addEventListener('click', async () => {
    const button = getEl('comments-load-more') as HTMLButtonElement | null;
    if (!button || !hasMoreComments || !commentsCursor || button.disabled) return;
    button.disabled = true;
    button.textContent = t('読み込み中...');
    try {
      const nextPage = await getCommentsPage(postId, 30, commentsCursor);
      const existingCommentIds = new Set(loadedComments.map(comment => comment.id));
      const uniqueComments = nextPage.comments.filter(comment => !existingCommentIds.has(comment.id));
      loadedComments = [...loadedComments, ...uniqueComments];
      commentsCursor = nextPage.cursor;
      hasMoreComments = nextPage.hasMore;
      await renderLoadedComments();
    } catch (error) {
      console.error('Load more comments error:', error);
      button.disabled = false;
      button.textContent = t('さらにコメントを読み込む');
    }
  });

  bindCommentReplyButtons(getEl('comments-list'));

  getEl('cancel-reply')?.addEventListener('click', () => {
    replyToCommentId = null;
    const commentInput = getEl('comment-input');
    if (commentInput) commentInput.placeholder = t('コメントを書く...');
    getEl('replying-to')?.classList.add('hidden');
  });

  setupCommentLikeButtons(getEl('comments-list'));
  setupCommentEditButtons(getEl('comments-list'), (commentId, text) => {
    const comment = loadedComments.find(item => item.id === commentId);
    if (comment) comment.text = text;
  });
  setupCommentDeleteButtons(getEl('comments-list'), async () => {
    closeModal();
    await openCommentModal(postId);
  });
}

// ============================================================
// プロフィールページ
// ============================================================
















