import {
  doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, startAfter, documentId,
  serverTimestamp, increment, arrayUnion,
  writeBatch, onSnapshot, getCountFromServer, getDocFromServer, Timestamp, runTransaction,
} from 'firebase/firestore';
import type { DocumentSnapshot, FieldValue, FirestoreData, QueryConstraint, QueryDocumentSnapshot } from 'firebase/firestore';
import { app, auth, db } from './firebase.ts';
import { ACTIVE_NOTIFICATION_TYPES, isActiveNotificationType, shouldCreateNotification } from './notificationDomain.ts';
import { extractHashtagKeys } from './searchDomain.ts';
import { generateAvatarColor } from './utils.ts';
import { createAttachmentRecord, createImagePreviewFile, readAttachmentMetadata, resolveAttachmentMimeType, sanitizeAttachments } from './attachments.ts';
import type {
  Attachment,
  PostContentKind,
  TimestampLike,
  Visibility,
} from './types/domain';
import {
  toComment,
  toPost,
  toStory,
  toUserProfile,
} from './types/converters';
import { classifyStartupError, singleFlight, withTimeout } from './startupResilience.ts';
import { getActiveStartupTraceSession } from './startupTrace.ts';
import { mergeLatestDisplayProfile } from './avatar.ts';
import { canonicalPostMediaURLFromPostMedia, postMediaHasStoragePath, storagePathFromMediaURL, type PostMediaKind } from './videoMedia.ts';

type FirestoreWriteValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FieldValue
  | Timestamp
  | Date
  | TimestampLike
  | string[]
  | number[]
  | boolean[]
  | Attachment[]
  | FirestoreWriteValue[]
  | { [key: string]: FirestoreWriteValue };

type WriteData = { [key: string]: FirestoreWriteValue };
type ProfileCache = Record<string, UserProfileRecord>;
type FriendIdsCache = Map<string, { ids: string[]; time: number }>;
type UploadableFile = Blob & { type?: string; name?: string };
type ProgressHandler = (percent: number, progress: { bytesTransferred: number; totalBytes: number }) => void;
type FeedMode = 'friends' | 'recommended' | string;
type FeedSignals = {
  friends: Set<string>;
  repliedToUsers: Set<string>;
  repliedByUsers: Set<string>;
  likedUsers: Set<string>;
  hashtagAffinity: Map<string, number>;
};
type FeedResult = { posts: PostRecord[]; loadedCount: number };
type LikeRecord = FirestoreData & { id: string; postId?: string; userId?: string; commentId?: string; type?: string; createdAt?: TimestampLike | FieldValue };
type BookmarkRecord = FirestoreData & { id: string; postId?: string; userId?: string; createdAt?: TimestampLike | FieldValue };
type NotificationRecord = FirestoreData & { id: string; userId?: string; type?: string; fromUserId?: string; fromUser?: UserProfileRecord | null; fromUserDisplayName?: string; fromUserUsername?: string; fromUserPhotoURL?: string; fromUserAvatarColor?: string; eventId?: string; postId?: string; commentId?: string; storyId?: string; conversationId?: string; messageId?: string; threadId?: string; context?: string; deepLink?: string; read?: boolean; createdAt?: TimestampLike | FieldValue };
type CommentRecord = FirestoreData & { id: string; postId?: string; userId?: string; text?: string; parentId?: string | null; createdAt?: unknown };
type FriendshipRecord = FirestoreData & { id: string; userId?: string; friendId?: string; requester?: string; status?: string; requestEventId?: string; acceptEventId?: string; eventId?: string; createdAt?: TimestampLike | FieldValue; updatedAt?: TimestampLike | FieldValue };
type FriendQrPayload = { app?: string; type?: string; uid?: string; token?: string; exp?: number | string };

type UserProfileRecord = FirestoreData & {
  id: string;
  uid?: string;
  displayName?: string;
  username?: string;
  email?: string;
  bio?: string;
  photoURL?: string;
  profileImage?: string;
  coverImage?: string;
  coverURL?: string;
  profilePhotoStoragePath?: string;
  profilePhotoPreviewStoragePath?: string;
  profilePhotoPreviewURL?: string;
  profilePhotoWidth?: number;
  profilePhotoHeight?: number;
  coverPhotoStoragePath?: string;
  coverPhotoPreviewStoragePath?: string;
  coverPhotoPreviewURL?: string;
  coverPhotoWidth?: number;
  coverPhotoHeight?: number;
  avatarColor?: string;
  friendsCount?: number;
  postsCount?: number;
  friendQrToken?: string;
  friendQrExpiresAt?: TimestampLike;
  createdAt?: TimestampLike | FieldValue;
  updatedAt?: TimestampLike | FieldValue;
};

type PostPollOption = { text: string; votes: string[] };
type PostPoll = {
  question?: string;
  options: PostPollOption[];
  totalVotes?: number;
  expiresAt?: unknown;
  createdAt?: unknown;
};

type PostRecord = FirestoreData & {
  id: string;
  userId?: string;
  authorId?: string;
  text?: string;
  contentType?: string;
  contentKind?: string;
  isSponsored?: boolean;
  sponsored?: boolean;
  isAd?: boolean;
  attachments?: Attachment[];
  imageURL?: string;
  imageURLs?: string[];
  imageAlts?: string[];
  videoURL?: string;
  gifURL?: string;
  mediaAltTexts?: string[];
  hashtags?: string[];
  mentions?: string[];
  visibility?: Visibility | string;
  likesCount?: number;
  commentsCount?: number;
  repostsCount?: number;
  bookmarksCount?: number;
  viewCount?: number;
  profileClickCount?: number;
  authorDisplayName?: string;
  authorUsername?: string;
  authorPhotoURL?: string;
  authorAvatarColor?: string;
  quotedPostId?: string;
  quotedPost?: PostRecord | FirestoreData | null;
  quotePostId?: string;
  poll?: PostPoll | null;
  threadId?: string;
  threadIndex?: number | null;
  threadCount?: number | null;
  pinned?: boolean;
  edited?: boolean;
  editedAt?: TimestampLike | FieldValue | null;
  editHistory?: WriteData[];
  createdAt?: TimestampLike | FieldValue;
  updatedAt?: TimestampLike | FieldValue;
  scheduledAt?: TimestampLike | FieldValue;
};

type StoryRecord = FirestoreData & {
  id: string;
  audioUrl?: string;
  audioTitle?: string;
  audioPresetId?: string;
  muteVideo?: boolean;
  overlayText?: string;
  background?: string;
  viewedByMe?: boolean;
  mediaStoragePath?: string;
  previewStoragePath?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  mediaDuration?: number;
};

type StoryGroup = {
  authorId: string;
  author: UserProfileRecord | null;
  stories: StoryRecord[];
  hasUnseen: boolean;
  latestAt: number;
};

type StoryViewer = FirestoreData & {
  id: string;
  viewerId?: string;
  viewedAt?: unknown;
  profile: UserProfileRecord | null;
};

type CreateUserProfileInput = Partial<Pick<UserProfileRecord, 'displayName' | 'username' | 'email' | 'photoURL' | 'coverURL' | 'profilePhotoStoragePath' | 'profilePhotoPreviewStoragePath' | 'profilePhotoPreviewURL' | 'profilePhotoWidth' | 'profilePhotoHeight' | 'coverPhotoStoragePath' | 'coverPhotoPreviewStoragePath' | 'coverPhotoPreviewURL' | 'coverPhotoWidth' | 'coverPhotoHeight' | 'avatarColor' | 'bio'>> & WriteData;
type UpdateUserProfileInput = CreateUserProfileInput & WriteData;
type CreateStoryInput = Partial<StoryRecord> & { authorId: string };
type CreatePostInput = {
  userId: string;
  contentType?: PostContentKind;
  text?: string;
  imageURLs?: string[];
  imageAlts?: string[];
  attachments?: Attachment[];
  videoURL?: string;
  threadId?: string;
  threadIndex?: number | string | null;
  threadCount?: number | string | null;
  quotedPostId?: string;
  quotedPost?: PostRecord | FirestoreData | null;
  visibility?: Visibility | string;
  scheduledAt?: TimestampLike | FieldValue;
  poll?: {
    question: string;
    options: Array<{ text: string }>;
    expiresAt?: TimestampLike;
  } | null;
};

type CreateQuotePostInput = {
  userId: string;
  text?: string;
  quotedPostId: string;
  imageURLs?: string[];
  attachments?: Attachment[];
  videoURL?: string;
  visibility?: Visibility | string;
  scheduledAt?: TimestampLike | FieldValue;
};

type UpdatePostInput = {
  contentType?: PostContentKind;
  text?: string;
  imageURLs?: string[];
  imageAlts?: string[];
  attachments?: Attachment[];
  videoURL?: string;
  visibility?: Visibility | string;
  scheduledAt?: TimestampLike | FieldValue;
};

type CreateCommentInput = {
  postId: string;
  userId: string;
  text?: string;
  attachments?: Attachment[];
  imageURL?: string;
  videoURL?: string;
  audioURL?: string;
  fileURL?: string;
  fileName?: string;
  parentId?: string | null;
};

type UpdateCommentInput = {
  text: string;
};

type CreateNotificationInput = {
  userId: string;
  type: string;
  fromUserId?: string;
  postId?: string | null;
  commentId?: string | null;
  storyId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  eventId?: string | null;
  context?: string;
  reactionType?: string | null;
  fromUserDisplayName?: string;
  fromUserUsername?: string;
  fromUserPhotoURL?: string;
  fromUserAvatarColor?: string;
};

type PostViewerStateSets = {
  liked: Set<string>;
  bookmarked: Set<string>;
  reposted: Set<string>;
};

type CommentViewerState = {
  liked: Set<string>;
  likeCounts: Map<string, number>;
};


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function dataWithId<T extends FirestoreData>(id: string, data: T): T & { id: string } {
  return { id, ...data };
}

function toMillis(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime() || 0;
  if (isRecord(value) && typeof value.toDate === 'function') return (value.toDate as () => Date)().getTime();
  if (isRecord(value) && typeof value.seconds === 'number') return value.seconds * 1000;
  return 0;
}

function perfStart(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isPerfDebugEnabled(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('CONNECT_PERF_DEBUG') === '1'; } catch (_) { return false; }
}

function perfDebug(label: string, data: Record<string, unknown>): void {
  if (!isPerfDebugEnabled()) return;
  const safeData = { ...data };
  const docs = Number(safeData.fetchedDocs || safeData.resultCount || safeData.postCount || safeData.requestedCount || 0);
  const queries = Number(safeData.queryCount || safeData.chunkCount || 0);
  const root = globalThis as typeof globalThis & { __CONNECT_PERF_SUMMARY__?: { docs: number; queries: number; events: number } };
  root.__CONNECT_PERF_SUMMARY__ ||= { docs: 0, queries: 0, events: 0 };
  root.__CONNECT_PERF_SUMMARY__.docs += Number.isFinite(docs) ? docs : 0;
  root.__CONNECT_PERF_SUMMARY__.queries += Number.isFinite(queries) ? queries : 0;
  root.__CONNECT_PERF_SUMMARY__.events += 1;
  console.groupCollapsed(`[ConnectPerf] ${label}`);
  console.debug(safeData);
  console.debug('summary', root.__CONNECT_PERF_SUMMARY__);
  console.groupEnd();
}

function buildUserSearchFields(profile: { displayName?: string; username?: string; email?: string }): { usernameLower: string; displayNameLower: string; searchKeywords: string[] } {
  const usernameLower = stringValue(profile.username).toLowerCase();
  const displayNameLower = stringValue(profile.displayName).toLowerCase();
  const emailName = stringValue(profile.email).split('@')[0]?.toLowerCase() || '';
  const keywords = new Set<string>();
  [usernameLower, displayNameLower, emailName].forEach((value) => {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (!compact) return;
    compact.split(' ').forEach(part => {
      const token = part.trim();
      for (let i = 2; i <= Math.min(token.length, 20); i += 1) keywords.add(token.slice(0, i));
    });
    for (let i = 2; i <= Math.min(compact.length, 20); i += 1) keywords.add(compact.slice(0, i));
  });
  return { usernameLower, displayNameLower, searchKeywords: Array.from(keywords).slice(0, 60) };
}

function normalizePollOptions(value: unknown): PostPollOption[] {
  const rawOptions = Array.isArray(value) ? value : Object.values(isRecord(value) ? value : {});
  return rawOptions.filter(isRecord).map(option => ({
    text: stringValue(option.text),
    votes: stringArray(option.votes),
  }));
}

function toPostRecord(data: unknown, id: string): PostRecord {
  const raw = isRecord(data) ? data : {};
  return { ...toPost(raw, id), ...raw, id } as PostRecord;
}

function toStoryRecord(data: unknown, id: string): StoryRecord {
  const raw = isRecord(data) ? data : {};
  return { ...toStory(raw, id), ...raw, id } as StoryRecord;
}

const VIEWER_STATE_CHUNK_SIZE = 10;
const _viewerStateCache = new Map<string, boolean>();

function chunkStrings(values: string[], size = VIEWER_STATE_CHUNK_SIZE): string[][] {
  const unique = [...new Set(values.filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

function notificationSenderSummary(notif: Partial<NotificationRecord> | FirestoreData | null | undefined): UserProfileRecord | null {
  if (!notif) return null;
  const uid = stringValue(notif.fromUserId);
  const displayName = stringValue(notif.fromUserDisplayName);
  const username = stringValue(notif.fromUserUsername);
  const photoURL = stringValue(notif.fromUserPhotoURL);
  const avatarColor = stringValue(notif.fromUserAvatarColor);
  if (!uid || (!displayName && !username && !photoURL && !avatarColor)) return null;
  return { id: uid, uid, displayName: displayName || username || 'User', username, photoURL, avatarColor } as UserProfileRecord;
}

export async function createUserProfile(uid: string, data: CreateUserProfileInput): Promise<UserProfileRecord> {
  const userRef = doc(db, 'users', uid);
  const avatarColor = generateAvatarColor(data.displayName || data.email);
  const profile = {
    uid,
    displayName: data.displayName || data.email?.split('@')[0] || 'User',
    username: data.username || (data.displayName || data.email?.split('@')[0] || 'user').toLowerCase().replace(/\s+/g, '_'),
    email: data.email || '',
    photoURL: data.photoURL || '',
    coverURL: data.coverURL || '',
    avatarColor: data.avatarColor || avatarColor,
    bio: data.bio || '',
    friendsCount: 0,
    ...buildUserSearchFields({ displayName: data.displayName || data.email?.split('@')[0] || 'User', username: data.username || (data.displayName || data.email?.split('@')[0] || 'user').toLowerCase().replace(/\s+/g, '_'), email: data.email || '' }),
    createdAt: serverTimestamp(),
  };
  await setDoc(userRef, profile);
  return { id: uid, ...profile };
}

/**
 * ユーザープロフィールを取得
 */
const _profileCache: ProfileCache = {};
const _profileRequests = new Map<string, Promise<UserProfileRecord | null>>();
const _freshProfileRequests = new Map<string, Promise<UserProfileRecord | null>>();
const _friendIdsCache: FriendIdsCache = new Map();
const _friendIdsRequests = new Map<string, Promise<string[]>>();
const FRIEND_CACHE_TTL = 60 * 1000;

function normalizeProfile(snap: DocumentSnapshot): UserProfileRecord {
  const data = snap.data();
  return { ...toUserProfile(data, stringValue(data.uid, snap.id)), ...dataWithId(snap.id, data), uid: stringValue(data.uid, snap.id) } as UserProfileRecord;
}
type GetUserProfileOptions = { fresh?: boolean };

export async function getUserProfilesByIds(userIds: string[], options: GetUserProfileOptions = {}): Promise<Record<string, UserProfileRecord | null>> {
  const result: Record<string, UserProfileRecord | null> = {};
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  await Promise.all(uniqueIds.map(async (uid) => {
    result[uid] = await getUserProfile(uid, options).catch((): null => null);
  }));
  return result;
}

const _displayProfileRequests = new Map<string, Promise<UserProfileRecord | null>>();

/** Resolve current author display data with the Worker profile as the source
 * of truth for migrated R2 avatar URLs. */
export async function getDisplayUserProfile(uid: string): Promise<UserProfileRecord | null> {
  if (!uid) return null;
  const existing = _displayProfileRequests.get(uid);
  if (existing) return existing;
  const request = (async (): Promise<UserProfileRecord | null> => {
    const [firestoreProfile, latestData] = await Promise.all([
      getUserProfile(uid, { fresh: true }).catch((): null => null),
      fetchLatestProfileProjectionData(uid).catch((): null => null),
    ]);
    const latestProfile = latestData ? buildLatestProfileProjection(uid, latestData, firestoreProfile) : null;
    return mergeLatestDisplayProfile(firestoreProfile, latestProfile) as UserProfileRecord | null;
  })();
  _displayProfileRequests.set(uid, request);
  void request.finally(() => {
    if (_displayProfileRequests.get(uid) === request) _displayProfileRequests.delete(uid);
  }).catch(() => { /* The caller receives the original read error. */ });
  return request;
}

async function fetchLatestProfileProjectionDataByIds(userIds: string[]): Promise<Record<string, Record<string, unknown>>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return {};
  const result: Record<string, Record<string, unknown>> = {};
  const chunks = chunkStrings(ids, 50);
  const payloads = await Promise.all(chunks.map(async (chunk) => {
    const params = new URLSearchParams();
    chunk.forEach((uid) => params.append('id', uid));
    const response = await fetch(`/api/profiles?${params.toString()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`profile_batch_read_failed_${response.status}`);
    return response.json().catch((): null => null) as Promise<{ profiles?: unknown } | null>;
  }));
  payloads.forEach((payload) => {
    if (!Array.isArray(payload?.profiles)) return;
    payload.profiles.forEach((value) => {
      if (!isRecord(value)) return;
      const uid = stringValue(value.uid, stringValue(value.id));
      if (uid) result[uid] = value;
    });
  });
  return result;
}

async function mergeProfilesWithLatestProjection(storedProfiles: Record<string, UserProfileRecord | null>): Promise<Record<string, UserProfileRecord | null>> {
  const ids = Object.keys(storedProfiles).filter(Boolean);
  let latestById: Record<string, Record<string, unknown>> = {};
  try {
    latestById = await fetchLatestProfileProjectionDataByIds(ids);
  } catch {
    // Compatibility with Workers that predate the batch route, and a narrow
    // fallback if that route has a transient failure.
    const entries = await Promise.all(ids.map(async (uid) => [uid, await fetchLatestProfileProjectionData(uid).catch((): null => null)] as const));
    latestById = Object.fromEntries(entries.filter((entry): entry is readonly [string, Record<string, unknown>] => !!entry[1]));
  }
  const result: Record<string, UserProfileRecord | null> = {};
  ids.forEach((uid) => {
    const stored = storedProfiles[uid];
    const latest = latestById[uid];
    const projection = latest ? buildLatestProfileProjection(uid, latest, stored) : null;
    result[uid] = (mergeLatestDisplayProfile(stored, projection) as UserProfileRecord | null) || stored;
  });
  return result;
}

export async function getDisplayUserProfilesByIds(userIds: string[]): Promise<Record<string, UserProfileRecord | null>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const storedProfiles = await getUserProfilesByIds(uniqueIds, { fresh: true });
  return mergeProfilesWithLatestProjection(storedProfiles);
}

async function readViewerDocs(collectionName: string, docIds: string[], cachePrefix: string): Promise<Set<string>> {
  const foundDocs = new Set<string>();
  const missing: string[] = [];
  docIds.forEach((docId) => {
    const cacheKey = `${cachePrefix}:${docId}`;
    if (_viewerStateCache.get(cacheKey)) foundDocs.add(docId);
    else if (!_viewerStateCache.has(cacheKey)) missing.push(docId);
  });
  for (const chunk of chunkStrings(missing)) {
    const snap = await getDocs(query(collection(db, collectionName), where(documentId(), 'in', chunk))).catch((): null => null);
    const found = new Set<string>();
    snap?.forEach(docSnap => found.add(docSnap.id));
    chunk.forEach(docId => {
      const exists = found.has(docId);
      _viewerStateCache.set(`${cachePrefix}:${docId}`, exists);
      if (exists) foundDocs.add(docId);
    });
  }
  return foundDocs;
}

export async function getPostViewerStates(postIds: string[], userId: string): Promise<PostViewerStateSets> {
  const ids = [...new Set(postIds.filter(Boolean))];
  const liked = new Set<string>();
  const bookmarked = new Set<string>();
  const reposted = new Set<string>();
  if (!userId || ids.length === 0) return { liked, bookmarked, reposted };

  const suffix = `_${userId}`;
  const [likeDocs, bookmarkDocs, repostDocs] = await Promise.all([
    readViewerDocs('likes', ids.map(postId => `${postId}_${userId}`), 'like'),
    readViewerDocs('bookmarks', ids.map(postId => `${userId}_${postId}`), 'bookmark'),
    readViewerDocs('reposts', ids.map(postId => `${userId}_${postId}`), 'repost'),
  ]);
  likeDocs.forEach(docId => liked.add(docId.endsWith(suffix) ? docId.slice(0, -suffix.length) : docId));
  bookmarkDocs.forEach(docId => bookmarked.add(docId.slice(userId.length + 1)));
  repostDocs.forEach(docId => reposted.add(docId.slice(userId.length + 1)));
  return { liked, bookmarked, reposted };
}

export async function getCommentViewerStates(commentIds: string[], userId = '', countCommentIds: string[] = commentIds): Promise<CommentViewerState> {
  const start = perfStart();
  const ids = [...new Set(commentIds.filter(Boolean))];
  const countIds = [...new Set(countCommentIds.filter(Boolean))];
  const liked = new Set<string>();
  const likeCounts = new Map<string, number>();
  countIds.forEach(id => likeCounts.set(id, 0));
  if (ids.length === 0 && countIds.length === 0) return { liked, likeCounts };

  let queryCount = 0;
  const likeDocsPromise = userId && ids.length > 0
    ? readViewerDocs('likes', ids.map(commentId => `comment_${commentId}_${userId}`), 'comment-like')
    : Promise.resolve(new Set<string>());
  const countPromise = (async () => {
    for (const chunk of chunkStrings(countIds)) {
      queryCount += 1;
      const snap = await getDocs(query(collection(db, 'likes'), where('commentId', 'in', chunk))).catch((): null => null);
      snap?.forEach(docSnap => {
        const commentId = stringValue(docSnap.data().commentId);
        if (commentId) likeCounts.set(commentId, (likeCounts.get(commentId) || 0) + 1);
      });
    }
  })();

  const [likeDocs] = await Promise.all([likeDocsPromise, countPromise]);
  if (userId) {
    const prefix = 'comment_';
    const suffix = `_${userId}`;
    likeDocs.forEach(docId => {
      if (docId.startsWith(prefix) && docId.endsWith(suffix)) liked.add(docId.slice(prefix.length, -suffix.length));
    });
  }
  perfDebug('getCommentViewerStates', { requestedCount: commentIds.length, countFallbackCount: countIds.length, uniqueCount: ids.length, resultCount: likeCounts.size, queryCount, likedCount: liked.size, durationMs: Math.round(perfStart() - start) });
  return { liked, likeCounts };
}
export async function enrichCommentRecords<T extends { id?: string; userId?: string; likesCount?: number }>(comments: T[], currentUserId = ''): Promise<Array<T & { author: UserProfileRecord | null; liked: boolean; likesCount: number }>> {
  const start = perfStart();
  const ids = comments.map(comment => stringValue(comment.id)).filter(Boolean);
  const countFallbackIds = comments
    .filter(comment => typeof comment.likesCount !== 'number')
    .map(comment => stringValue(comment.id))
    .filter(Boolean);
  const states = await getCommentViewerStates(ids, currentUserId, countFallbackIds).catch((): CommentViewerState => ({ liked: new Set<string>(), likeCounts: new Map<string, number>() }));
  // Comment documents may contain an author snapshot from creation time. It
  // is only a fallback for deleted/unavailable users; current profile data is
  // always resolved by the immutable user ID at display time.
  const authorIds = [...new Set(comments.map(comment => stringValue(comment.userId)).filter(Boolean))];
  const profiles = await getDisplayUserProfilesByIds(authorIds);
  const enriched = comments.map((comment) => {
    const id = stringValue(comment.id);
    // The comment snapshot is legacy data and is never a display fallback.
    // Keep the result keyed only by immutable userId so one user cannot render
    // different historical profile values across comments.
    const author = profiles[stringValue(comment.userId)] ?? null;
    const likesCount = typeof comment.likesCount === 'number' ? comment.likesCount : (states.likeCounts.get(id) ?? 0);
    return { ...comment, author, liked: states.liked.has(id), likesCount };
  });
  perfDebug('enrichCommentRecords', { requestedCount: comments.length, profileLookupCount: authorIds.length, likeCountFallbackCount: countFallbackIds.length, resultCount: enriched.length, durationMs: Math.round(perfStart() - start) });
  return enriched;
}
export async function getUserProfile(uid: string, options: GetUserProfileOptions = {}): Promise<UserProfileRecord | null> {
  if (!uid) return null;
  const fresh = options.fresh === true;
  if (!fresh && _profileCache[uid]) return _profileCache[uid];
  const requestMap = fresh ? _freshProfileRequests : _profileRequests;
  const existing = requestMap.get(uid);
  if (existing) return existing;
  const request = (async (): Promise<UserProfileRecord | null> => {
    const userRef = doc(db, 'users', uid);
    // Display paths opt into a server read so another tab/device's profile
    // edit is visible immediately instead of being hidden by the local cache.
    const snap = fresh
      ? await getDocFromServer(userRef).catch(() => getDoc(userRef))
      : await getDoc(userRef);
    if (!snap.exists()) return null;
    const profile = normalizeProfile(snap);
    _profileCache[uid] = profile;
    _profileCache[profile.uid] = profile;
    return profile;
  })();
  requestMap.set(uid, request);
  void request.finally(() => {
    if (requestMap.get(uid) === request) requestMap.delete(uid);
  }).catch(() => { /* The caller receives the original read error. */ });
  return request;
}

export async function getLatestProfileProjection(uid: string): Promise<UserProfileRecord | null> {
  if (!uid) return null;
  const latest = await fetchLatestProfileProjectionData(uid);
  return latest ? buildLatestProfileProjection(uid, latest, _profileCache[uid] || null) : null;
}

async function fetchLatestProfileProjectionData(uid: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`/api/profiles/${encodeURIComponent(uid)}?includePosts=false`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`profile_read_failed_${response.status}`);
  const payload = await response.json().catch((): null => null) as { profile?: Record<string, unknown> | null } | null;
  if (!payload?.profile || !isRecord(payload.profile)) return null;
  return payload.profile;
}

function buildLatestProfileProjection(
  uid: string,
  latest: Record<string, unknown>,
  fallback: UserProfileRecord | null,
): UserProfileRecord {
  const current = fallback || _profileCache[uid] || ({ id: uid, uid } as UserProfileRecord);
  const photoURL = stringValue(latest.avatarUrl) || stringValue(latest.photoURL);
  const coverURL = stringValue(latest.coverUrl) || stringValue(latest.coverURL);
  const profile: UserProfileRecord = {
    ...current,
    id: uid,
    uid,
    ...(typeof latest.displayName === 'string' ? { displayName: latest.displayName } : {}),
    ...(typeof latest.username === 'string' ? { username: latest.username } : {}),
    ...(typeof latest.bio === 'string' ? { bio: latest.bio } : {}),
    // An empty D1 field must not erase a legacy Firebase image during migration.
    ...(photoURL ? { photoURL, profileImage: '', profilePhotoPreviewURL: '' } : {}),
    ...(coverURL ? { coverURL, coverImage: '', coverPhotoPreviewURL: '' } : {}),
    ...(typeof latest.avatarColor === 'string' ? { avatarColor: latest.avatarColor } : {}),
  };
  _profileCache[uid] = profile;
  return profile;
}

export function clearProfileCache() {
  Object.keys(_profileCache).forEach(k => delete _profileCache[k]);
  _friendIdsCache.clear();
}

/**
 * ユーザープロフィールを更新
 */
export async function updateUserProfile(uid: string, data: UpdateUserProfileInput): Promise<void> {
  const updateData = { ...data };
  if (updateData.displayName) {
    updateData.avatarColor = generateAvatarColor(updateData.displayName);
  }
  if (updateData.displayName || updateData.username || updateData.email) {
    const current = _profileCache[uid] || await getUserProfile(uid).catch((): null => null);
    Object.assign(updateData, buildUserSearchFields({
      displayName: stringValue(updateData.displayName, current?.displayName || ''),
      username: stringValue(updateData.username, current?.username || ''),
      email: stringValue(updateData.email, current?.email || ''),
    }));
  }

  const publicProfileFields = ['displayName', 'username', 'bio', 'photoURL', 'coverURL', 'avatarColor'];
  if (publicProfileFields.some(field => Object.prototype.hasOwnProperty.call(updateData, field))) {
    const user = auth.currentUser;
    if (!user || user.uid !== uid) throw new Error('プロフィールを更新するには本人としてログインしてください');
    const patch: Record<string, unknown> = {};
    for (const field of ['displayName', 'username', 'bio', 'avatarColor']) {
      if (Object.prototype.hasOwnProperty.call(updateData, field)) patch[field] = updateData[field];
    }
    if (Object.prototype.hasOwnProperty.call(updateData, 'photoURL')) patch.avatarUrl = updateData.photoURL;
    if (Object.prototype.hasOwnProperty.call(updateData, 'coverURL')) patch.coverUrl = updateData.coverURL;
    const response = await fetch(`/api/profiles/${encodeURIComponent(uid)}`, {
      method: 'PATCH',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await response.json().catch((): null => null) as { error?: unknown; profile?: Record<string, unknown> | null } | null;
    if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `profile_update_failed_${response.status}`);

    // Keep Firebase's legacy profile/search projection synchronized for existing readers.
    await updateDoc(doc(db, 'users', uid), updateData);
    const current = _profileCache[uid] || ({ id: uid, uid } as UserProfileRecord);
    _profileCache[uid] = {
      ...current,
      ...updateData,
      id: uid,
      uid,
      ...(typeof payload?.profile?.avatarUrl === 'string' ? { photoURL: payload.profile.avatarUrl } : {}),
      ...(typeof payload?.profile?.coverUrl === 'string' ? { coverURL: payload.profile.coverUrl } : {}),
    } as UserProfileRecord;
    return;
  }

  const userRef = doc(db, 'users', uid);
  await updateDoc(userRef, updateData);
  if (_profileCache[uid]) _profileCache[uid] = { ..._profileCache[uid], ...updateData };
}

export async function uploadProfileImage(file: File, uid: string, kind: 'avatar' | 'cover'): Promise<string> {
  const user = auth.currentUser;
  if (!user || user.uid !== uid) throw new Error('プロフィール画像をアップロードするには本人としてログインしてください');
  if (file.size <= 0 || file.size > 15 * 1024 * 1024) throw new Error('画像は15MB以下のファイルを選んでください');
  const extensions: Record<string, string> = { 'image/avif': 'avif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const extension = extensions[file.type.toLowerCase()];
  if (!extension) throw new Error('JPEG、PNG、WebP、AVIF形式の画像を選んでください');
  const key = `profiles/${uid}/${kind}_${Date.now()}_${crypto.randomUUID()}.${extension}`;
  const path = `/media/${key.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(path, {
    method: 'PUT',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': file.type },
    body: file,
  });
  const payload = await response.json().catch((): null => null) as { url?: unknown; error?: unknown } | null;
  if (!response.ok || typeof payload?.url !== 'string' || !payload.url.startsWith(`/media/profiles/${uid}/`)) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `profile_image_upload_failed_${response.status}`);
  }
  return payload.url;
}

/**
 * displayNameまたはusernameでユーザーを検索
 */
export async function searchUsers(queryText: string): Promise<UserProfileRecord[]> {
  const start = perfStart();
  const qText = queryText.trim().toLowerCase();
  if (qText.length < 2) return [];
  const usersRef = collection(db, 'users');
  const resultMap = new Map<string, UserProfileRecord>();
  let queryCount = 0;
  let fetchedDocs = 0;

  const keywordSnap = await getDocs(query(usersRef, where('searchKeywords', 'array-contains', qText), limit(30))).catch((): null => null);
  queryCount += 1;
  keywordSnap?.forEach(docSnap => {
    fetchedDocs += 1;
    const profile = normalizeProfile(docSnap);
    resultMap.set(profile.uid || profile.id, profile);
    _profileCache[profile.uid || profile.id] = profile;
  });

  if (resultMap.size < 10) {
    const fallbackSnap = await getDocs(query(usersRef, limit(80)));
    queryCount += 1;
    fallbackSnap.forEach(docSnap => {
      fetchedDocs += 1;
      const data = docSnap.data();
      const name = (data.displayName || '').toLowerCase();
      const uname = (data.username || '').toLowerCase();
      if (name.includes(qText) || uname.includes(qText)) {
        const profile = normalizeProfile(docSnap);
        resultMap.set(profile.uid || profile.id, profile);
        _profileCache[profile.uid || profile.id] = profile;
      }
    });
  }

  const results = Array.from(resultMap.values()).slice(0, 30);
  const latest = await mergeProfilesWithLatestProjection(Object.fromEntries(results.map((profile) => [profile.uid || profile.id, profile])));
  const displayResults = results.map((profile) => latest[profile.uid || profile.id] || profile);
  perfDebug('searchUsers', { queryCount, fetchedDocs, resultCount: displayResults.length, durationMs: Math.round(perfStart() - start) });
  return displayResults;
}

/**
 * 全ユーザーを取得（デモ用）
 */
export async function getAllUsers(limitCount = 100): Promise<UserProfileRecord[]> {
  const usersRef = collection(db, 'users');
  const snap = await getDocs(query(usersRef, limit(Math.max(1, Math.min(limitCount, 200)))));
  const users: UserProfileRecord[] = [];
  snap.forEach(doc => {
    const profile = normalizeProfile(doc);
    _profileCache[profile.uid || profile.id] = profile;
    users.push(profile);
  });
  const latest = await mergeProfilesWithLatestProjection(Object.fromEntries(users.map((profile) => [profile.uid || profile.id, profile])));
  return users.map((profile) => latest[profile.uid || profile.id] || profile);
}

// ============================================================
// 投稿
// ============================================================

/**
 * テキストからハッシュタグを抽出
 */
export function parseHashtags(text: string): string[] {
  return extractHashtagKeys(text);
}

export function parseMentions(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/(^|\s)@([A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff-]+)/g) || [];
  return [...new Set(matches.map(value => value.replace(/^.*@/, '').toLowerCase()).filter(Boolean))];
}

const R2_MULTIPART_THRESHOLD = 8 * 1024 * 1024;
const R2_MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024;
const R2_MULTIPART_PARALLEL_PARTS = 3;

function mediaEndpoint(path: string): string {
  return `/media/${path.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function mediaContentType(file: UploadableFile): string {
  // Keep the original File object as the MIME sniffer caches byte detection by
  // object identity (important for extensionless media with an empty browser MIME).
  return resolveAttachmentMimeType(file);
}

function xhrMediaRequest<T>(options: {
  method: 'PUT' | 'POST' | 'DELETE';
  url: string;
  token: string;
  body: XMLHttpRequestBodyInit | null;
  contentType?: string;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method, options.url);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('Authorization', `Bearer ${options.token}`);
    if (options.contentType) xhr.setRequestHeader('Content-Type', options.contentType);
    if (options.onProgress) xhr.upload.onprogress = (event) => options.onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
    xhr.onerror = () => reject(new Error('media_upload_network_error'));
    xhr.ontimeout = () => reject(new Error('media_upload_timed_out'));
    xhr.onload = () => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(xhr.responseText) as Record<string, unknown>; } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload as T);
      else {
        const code = typeof payload.error === 'string' ? payload.error : `media_upload_failed_${xhr.status}`;
        console.warn(JSON.stringify({ event: 'media_upload_request_failed', method: options.method, status: xhr.status, code }));
        reject(new Error(code));
      }
    };
    xhr.send(options.body);
  });
}

function uploadedMediaURL(payload: { key?: unknown; url?: unknown }, path: string): string {
  if (payload.key !== path || typeof payload.url !== 'string') throw new Error('media_upload_response_invalid');
  const expectedPath = mediaEndpoint(path);
  const url = new URL(payload.url, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== expectedPath) throw new Error('media_upload_response_invalid');
  return `${url.pathname}${url.search}`;
}

/** Upload post/story attachments through the authenticated R2 media route. */
export async function uploadFile(file: UploadableFile, path: string, onProgress: ProgressHandler | null = null): Promise<string> {
  if (/^(?:dm|messages|chat)\//i.test(path)) throw new Error('DM attachments are no longer supported');
  const postUpload = /^posts\/([A-Za-z0-9_-]{1,160})\//.exec(path);
  if (postUpload && auth.currentUser?.uid !== postUpload[1]) throw new Error('media_upload_owner_mismatch');
  if (!postUpload) {
    const { getStorage, ref, uploadBytes, uploadBytesResumable, getDownloadURL } = await import('firebase/storage');
    const storageRef = ref(getStorage(app), path);
    if (onProgress) {
      const task = uploadBytesResumable(storageRef, file, { contentType: file.type || 'application/octet-stream' });
      const snapshot = await new Promise((resolve, reject) => {
        task.on('state_changed', snap => onProgress(snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0, snap), reject, () => resolve(task.snapshot));
      });
      return getDownloadURL((snapshot as typeof task.snapshot).ref);
    }
    const snapshot = await uploadBytes(storageRef, file, { contentType: file.type || 'application/octet-stream' });
    return getDownloadURL(snapshot.ref);
  }
  if (!auth.currentUser) throw new Error('authentication_required');
  const token = await auth.currentUser.getIdToken();
  const endpoint = mediaEndpoint(path);
  const contentType = mediaContentType(file);
  const reportProgress = (loaded: number, total: number): void => {
    if (onProgress) onProgress(total ? Math.min(100, loaded / total * 100) : 0, { bytesTransferred: loaded, totalBytes: total || file.size });
  };

  if (file.size <= R2_MULTIPART_THRESHOLD) {
    const result = await xhrMediaRequest<{ key?: unknown; url?: unknown }>({
      method: 'PUT', url: endpoint, token, body: file, contentType,
      onProgress: onProgress ? reportProgress : undefined,
    });
    reportProgress(file.size, file.size);
    return uploadedMediaURL(result, path);
  }

  const initiated = await xhrMediaRequest<{ uploadId?: unknown }>({
    method: 'POST', url: endpoint, token,
    body: JSON.stringify({ action: 'initiate', contentType, size: file.size }),
    contentType: 'application/json',
  });
  if (typeof initiated.uploadId !== 'string' || !initiated.uploadId) throw new Error('media_upload_response_invalid');
  const uploadId = initiated.uploadId;
  const partCount = Math.ceil(file.size / R2_MULTIPART_CHUNK_BYTES);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const loadedByPart = new Array<number>(partCount).fill(0);
  const reportTotalProgress = (): void => {
    if (onProgress) reportProgress(loadedByPart.reduce((total, loaded) => total + loaded, 0), file.size);
  };

  try {
    for (let batchStart = 0; batchStart < partCount; batchStart += R2_MULTIPART_PARALLEL_PARTS) {
      const batch = Array.from({ length: Math.min(R2_MULTIPART_PARALLEL_PARTS, partCount - batchStart) }, (_, offset) => batchStart + offset);
      const uploaded = await Promise.all(batch.map(async (partIndex) => {
        const start = partIndex * R2_MULTIPART_CHUNK_BYTES;
        const end = Math.min(file.size, start + R2_MULTIPART_CHUNK_BYTES);
        const partNumber = partIndex + 1;
        const query = new URLSearchParams({ uploadId, partNumber: String(partNumber) });
        const result = await xhrMediaRequest<{ partNumber?: unknown; etag?: unknown }>({
          method: 'PUT', url: `${endpoint}?${query}`, token,
          body: file.slice(start, end), contentType: 'application/octet-stream',
          onProgress: onProgress ? (loaded) => { loadedByPart[partIndex] = loaded; reportTotalProgress(); } : undefined,
        });
        if (result.partNumber !== partNumber || typeof result.etag !== 'string' || !result.etag) throw new Error('media_upload_response_invalid');
        loadedByPart[partIndex] = end - start;
        reportTotalProgress();
        return { partNumber, etag: result.etag };
      }));
      parts.push(...uploaded);
    }
    parts.sort((left, right) => left.partNumber - right.partNumber);
    const completed = await xhrMediaRequest<{ key?: unknown; url?: unknown }>({
      method: 'POST', url: endpoint, token,
      body: JSON.stringify({ action: 'complete', uploadId, size: file.size, parts }),
      contentType: 'application/json',
    });
    reportProgress(file.size, file.size);
    return uploadedMediaURL(completed, path);
  } catch (cause) {
    const abortQuery = new URLSearchParams({ uploadId });
    void xhrMediaRequest({ method: 'DELETE', url: `${endpoint}?${abortQuery}`, token, body: null }).catch(() => {});
    throw cause;
  }
}

function createPreviewStoragePath(path: string): string {
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex <= path.lastIndexOf('/')) return `${path}_preview.webp`;
  return `${path.slice(0, dotIndex)}_preview.webp`;
}


export async function deleteAttachmentFiles(attachments: Attachment[] = [], extraStoragePaths: string[] = []): Promise<void> {
  const paths = new Set<string>();
  for (const attachment of attachments) {
    if (attachment?.storagePath) paths.add(attachment.storagePath);
    if (attachment?.previewStoragePath) paths.add(attachment.previewStoragePath);
  }
  extraStoragePaths.filter(Boolean).forEach(path => paths.add(path));
  if (paths.size === 0) return;
  const entries = Array.from(paths);
  const { getStorage, ref, deleteObject } = await import('firebase/storage');
  const storage = getStorage(app);
  const results = await Promise.allSettled(entries.map(async (path) => {
    if (/^(?:posts|stories|profiles)\/[A-Za-z0-9_-]{1,160}\//.test(path) && auth.currentUser) {
      const token = await auth.currentUser.getIdToken();
      const response = await fetch(mediaEndpoint(path), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`r2_media_delete_failed_${response.status}`);
      const result = await response.json().catch((): null => null) as { deleted?: unknown } | null;
      if (result?.deleted === true) return;
    }
    // Older records can still point to Firebase objects; keep their cleanup path.
    await deleteObject(ref(storage, path));
  }));
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.warn('Attachment cleanup failed:', entries[index], result.reason);
  });
}

export async function uploadAttachmentFile(file: File, path: string, onProgress: ProgressHandler | null = null): Promise<Attachment> {
  const metadata = await readAttachmentMetadata(file).catch((): Partial<Attachment> => ({}));
  const url = await uploadFile(file, path, onProgress);
  let previewUrl = '';
  let previewStoragePath = '';
  const isAnimatedGif = resolveAttachmentMimeType(file) === 'image/gif';
  const previewFile = isAnimatedGif ? null : await createImagePreviewFile(file).catch((): File | null => null);
  if (previewFile) {
    previewStoragePath = createPreviewStoragePath(path);
    previewUrl = await uploadFile(previewFile, previewStoragePath).catch(() => {
      previewStoragePath = '';
      return '';
    });
  }
  return createAttachmentRecord(file, url, { ...metadata, storagePath: path, previewUrl, previewStoragePath });
}

// ============================================================
// ストーリー / 近況
// ============================================================

export const STORY_REACTIONS = ['👍', '❤️', '😂', '😮', '🔥'];
const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

function isActiveStory(story: StoryRecord | FirestoreData): boolean {
  if (story.deletedAt) return false;
  const expiresAt = toMillis(story.expiresAt);
  return expiresAt > Date.now();
}

export async function createStory(data: CreateStoryInput): Promise<StoryRecord> {
  const now = Date.now();
  const expiresAt = Timestamp.fromDate(new Date(now + STORY_LIFETIME_MS));
  const story = {
    authorId: data.authorId,
    text: data.text || '',
    mediaUrl: data.mediaUrl || '',
    mediaType: data.mediaType || 'text',
    thumbnailUrl: data.thumbnailUrl || '',
    previewStoragePath: data.previewStoragePath || '',
    mediaStoragePath: data.mediaStoragePath || '',
    mediaWidth: Number.isFinite(Number(data.mediaWidth)) ? Number(data.mediaWidth) : null,
    mediaHeight: Number.isFinite(Number(data.mediaHeight)) ? Number(data.mediaHeight) : null,
    mediaDuration: Number.isFinite(Number(data.mediaDuration)) ? Number(data.mediaDuration) : null,
    audioUrl: data.audioUrl || '',
    audioTitle: data.audioTitle || '',
    audioPresetId: data.audioPresetId || '',
    muteVideo: !!data.muteVideo,
    overlayText: data.overlayText || '',
    background: data.background || 'linear-gradient(135deg, #6366f1, #8b5cf6)',
    visibility: data.visibility || 'public',
    viewCount: 0,
    reactionCount: 0,
    deletedAt: null as null,
    createdAt: serverTimestamp(),
    expiresAt,
  };
  const ref = await addDoc(collection(db, 'stories'), story);
  return { id: ref.id, ...story };
}

export async function deleteStory(storyId: string, userId: string): Promise<void> {
  const storyRef = doc(db, 'stories', storyId);
  const snap = await getDoc(storyRef);
  if (!snap.exists()) throw new Error('ストーリーが見つかりません');
  if (snap.data().authorId !== userId) throw new Error('削除権限がありません');
  await updateDoc(storyRef, { deletedAt: serverTimestamp() });
  const data = snap.data();
  await deleteAttachmentFiles([], [stringValue(data.mediaStoragePath), stringValue(data.previewStoragePath)]).catch((): void => {});
}

export async function getActiveStoriesForUsers(userIds: string[] = [], viewerId = ''): Promise<StoryGroup[]> {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueIds.length === 0) return [];
  const stories: StoryRecord[] = [];
  try {
    const snap = await getDocs(query(collection(db, 'stories'), orderBy('createdAt', 'desc'), limit(300)));
    snap.forEach(d => {
      const data = d.data();
      if (uniqueIds.includes(data.authorId) && isActiveStory(data)) {
        stories.push(toStoryRecord(data, d.id));
      }
    });
  } catch (e) {
    console.error('getActiveStoriesForUsers error:', e);
    return [];
  }

  let viewed = new Set<string>();
  if (viewerId) {
    try {
      const viewSnap = await getDocs(query(collection(db, 'storyViews'), where('viewerId', '==', viewerId), limit(500)));
      viewSnap.forEach(v => viewed.add(stringValue(v.data().storyId)));
    } catch (e) {}
  }

  const authors: Record<string, StoryGroup> = {};
  for (const story of stories) {
    if (!authors[story.authorId]) {
      const author = await getDisplayUserProfile(story.authorId).catch((): null => null);
      authors[story.authorId] = { authorId: story.authorId, author, stories: [], hasUnseen: false, latestAt: 0 };
    }
    const viewedByMe = story.authorId === viewerId || viewed.has(story.id);
    authors[story.authorId].stories.push({ ...story, viewedByMe });
    authors[story.authorId].hasUnseen = authors[story.authorId].hasUnseen || !viewedByMe;
    authors[story.authorId].latestAt = Math.max(authors[story.authorId].latestAt, toMillis(story.createdAt));
  }

  return Object.values(authors).sort((a, b) => {
    if (a.authorId === viewerId) return -1;
    if (b.authorId === viewerId) return 1;
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
    return b.latestAt - a.latestAt;
  });
}

export async function getHomeStoryGroups(userId: string): Promise<StoryGroup[]> {
  const friends = await getUserFriendIds(userId).catch((): string[] => []);
  return getActiveStoriesForUsers([userId, ...friends], userId);
}

export async function getUserStoryGroup(authorId: string, viewerId: string): Promise<StoryGroup | null> {
  const groups = await getActiveStoriesForUsers([authorId], viewerId);
  return groups[0] || null;
}

export async function markStoryViewed(storyId: string, viewerId: string): Promise<void> {
  if (!storyId || !viewerId) return;
  const viewId = `${storyId}_${viewerId}`;
  const viewRef = doc(db, 'storyViews', viewId);
  const nestedViewRef = doc(db, 'stories', storyId, 'views', viewerId);
  const snap = await getDoc(viewRef);
  const storySnap = await getDoc(doc(db, 'stories', storyId));
  const authorId = storySnap.exists() ? storySnap.data().authorId : '';
  const nestedSnap = await getDoc(nestedViewRef).catch((): null => null);
  if (snap.exists() && nestedSnap?.exists?.()) return;
  const viewData = { storyId, viewerId, authorId, viewedAt: serverTimestamp() };
  if (!snap.exists()) await setDoc(viewRef, viewData);
  if (!nestedSnap?.exists?.()) await setDoc(nestedViewRef, viewData);
  if (!snap.exists() && !nestedSnap?.exists?.()) {
    await updateDoc(doc(db, 'stories', storyId), { viewCount: increment(1) }).catch((): void => {});
  }
}

export async function getStoryViewers(storyId: string, ownerId: string): Promise<StoryViewer[]> {
  const storySnap = await getDoc(doc(db, 'stories', storyId));
  if (!storySnap.exists()) throw new Error('ストーリーが見つかりません');
  if (storySnap.data().authorId !== ownerId) throw new Error('閲覧者一覧を見る権限がありません');
  let snap = await getDocs(query(collection(db, 'stories', storyId, 'views'), limit(500))).catch((): null => null);
  if (!snap || snap.empty) {
    snap = await getDocs(query(collection(db, 'storyViews'), where('storyId', '==', storyId), limit(500)));
  }
  const viewers: StoryViewer[] = [];
  const seenIds = new Set<string>();
  for (const viewDoc of snap.docs) {
    const data = viewDoc.data();
    if (!data.viewerId) continue;
    if (data.viewerId === ownerId) continue;
    if (seenIds.has(data.viewerId)) continue;
    seenIds.add(data.viewerId);
    const profile = await getDisplayUserProfile(data.viewerId).catch((): null => null);
    viewers.push({ id: viewDoc.id, ...data, profile });
  }
  viewers.sort((a, b) => (toMillis(b.viewedAt)) - (toMillis(a.viewedAt)));

  const storedCount = Number(storySnap.data().viewCount || 0);
  if (storedCount !== viewers.length) {
    await updateDoc(doc(db, 'stories', storyId), { viewCount: viewers.length }).catch((): void => {});
  }
  return viewers;
}

export async function voteStoryPoll(storyId: string, optionIndex: number, userId: string): Promise<PostPoll> {
  const storyRef = doc(db, 'stories', storyId);
  const storySnap = await getDoc(storyRef);
  if (!storySnap.exists()) throw new Error('Story not found');
  const story = storySnap.data();
  if (!isActiveStory(story) || !story.poll) throw new Error('Poll unavailable');
  const options = normalizePollOptions(story.poll.options);
  if (!options[optionIndex]) throw new Error('Invalid option');
  if (options.some(option => option.votes.includes(userId))) throw new Error('Already voted');
  await updateDoc(storyRef, {
    [`poll.options.${optionIndex}.votes`]: arrayUnion(userId),
    'poll.totalVotes': increment(1),
  });
  const nextPoll = JSON.parse(JSON.stringify(story.poll));
  nextPoll.options = Array.isArray(nextPoll.options) ? nextPoll.options : Object.values(nextPoll.options || {});
  nextPoll.totalVotes = (nextPoll.totalVotes || 0) + 1;
  if (!nextPoll.options[optionIndex].votes) nextPoll.options[optionIndex].votes = [];
  nextPoll.options[optionIndex].votes.push(userId);
  return nextPoll;
}

export async function reactToStory(storyId: string, senderId: string, reactionType: string): Promise<void> {
  if (!STORY_REACTIONS.includes(reactionType)) throw new Error('リアクションが無効です');
  const reactionId = `${storyId}_${senderId}_${reactionType}`;
  await setDoc(doc(db, 'storyReactions', reactionId), {
    storyId,
    senderId,
    reactionType,
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, 'stories', storyId), { reactionCount: increment(1) }).catch((): void => {});
}

/**
 * 新規投稿を作成（ハッシュタグ・投票対応）
 */
export async function createPost(data: CreatePostInput): Promise<PostRecord> {
  const postRef = collection(db, 'posts');
  const postText = String(data.text || '');
  if (Array.from(postText).length > 1000) throw new Error('投稿本文は1000文字以内で入力してください');
  const hashtags = parseHashtags(postText);
  const mentions = parseMentions(data.text || '');
  const scheduledAt = data.scheduledAt || null;
  const post: WriteData & { poll?: PostPoll | null } = {
    userId: data.userId,
    text: postText,
    contentType: ['user', 'news', 'advertisement', 'system'].includes(data.contentType || 'user') ? (data.contentType || 'user') : 'user',
    imageURLs: data.imageURLs || [],
    imageAlts: Array.isArray(data.imageAlts) ? data.imageAlts : [],
    attachments: sanitizeAttachments(data.attachments),
    videoURL: data.videoURL || '',
    threadId: data.threadId || '',
    threadIndex: Number.isFinite(Number(data.threadIndex)) ? Number(data.threadIndex) : null,
    threadCount: Number.isFinite(Number(data.threadCount)) ? Number(data.threadCount) : null,
    quotedPostId: data.quotedPostId || '',
    quotedPost: data.quotedPost || null,
    hashtags,
    mentions,
    visibility: ['public', 'friends', 'private'].includes(data.visibility) ? data.visibility : 'public',
    scheduledAt,
    editedAt: null as null,
    editHistory: [] as WriteData[],
    viewCount: 0,
    profileClickCount: 0,
    likesCount: 0,
    commentsCount: 0,
    repostsCount: 0,
    createdAt: serverTimestamp(),
  };

  if (data.poll) {
    post.poll = {
      question: data.poll.question,
      options: data.poll.options.map((o): PostPollOption => ({ text: o.text, votes: [] })),
      totalVotes: 0,
      expiresAt: data.poll.expiresAt || Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
      createdAt: serverTimestamp(),
    };
  }

  const docRef = await addDoc(postRef, post);

  return { id: docRef.id, ...post } as PostRecord;
}

export async function createQuotePost({ userId, text = '', quotedPostId, imageURLs = [], attachments = [], videoURL = '', visibility = 'public', scheduledAt = null }: CreateQuotePostInput): Promise<PostRecord> {
  if (!userId || !quotedPostId) throw new Error('引用元の投稿が見つかりません');
  const original = await getPostById(quotedPostId);
  if (!original) throw new Error('引用元の投稿が見つかりません');
  const quotedPost = {
    id: original.id,
    userId: original.userId || '',
    text: original.text || '',
    imageURLs: original.imageURLs || (original.imageURL ? [original.imageURL] : []),
    videoURL: original.videoURL || '',
    createdAt: original.createdAt || null,
  };
  const post = await createPost({ userId, text, imageURLs, attachments, videoURL, quotedPostId, quotedPost, visibility, scheduledAt });
  const eventId = `quote-repost:${post.id}`;
  await updateDoc(doc(db, 'posts', quotedPostId), { repostsCount: increment(1) }).catch((): void => {});
  await setDoc(doc(db, 'reposts', userId + '_' + quotedPostId), {
    postId: quotedPostId,
    userId,
    quotePostId: post.id,
    eventId,
    type: 'quote',
    createdAt: serverTimestamp(),
  }, { merge: true }).catch((): void => {});
  return post;
}

export async function updatePost(postId: string, userId: string, data: UpdatePostInput = {}): Promise<PostRecord> {
  const postRef = doc(db, 'posts', postId);
  const snap = await getDoc(postRef);
  if (!snap.exists()) throw new Error('投稿が見つかりません');
  const current = snap.data();
  if (current.userId !== userId) throw new Error('編集権限がありません');
  if (current.deletedAt || current.moderationStatus === 'removed') throw new Error('削除された投稿は編集できません');
  const nextText = data.text ?? current.text ?? '';
  if (data.text !== undefined && Array.from(String(nextText)).length > 1000) throw new Error('投稿本文は1000文字以内で入力してください');
  const hashtags = parseHashtags(nextText);
  const editEntry = {
    text: current.text || '',
    imageURLs: current.imageURLs || [],
    videoURL: current.videoURL || '',
    attachments: current.attachments || [],
    imageAlts: current.imageAlts || [],
    visibility: current.visibility || 'public',
    editedAt: new Date().toISOString(),
  };
  const nextAttachments = Array.isArray(data.attachments)
    ? sanitizeAttachments(data.attachments)
    : sanitizeAttachments(current.attachments);
  const patch = {
    ...(data.contentType && ['user', 'news', 'advertisement', 'system', 'unclassified'].includes(data.contentType) ? { contentType: data.contentType } : {}),
    text: nextText,
    imageURLs: Array.isArray(data.imageURLs) ? data.imageURLs : (current.imageURLs || []),
    imageAlts: Array.isArray(data.imageAlts) ? data.imageAlts : (current.imageAlts || []),
    attachments: nextAttachments,
    videoURL: data.videoURL ?? current.videoURL ?? '',
    visibility: ['public', 'friends', 'private'].includes(data.visibility) ? data.visibility : (current.visibility || 'public'),
    scheduledAt: data.scheduledAt === undefined ? (current.scheduledAt || null) : data.scheduledAt,
    hashtags,
    editedAt: serverTimestamp(),
    editHistory: arrayUnion(editEntry),
  };
  await updateDoc(postRef, patch);
  if (Array.isArray(data.attachments)) {
    const retainedPaths = new Set<string>();
    nextAttachments.forEach((attachment) => {
      if (attachment.storagePath) retainedPaths.add(attachment.storagePath);
      if (attachment.previewStoragePath) retainedPaths.add(attachment.previewStoragePath);
    });
    const removedAttachments = (Array.isArray(current.attachments) ? current.attachments as Attachment[] : []).filter((attachment) => {
      const paths = [attachment.storagePath, attachment.previewStoragePath].filter(Boolean);
      return paths.length > 0 && paths.every(path => !retainedPaths.has(path));
    });
    await deleteAttachmentFiles(removedAttachments).catch((): void => {});
  }
  return toPostRecord({ ...current, ...patch }, postId);
}

function isPublishedPost(post: Pick<PostRecord, 'scheduledAt'> | FirestoreData): boolean {
  const scheduled = toMillis(post.scheduledAt);
  return !scheduled || scheduled <= Date.now();
}

function canViewPost(post: (Pick<PostRecord, 'scheduledAt' | 'visibility' | 'userId' | 'deletedAt'> | FirestoreData) | null | undefined, viewerId: string, friendIds: string[] = []): boolean {
  if (!post || post.deletedAt || (post as FirestoreData).moderationStatus === 'removed' || !isPublishedPost(post)) return false;
  const visibility = post.visibility || 'public';
  if (visibility === 'public') return true;
  if (!viewerId) return false;
  if (post.userId === viewerId) return true;
  if (visibility === 'friends') return friendIds.includes(post.userId);
  return false;
}
export async function getPostsByIds(postIds: string[], viewerId = '', friendIds: string[] = [], enforceVisibility = false): Promise<PostRecord[]> {
  const start = perfStart();
  const ids = [...new Set(postIds.filter(Boolean))];
  const postMap = new Map<string, PostRecord>();
  let queryCount = 0;
  for (const chunk of chunkStrings(ids)) {
    const snap = await getDocs(query(collection(db, 'posts'), where(documentId(), 'in', chunk))).catch((): null => null);
    queryCount += 1;
    snap?.forEach(docSnap => {
      const data = docSnap.data();
      if (!data.deletedAt && data.moderationStatus !== 'removed' && (!enforceVisibility || canViewPost(data, viewerId, friendIds))) postMap.set(docSnap.id, toPostRecord(data, docSnap.id));
    });
  }
  const posts = postIds.map(id => postMap.get(id)).filter((post): post is PostRecord => Boolean(post));
  perfDebug('getPostsByIds', { requestedCount: postIds.length, uniqueCount: ids.length, resultCount: posts.length, queryCount, durationMs: Math.round(perfStart() - start) });
  return posts;
}

export type SearchPostPage = {
  posts: PostRecord[];
  cursor: string | null;
  hasMore: boolean;
  scanLimitReached: boolean;
  mode: string;
};

export async function searchPosts(queryText: string, limitCount = 20, cursor: string | null = null, authorId?: string): Promise<SearchPostPage> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('ログインが必要です');
  const response = await fetch('/api/search/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await currentUser.getIdToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: queryText, limit: limitCount, cursor, ...(authorId ? { authorId } : {}) }),
    cache: 'no-store',
  });
  const payload = await response.json().catch((): Record<string, unknown> => ({}));
  if (!response.ok) {
    const error = new Error(typeof payload.error === 'string' ? payload.error : `Search failed (${response.status})`) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
    throw error;
  }
  const items: unknown[] = Array.isArray(payload.items) ? payload.items : [];
  return {
    posts: items.filter(isRecord).map(item => toPostRecord(item, stringValue(item.id))),
    cursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
    hasMore: payload.hasMore === true,
    scanLimitReached: payload.scanLimitReached === true,
    mode: stringValue(payload.mode, 'text'),
  };
}

/**
 * 最近の人気投稿を取得（ハッシュタグ集計とは独立した既存フィード）
 */
export async function getTrendingPosts(limitCount = 10): Promise<PostRecord[]> {
  const postsRef = collection(db, 'posts');
  const q = query(postsRef, orderBy('createdAt', 'desc'), limit(50));
  const snap = await getDocs(q);
  const posts: PostRecord[] = [];
  snap.forEach(doc => {
    const data = doc.data();
    if (canViewPost(data, '', [])) posts.push(toPostRecord(data, doc.id));
  });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = posts.filter(p => {
    const t = toMillis(p.createdAt);
    return t > cutoff;
  });
  recent.sort((a, b) => (b.likesCount || 0) - (a.likesCount || 0));
  return recent.slice(0, limitCount);
}

/**
 * 投票する
 */
export async function votePoll(postId: string, optionIndex: number, userId: string): Promise<PostPoll> {
  const postRef = doc(db, 'posts', postId);
  return runTransaction(db, async (transaction) => {
    const postSnap = await transaction.get(postRef);
    if (!postSnap.exists()) throw new Error('Post not found');
    const post = postSnap.data();
    if (!post.poll) throw new Error('No poll');
    const expiresAtMs = toMillis(post.poll.expiresAt);
    if (expiresAtMs && expiresAtMs <= Date.now()) throw new Error('Poll expired');

    const pollOptions = (Array.isArray(post.poll.options) ? post.poll.options : Object.values(post.poll.options || {}))
      .map(option => ({
        text: option?.text || '',
        votes: Array.isArray(option?.votes) ? [...option.votes] : [],
      }))
      .filter(option => option.text);
    if (!pollOptions[optionIndex]) throw new Error('Invalid option');
    if (pollOptions.some(option => option.votes.includes(userId))) throw new Error('Already voted');

    pollOptions[optionIndex].votes = [...pollOptions[optionIndex].votes, userId];
    const totalVotes = pollOptions.reduce((sum, option) => sum + option.votes.length, 0);
    const updatedPoll = {
      ...post.poll,
      options: pollOptions,
      totalVotes,
    };
    transaction.update(postRef, { poll: updatedPoll });
    return updatedPoll;
  });
}

const FEED_RECOMMENDATION_WEIGHTS = {
  recency: 30,
  friend: 28,
  repliedToUser: 20,
  repliedByUser: 24,
  likedUser: 14,
  hashtagAffinity: 10,
  like: 2,
  comment: 4,
  repost: 5,
  media: 8,
  ownPost: 6,
  seenPenalty: -45,
};


function recencyScore(createdAt: unknown): number {
  const ageHours = Math.max(0, (Date.now() - toMillis(createdAt)) / (60 * 60 * 1000));
  return Math.max(0, FEED_RECOMMENDATION_WEIGHTS.recency - ageHours * 0.9);
}

const _feedSignalsCache = new Map<string, { time: number; value: FeedSignals }>();
const FEED_SIGNALS_TTL = 5 * 60 * 1000;

function emptyFeedSignals(): FeedSignals {
  return {
    friends: new Set<string>(),
    repliedToUsers: new Set<string>(),
    repliedByUsers: new Set<string>(),
    likedUsers: new Set<string>(),
    hashtagAffinity: new Map<string, number>(),
  };
}

async function getExistingPostDocs(postIds: string[]): Promise<Array<DocumentSnapshot | QueryDocumentSnapshot>> {
  const posts = await getPostsByIds(postIds.slice(0, 24));
  return posts.map(post => ({ exists: () => true, data: () => post, id: post.id } as unknown as DocumentSnapshot));
}

async function getFeedSignals(userId: string, friendIdsPromise?: Promise<string[]>): Promise<FeedSignals> {
  const cached = _feedSignalsCache.get(userId);
  if (cached && Date.now() - cached.time < FEED_SIGNALS_TTL) return cached.value;
  if (!userId) return emptyFeedSignals();

  // Share the visibility-critical friend lookup with getFeedPosts. Likes and
  // replies are recommendation hints and are always isolated from the main
  // post query below.
  const friendsPromise = friendIdsPromise || getUserFriendIds(userId);
  const likesPromise = (async () => {
    const likedUsers = new Set<string>();
    const hashtagAffinity = new Map<string, number>();
    try {
      const likedSnap = await getDocs(query(collection(db, 'likes'), where('userId', '==', userId), limit(40)));
      const postSnaps = await getExistingPostDocs(likedSnap.docs.map(likeDoc => stringValue(likeDoc.data().postId)).filter(Boolean));
      for (const postSnap of postSnaps) {
        const post = postSnap.data();
        if (post.userId && post.userId !== userId) likedUsers.add(post.userId);
        stringArray(post.hashtags).forEach(tag => hashtagAffinity.set(tag, (hashtagAffinity.get(tag) || 0) + 1));
      }
    } catch { /* Signals are optional. */ }
    return { likedUsers, hashtagAffinity };
  })();
  const repliesPromise = (async () => {
    const repliedToUsers = new Set<string>();
    const repliedByUsers = new Set<string>();
    try {
      const [commentSnap, notifSnap] = await Promise.all([
        getDocs(query(collection(db, 'comments'), where('userId', '==', userId), limit(40))),
        getDocs(query(collection(db, 'notifications'), where('userId', '==', userId), limit(40))),
      ]);
      const postSnaps = await getExistingPostDocs(commentSnap.docs.map(commentDoc => stringValue(commentDoc.data().postId)).filter(Boolean));
      for (const postSnap of postSnaps) {
        const authorId = stringValue(postSnap.data().userId);
        if (authorId && authorId !== userId) repliedToUsers.add(authorId);
      }
      notifSnap.forEach(n => {
        const data = n.data();
        const fromUserId = stringValue(data.fromUserId);
        if (['comment', 'reply', 'thread_reply', 'mention'].includes(stringValue(data.type)) && fromUserId && fromUserId !== userId) repliedByUsers.add(fromUserId);
      });
    } catch { /* Signals are optional. */ }
    return { repliedToUsers, repliedByUsers };
  })();
  const [friends, likes, replies] = await Promise.all([friendsPromise, likesPromise, repliesPromise]);
  const value = {
    friends: new Set(friends),
    repliedToUsers: replies.repliedToUsers,
    repliedByUsers: replies.repliedByUsers,
    likedUsers: likes.likedUsers,
    hashtagAffinity: likes.hashtagAffinity,
  };
  _feedSignalsCache.set(userId, { value, time: Date.now() });
  return value;
}

function scoreRecommendedPost(post: PostRecord, signals: FeedSignals, userId: string, seenPostIds: string[] = []): number {
  const seen = new Set(seenPostIds);
  let score = recencyScore(post.createdAt);
  const authorId = stringValue(post.userId);
  if (authorId === userId) score += FEED_RECOMMENDATION_WEIGHTS.ownPost;
  if (signals.friends.has(authorId)) score += FEED_RECOMMENDATION_WEIGHTS.friend;
  if (signals.repliedToUsers.has(authorId)) score += FEED_RECOMMENDATION_WEIGHTS.repliedToUser;
  if (signals.repliedByUsers.has(authorId)) score += FEED_RECOMMENDATION_WEIGHTS.repliedByUser;
  if (signals.likedUsers.has(authorId)) score += FEED_RECOMMENDATION_WEIGHTS.likedUser;
  for (const tag of stringArray(post.hashtags)) {
    score += Math.min(4, signals.hashtagAffinity.get(tag) || 0) * FEED_RECOMMENDATION_WEIGHTS.hashtagAffinity;
  }
  score += Math.min(20, post.likesCount || 0) * FEED_RECOMMENDATION_WEIGHTS.like;
  score += Math.min(15, post.commentsCount || 0) * FEED_RECOMMENDATION_WEIGHTS.comment;
  score += Math.min(10, post.repostsCount || 0) * FEED_RECOMMENDATION_WEIGHTS.repost;
  if (stringArray(post.imageURLs).length > 0 || post.videoURL) score += FEED_RECOMMENDATION_WEIGHTS.media;
  if (seen.has(post.id)) score += FEED_RECOMMENDATION_WEIGHTS.seenPenalty;
  return score;
}

/**
 * フィード投稿を取得
 * mode=friends: 関係性の強いユーザー優先
 * mode=recommended: 軽量スコア式推薦
 */
export async function getFeedPosts(userId: string, cursor: number | DocumentSnapshot | null = 0, pageSize = 10, mode: FeedMode = 'friends', seenPostIds: string[] = []): Promise<FeedResult & { cursor: DocumentSnapshot | null }> {
  const start = perfStart();
  const trace = getActiveStartupTraceSession();
  const finishTrace = trace?.begin('feed-request', { endpointCategory: 'firestore-feed', retryCount: 0 });
  const friendIdsPromise = getUserFriendIds(userId).catch((): string[] => []);
  const signalsPromise = singleFlight(`firestore-feed-signals:${userId || 'guest'}`, () => getFeedSignals(userId, friendIdsPromise))
    .catch((): FeedSignals => emptyFeedSignals());
  let signals = emptyFeedSignals();
  let friendIds: string[] = [];
  if (mode === 'friends') {
    // Private/friends visibility must be decided with an authenticated friend
    // list before posts are accepted. Recommendation hints stay deferred.
    friendIds = await friendIdsPromise;
    signals.friends = new Set(friendIds);
  } else {
    // Likes, comments, and notification fan-out are optional recommendation
    // hints. A bounded budget keeps them from blocking the first post query.
    signals = await withTimeout(signalsPromise, 350).catch((error: unknown): FeedSignals => {
      const info = classifyStartupError(error);
      trace?.event('feed-signals', 'skipped', { endpointCategory: 'firestore-signals', errorType: info.kind });
      return emptyFeedSignals();
    });
    friendIds = [...signals.friends];
  }
  const userIds = new Set([...friendIds, ...signals.repliedToUsers, ...signals.repliedByUsers, userId]);

  const postsRef = collection(db, 'posts');
  let allPosts: PostRecord[] = [];
  let lastVisible: DocumentSnapshot | null = null;
  const safePageSize = Math.min(Math.max(Number(pageSize) || 10, 1), 20);
  try {
    const constraints: QueryConstraint[] = [orderBy('createdAt', 'desc')];
    if (cursor && typeof cursor === 'object') constraints.push(startAfter(cursor));
    constraints.push(limit(safePageSize));
    const q = query(postsRef, ...constraints);
    const snap = await getDocs(q);
    lastVisible = snap.docs[snap.docs.length - 1] || null;
    snap.forEach(doc => {
      const data = doc.data();
      if (canViewPost(data, userId, friendIds)) allPosts.push(toPostRecord(data, doc.id));
    });
  } catch (e) {
    const info = classifyStartupError(e);
    finishTrace?.('error', { httpStatus: info.httpStatus, errorType: info.kind });
    console.error('getFeedPosts failed', {
      errorType: info.kind,
      httpStatus: info.httpStatus,
      retryable: info.kind === 'network' || info.kind === 'timeout' || info.kind === 'rate_limit' || info.kind === 'server',
      mode,
    });
    throw e;
  }

  let filtered = mode === 'recommended'
    ? [...allPosts]
    : allPosts.filter(p => userIds.has(p.userId));
  if (filtered.length === 0 && allPosts.length > 0) filtered = [...allPosts];

  if (mode === 'recommended') {
    filtered = filtered
      .map(post => ({ ...post, recommendationScore: scoreRecommendedPost(post, signals, userId, seenPostIds) }))
      .sort((a, b) => {
        if ((b.recommendationScore || 0) !== (a.recommendationScore || 0)) {
          return (b.recommendationScore || 0) - (a.recommendationScore || 0);
        }
        return toMillis(b.createdAt) - toMillis(a.createdAt);
      });
  } else {
    filtered.sort((a, b) => {
      const relA = signals.friends.has(a.userId) ? 2 : 0;
      const relB = signals.friends.has(b.userId) ? 2 : 0;
      if (relA !== relB) return relB - relA;
      return toMillis(b.createdAt) - toMillis(a.createdAt);
    });
  }

  perfDebug('getFeedPosts', {
    requestedLimit: safePageSize,
    fetchedDocs: allPosts.length,
    resultCount: filtered.length,
    mode,
    hasCursor: Boolean(cursor && typeof cursor === 'object'),
    durationMs: Math.round(perfStart() - start),
  });
  finishTrace?.('success', { durationMs: Math.round(perfStart() - start) });
  return {
    posts: filtered,
    loadedCount: (typeof cursor === 'number' ? cursor : 0) + filtered.length,
    cursor: lastVisible,
  };
}

/**
 * 特定ユーザーの投稿を取得
 * インデックス不要 - 全件取得＋クライアント側フィルタ
 */
export async function getUserPosts(uid: string, lastDoc: string | null = null, pageSize: number | 'all' = 10): Promise<{ posts: PostRecord[]; lastDoc: null }> {
  const postsRef = collection(db, 'posts');
  const posts: PostRecord[] = [];
  try {
    const q = pageSize === 'all'
      ? query(postsRef, where('userId', '==', uid))
      : query(postsRef, where('userId', '==', uid), limit(Math.min(Math.max(Number(pageSize) || 10, 10), 250)));
    const snap = await getDocs(q);
    const viewerId = typeof lastDoc === 'string' ? lastDoc : uid;
    const friendIds = viewerId ? await getUserFriendIds(viewerId).catch((): string[] => []) : [];
    snap.forEach(doc => {
      const data = doc.data();
      if (canViewPost(data, viewerId, friendIds)) posts.push(toPostRecord(data, doc.id));
    });
  } catch (e) {
    console.error('getUserPosts error:', e);
    return { posts: [], lastDoc: null };
  }

  posts.sort((a, b) => {
    const tA = toMillis(a.createdAt);
    const tB = toMillis(b.createdAt);
    return tB - tA;
  });

  return { posts: pageSize === 'all' ? posts : posts.slice(0, pageSize), lastDoc: null };
}

export async function getUserPostCount(uid: string): Promise<number> {
  try {
    const postsRef = collection(db, 'posts');
    const q = query(postsRef, where('userId', '==', uid));
    const snap = await getCountFromServer(q);
    return snap.data().count;
  } catch (e) {
    console.error('getUserPostCount error:', e);
    return 0;
  }
}

/**
 * 投稿を削除
 */
export async function deletePost(postId: string): Promise<void> {
  const snap = await getDoc(doc(db, 'posts', postId));
  await deleteDoc(doc(db, 'posts', postId));
  if (snap.exists()) {
    await deleteAttachmentFiles(Array.isArray(snap.data().attachments) ? snap.data().attachments as Attachment[] : []).catch((): void => {});
  }
}

/**
 * 単一投稿を取得
 */
export async function getPostById(postId: string): Promise<PostRecord | null> {
  const snap = await getDoc(doc(db, 'posts', postId));
  if (!snap.exists()) return null;
  if (snap.data().deletedAt || snap.data().moderationStatus === 'removed') return null;
  return toPostRecord(snap.data(), snap.id);
}

const postMediaURLRequests = new Map<string, Promise<string>>();
type PostMediaLookup = { status: number; media: unknown };
const postMediaLookups = new Map<string, { promise: Promise<PostMediaLookup>; expiresAt: number }>();

function currentOriginMediaRoute(candidate: string): string {
  if (candidate.startsWith('/media/') && !candidate.startsWith('//') && !candidate.startsWith('/media/legacy/')) return candidate;
  try {
    const url = new URL(candidate, window.location.origin);
    return url.origin === window.location.origin && url.pathname.startsWith('/media/') && !url.pathname.startsWith('/media/legacy/')
      ? `${url.pathname}${url.search}`
      : '';
  } catch {
    return '';
  }
}

function isProtectedPostMediaRoute(route: string): boolean {
  return /^\/media\/(?:migration|posts)\//.test(route);
}

function lookupPostMedia(postId: string): Promise<PostMediaLookup> {
  const user = auth.currentUser;
  const key = `${user?.uid || 'anonymous'}\u0000${postId}`;
  const cached = postMediaLookups.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (cached) postMediaLookups.delete(key);

  const headers = new Headers();
  const promise = (async (): Promise<PostMediaLookup> => {
    if (user) {
      try { headers.set('Authorization', `Bearer ${await user.getIdToken()}`); } catch { /* Public posts can be read without an optional token. */ }
    }
    const response = await fetch(`/api/posts/${encodeURIComponent(postId)}`, { headers, cache: 'no-store' });
    if (response.status === 404) return { status: 404, media: null };
    if (!response.ok) throw new Error(`post_media_lookup_failed_${response.status}`);
    const payload = await response.json().catch((): null => null) as { post?: { media?: unknown } } | null;
    return { status: response.status, media: payload?.post?.media ?? null };
  })();
  const entry = { promise, expiresAt: Date.now() + 10_000 };
  postMediaLookups.set(key, entry);
  void promise.then((result) => {
    if (postMediaLookups.get(key) !== entry) return;
    // Worker media tickets expire after ten minutes. Re-fetch before the
    // ticket window closes; cache missing posts briefly to avoid one request
    // per failed item in an image carousel.
    const hasWorkerMediaRoute = Array.isArray(result.media) && result.media.some((value) => {
      if (!value || typeof value !== 'object') return false;
      const item = value as Record<string, unknown>;
      return [item.url, item.thumbnailUrl, item.previewUrl].some((url) => typeof url === 'string' && url.startsWith('/media/'));
    });
    entry.expiresAt = Date.now() + (hasWorkerMediaRoute ? 8 * 60_000 : 10_000);
  }, () => {
    if (postMediaLookups.get(key) === entry) postMediaLookups.delete(key);
  });
  return promise;
}

async function resolvePostMediaURL(postId: string, sourceURL: string, kind: PostMediaKind, index: number): Promise<string> {
  const directRoute = currentOriginMediaRoute(sourceURL);
  if (directRoute && (!isProtectedPostMediaRoute(directRoute) || new URL(directRoute, window.location.origin).searchParams.has('ticket'))) return directRoute;

  const storagePath = storagePathFromMediaURL(sourceURL);
  const obsoleteMediaRoute = sourceURL.startsWith('/media/legacy/');
  if (!postId || (!storagePath && !obsoleteMediaRoute && !isProtectedPostMediaRoute(directRoute))) return sourceURL;

  const { status, media } = await lookupPostMedia(postId);
  if (status === 404) return sourceURL;
  const canonicalURL = canonicalPostMediaURLFromPostMedia(media, sourceURL, kind, index);
  if (canonicalURL) return canonicalURL;
  if (kind === 'video' && postMediaHasStoragePath(media, sourceURL)) throw new Error('post_media_object_unavailable');
  // New Firestore-first posts may not have been mirrored into D1 yet. Their
  // freshly issued Firebase download URL remains the active source until the
  // Worker read-through can provide its post-scoped route.
  return sourceURL;
}

export function prefetchPostMediaURL(postId: string, sourceURL: string, kind: PostMediaKind, index = 0): Promise<string> {
  if (!sourceURL) return Promise.reject(new Error('post_media_url_missing'));
  const directRoute = currentOriginMediaRoute(sourceURL);
  if (directRoute && (!isProtectedPostMediaRoute(directRoute) || new URL(directRoute, window.location.origin).searchParams.has('ticket'))) return Promise.resolve(directRoute);
  const key = `${postId}\u0000${kind}\u0000${index}\u0000${sourceURL}`;
  const existing = postMediaURLRequests.get(key);
  if (existing) return existing;
  const request = resolvePostMediaURL(postId, sourceURL, kind, index);
  postMediaURLRequests.set(key, request);
  // De-duplicate concurrent lookups only. Migrated media URLs carry short-
  // lived Worker tickets, so retaining a fulfilled response would pin an
  // expired ticket into the page's lifetime cache.
  void request.then(() => {
    if (postMediaURLRequests.get(key) === request) postMediaURLRequests.delete(key);
  }, () => {
    if (postMediaURLRequests.get(key) === request) postMediaURLRequests.delete(key);
  });
  return request;
}

export function prefetchPostVideoURL(postId: string, sourceURL: string): Promise<string> {
  return prefetchPostMediaURL(postId, sourceURL, 'video', 0);
}

export async function recordPostView(postId: string, viewerId = ''): Promise<void> {
  if (!postId) return;
  const viewId = `${postId}_${viewerId || 'anon'}_${new Date().toISOString().slice(0, 10)}`;
  const viewRef = doc(db, 'postViews', viewId);
  const snap = await getDoc(viewRef).catch((): null => null);
  if (snap?.exists?.()) return;
  await setDoc(viewRef, { postId, viewerId, viewedAt: serverTimestamp() }).catch((): void => {});
  await updateDoc(doc(db, 'posts', postId), { viewCount: increment(1) }).catch((): void => {});
}

export async function recordPostProfileClick(postId: string, viewerId = ''): Promise<void> {
  if (!postId) return;
  await addDoc(collection(db, 'postProfileClicks'), { postId, viewerId, clickedAt: serverTimestamp() }).catch((): void => {});
  await updateDoc(doc(db, 'posts', postId), { profileClickCount: increment(1) }).catch((): void => {});
}

// ============================================================
// いいね
// ============================================================

/**
 * いいねをトグル
 */
export async function toggleLike(postId: string, userId: string, desiredLiked?: boolean): Promise<{ liked: boolean; eventId?: string; likesCount: number }> {
  const likeId = `${postId}_${userId}`;
  const likeRef = doc(db, 'likes', likeId);
  const postRef = doc(db, 'posts', postId);
  const result = await runTransaction(db, async transaction => {
    const likeSnap = await transaction.get(likeRef);
    const postSnap = await transaction.get(postRef);
    if (!postSnap.exists()) throw new Error('Post not found');

    const currentLiked = likeSnap.exists();
    const nextLiked = typeof desiredLiked === 'boolean' ? desiredLiked : !currentLiked;
    const currentLikesCount = Math.max(0, Number(postSnap.data().likesCount) || 0);
    const nextLikesCount = Math.max(0, currentLikesCount + (nextLiked === currentLiked ? 0 : (nextLiked ? 1 : -1)));

    // Desired-state writes are idempotent. This prevents a retry or a second
    // click from toggling the reaction back while the first request is in
    // flight, and keeps the denormalized counter in the same transaction.
    if (nextLiked === currentLiked) return { liked: currentLiked, likesCount: currentLikesCount };

    if (!nextLiked) {
      transaction.delete(likeRef);
      transaction.update(postRef, { likesCount: nextLikesCount });
      return { liked: false, likesCount: nextLikesCount };
    }
    const eventId = crypto.randomUUID();
    transaction.set(likeRef, {
      postId,
      userId,
      eventId,
      createdAt: serverTimestamp(),
    });
    transaction.update(postRef, { likesCount: nextLikesCount });
    return { liked: true, eventId, likesCount: nextLikesCount };
  });
  let likesCount = result.likesCount;
  try {
    // Reconcile the denormalized counter with the likes collection after the
    // mutation. This also repairs counters written by older toggle logic.
    const countSnapshot = await getCountFromServer(query(collection(db, 'likes'), where('postId', '==', postId)));
    likesCount = countSnapshot.data().count;
    await updateDoc(postRef, { likesCount });
  } catch (_) {
    // The transaction result is still a valid optimistic fallback when the
    // aggregate read is temporarily unavailable.
  }
  _viewerStateCache.delete(`like:${likeId}`);
  return { ...result, likesCount };
}

/**
 * ユーザーが特定の投稿をいいね済みかチェック
 */
export async function hasLiked(postId: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const likeRef = doc(db, 'likes', `${postId}_${userId}`);
  const snap = await getDoc(likeRef);
  return snap.exists();
}

/**
 * いいねユーザー一覧を取得（簡易）
 */
export async function getLikes(postId: string): Promise<LikeRecord[]> {
  const likesRef = collection(db, 'likes');
  const q = query(likesRef, where('postId', '==', postId));
  const snap = await getDocs(q);
  const likes: LikeRecord[] = [];
  snap.forEach(docSnap => likes.push({ id: docSnap.id, ...docSnap.data() }));
  return likes;
}

export async function getUserLikedPosts(userId: string, viewerId = '', limitCount = 80): Promise<PostRecord[]> {
  if (!userId) return [];
  const q = query(collection(db, 'likes'), where('userId', '==', userId), limit(limitCount));
  const snap = await getDocs(q);
  const postIds: string[] = [];
  snap.forEach(likeDoc => {
    const data = likeDoc.data();
    if (stringValue(data.postId) && !data.commentId && data.type !== 'comment') postIds.push(stringValue(data.postId));
  });
  if (postIds.length === 0) return [];
  const postSnaps = await getExistingPostDocs(postIds);
  const friendIds = viewerId ? await getUserFriendIds(viewerId).catch((): string[] => []) : [];
  const posts: PostRecord[] = [];
  for (const postSnap of postSnaps) {
    const data = postSnap.data();
    if (canViewPost(data, viewerId || userId, friendIds)) {
      posts.push(toPostRecord(data, postSnap.id));
    }
  }
  posts.sort((a, b) => {
    const aLike = toMillis(snap.docs.find(l => l.data().postId === a.id)?.data()?.createdAt);
    const bLike = toMillis(snap.docs.find(l => l.data().postId === b.id)?.data()?.createdAt);
    return bLike - aLike;
  });
  return posts;
}

// ============================================================
// ブックマーク（非公開）
// ============================================================
export async function toggleBookmark(postId: string, userId: string): Promise<{ bookmarked: boolean }> {
  if (!postId || !userId) throw new Error('ログインが必要です');
  const bookmarkRef = doc(db, 'bookmarks', `${userId}_${postId}`);
  const snap = await getDoc(bookmarkRef);
  if (snap.exists()) {
    await deleteDoc(bookmarkRef);
    return { bookmarked: false };
  }
  await setDoc(bookmarkRef, { postId, userId, createdAt: serverTimestamp() });
  return { bookmarked: true };
}

export async function hasBookmarked(postId: string, userId: string): Promise<boolean> {
  if (!postId || !userId) return false;
  const snap = await getDoc(doc(db, 'bookmarks', `${userId}_${postId}`));
  return snap.exists();
}

export async function getUserBookmarks(userId: string, limitCount = 50): Promise<BookmarkRecord[]> {
  if (!userId) return [];
  // Keep the Firestore query simple so bookmark lists do not fail on missing composite indexes.
  // The collection is private per user; ordering is safe to do client-side for this small list.
  const q = query(collection(db, 'bookmarks'), where('userId', '==', userId), limit(Math.max(limitCount, 100)));
  const snap = await getDocs(q);
  const bookmarks: BookmarkRecord[] = [];
  snap.forEach(docSnap => bookmarks.push({ id: docSnap.id, ...docSnap.data() }));
  bookmarks.sort((a, b) => {
    const aTime = toMillis(a.createdAt);
    const bTime = toMillis(b.createdAt);
    return bTime - aTime;
  });
  return bookmarks.slice(0, limitCount);
}

// ============================================================
// コメント
// ============================================================

/**
 * コメントを追加
 */
export async function addComment(data: CreateCommentInput): Promise<CommentRecord> {
  const commentsRef = collection(db, 'comments');
  const comment = {
    postId: data.postId,
    userId: data.userId,
    text: data.text || '',
    mentions: parseMentions(data.text || ''),
    attachments: sanitizeAttachments(data.attachments),
    imageURL: data.imageURL || '',
    videoURL: data.videoURL || '',
    audioURL: data.audioURL || '',
    fileURL: data.fileURL || '',
    fileName: data.fileName || '',
    parentId: data.parentId || null,
    likesCount: 0,
    createdAt: serverTimestamp(),
  };
  const docRef = await addDoc(commentsRef, comment);
  try {
    await updateDoc(doc(db, 'posts', data.postId), {
      commentsCount: increment(1),
    });
  } catch (e) {
    console.error('Failed to increment commentsCount:', e);
  }
  return { id: docRef.id, ...comment } as CommentRecord;
}

/**
 * Update only the body fields of a comment. The Firestore Rule repeats the
 * owner check so a forged client-side userId can never edit another user's
 * comment.
 */
export async function updateComment(commentId: string, userId: string, data: UpdateCommentInput): Promise<CommentRecord> {
  if (!commentId || !userId) throw new Error('ログインが必要です');
  const commentRef = doc(db, 'comments', commentId);
  const snap = await getDoc(commentRef);
  if (!snap.exists()) throw new Error('コメントが見つかりません');
  const current = snap.data();
  if (stringValue(current.userId) !== userId) throw new Error('編集権限がありません');

  const text = String(data.text || '').trim();
  if (Array.from(text).length > 500) throw new Error('コメントは500文字以内で入力してください');
  const hasAttachment = Array.isArray(current.attachments) && current.attachments.length > 0
    || Boolean(current.imageURL || current.videoURL || current.audioURL || current.fileURL);
  if (!text && !hasAttachment) throw new Error('コメントを入力してください');

  const patch = {
    text,
    mentions: parseMentions(text),
    editedAt: serverTimestamp(),
  };
  await updateDoc(commentRef, patch);
  return toComment({ ...current, ...patch }, commentId) as CommentRecord;
}

export async function deleteComment(commentId: string, userId: string): Promise<void> {
  const commentRef = doc(db, 'comments', commentId);
  let attachmentsToCleanup: Attachment[] = [];
  await runTransaction(db, async (transaction) => {
    const commentSnap = await transaction.get(commentRef);
    if (!commentSnap.exists()) throw new Error('Comment not found');
    const data = commentSnap.data();
    if (stringValue(data.userId) !== userId) throw new Error('Permission denied');
    const postId = stringValue(data.postId);
    attachmentsToCleanup = Array.isArray(data.attachments) ? data.attachments as Attachment[] : [];
    const postRef = postId ? doc(db, 'posts', postId) : null;
    const postSnap = postRef ? await transaction.get(postRef) : null;

    transaction.delete(commentRef);
    if (postRef && postSnap?.exists()) {
      const currentCount = numberValue(postSnap.data().commentsCount);
      transaction.update(postRef, { commentsCount: Math.max(0, currentCount - 1) });
    }
  });
  await deleteAttachmentFiles(attachmentsToCleanup).catch((): void => {});
}

/**
 * 投稿のコメントを取得
 * 複合インデックス不要
 */
export async function getComments(postId: string): Promise<CommentRecord[]> {
  const commentsRef = collection(db, 'comments');
  const q = query(commentsRef, where('postId', '==', postId));
  const snap = await getDocs(q);
  const comments: CommentRecord[] = [];
  snap.forEach(docSnap => comments.push(toComment(docSnap.data(), docSnap.id) as CommentRecord));

  comments.sort((a, b) => {
    const tA = toMillis(a.createdAt);
    const tB = toMillis(b.createdAt);
    return tA - tB;
  });

  return comments;
}

export async function getCommentsPage(postId: string, pageSize = 30, cursor: DocumentSnapshot | null = null): Promise<{ comments: CommentRecord[]; cursor: DocumentSnapshot | null; hasMore: boolean }> {
  const start = perfStart();
  const safeLimit = Math.max(1, Math.min(Number(pageSize) || 30, 50));
  const constraints: QueryConstraint[] = [where('postId', '==', postId), orderBy('createdAt', 'asc')];
  if (cursor) constraints.push(startAfter(cursor));
  constraints.push(limit(safeLimit + 1));
  const snap = await getDocs(query(collection(db, 'comments'), ...constraints));
  const docs = snap.docs.slice(0, safeLimit);
  const comments = docs.map(docSnap => toComment(docSnap.data(), docSnap.id) as CommentRecord);
  perfDebug('getCommentsPage', { fetchedDocs: snap.docs.length, resultCount: comments.length, hasMore: snap.docs.length > safeLimit, queryCount: 1, durationMs: Math.round(perfStart() - start) });
  return { comments, cursor: docs[docs.length - 1] || null, hasMore: snap.docs.length > safeLimit };
}
export async function getUserComments(uid: string): Promise<Record<string, CommentRecord[]>> {
  const commentsRef = collection(db, 'comments');
  try {
    const q = query(commentsRef, where('userId', '==', uid));
    const snap = await getDocs(q);
    const byPost: Record<string, CommentRecord[]> = {};
    snap.forEach(doc => {
      const data = doc.data();
      const pid = stringValue(data.postId);
      if (!pid) return;
      if (!byPost[pid]) byPost[pid] = [];
      byPost[pid].push(toComment(data, doc.id) as CommentRecord);
    });
    return byPost;
  } catch (e) {
    console.error('getUserComments error:', e);
    return {};
  }
}

export async function toggleCommentLike(commentId: string, userId: string): Promise<{ liked: boolean }> {
  if (!commentId || !userId || auth.currentUser?.uid !== userId) throw new Error('ログインが必要です');
  const likeId = `comment_${commentId}_${userId}`;
  const likeRef = doc(db, 'likes', likeId);
  const commentRef = doc(db, 'comments', commentId);
  const liked = await runTransaction(db, async transaction => {
    const [likeSnap, commentSnap] = await Promise.all([transaction.get(likeRef), transaction.get(commentRef)]);
    if (!commentSnap.exists()) throw new Error('コメントが見つかりません');
    const currentCount = Math.max(0, Number(commentSnap.data().likesCount) || 0);
    if (likeSnap.exists()) {
      transaction.delete(likeRef);
      transaction.update(commentRef, { likesCount: Math.max(0, currentCount - 1) });
      return false;
    }
    transaction.set(likeRef, { type: 'comment', commentId, userId, eventId: likeId, createdAt: serverTimestamp() });
    transaction.update(commentRef, { likesCount: currentCount + 1 });
    return true;
  });
  _viewerStateCache.set(`comment-like:${likeId}`, liked);
  return { liked };
}
export async function hasCommentLiked(commentId: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const likeRef = doc(db, 'likes', `comment_${commentId}_${userId}`);
  const snap = await getDoc(likeRef);
  return snap.exists();
}

export async function getCommentLikeCount(commentId: string): Promise<number> {
  if (!commentId) return 0;
  const q = query(collection(db, 'likes'), where('commentId', '==', commentId));
  const snap = await getDocs(q);
  return snap.size;
}

// ============================================================
// フレンドシップ
// ============================================================

/**
 * 友達リクエストを送信
 */
export async function sendFriendRequest(userId: string, friendId: string): Promise<void> {
  const friendshipId = [userId, friendId].sort().join('_');
  const friendshipRef = doc(db, 'friendships', friendshipId);
  const eventId = await runTransaction(db, async transaction => {
    const existing = await transaction.get(friendshipRef);
    const existingData = existing.exists ? existing.data() : null;
    if (existingData?.status === 'accepted' || existingData?.status === 'pending') return '';
    const nextEventId = crypto.randomUUID();
    transaction.set(friendshipRef, {
      userId,
      friendId,
      status: 'pending',
      requester: userId,
      requestEventId: nextEventId,
      createdAt: serverTimestamp(),
    }, { merge: true });
    return nextEventId;
  });
  if (eventId) void createNotification({ userId: friendId, type: 'friend_request', fromUserId: userId, eventId });
}

/**
 * 友達リクエストを承認
 */
export async function acceptFriendRequest(userId: string, friendId: string): Promise<void> {
  try {
    const friendshipId = [userId, friendId].sort().join('_');
    const friendshipRef = doc(db, 'friendships', friendshipId);
    const result = await runTransaction(db, async transaction => {
      const existing = await transaction.get(friendshipRef);
      if (!existing.exists() || existing.data().status !== 'pending') {
        return { accepted: false, eventId: '' };
      }
      const eventId = crypto.randomUUID();
      transaction.update(friendshipRef, { status: 'accepted', acceptEventId: eventId });
      return { accepted: true, eventId };
    });
    if (result.accepted) {
      await updateDoc(doc(db, 'users', userId), { friendsCount: increment(1) });
      await updateDoc(doc(db, 'users', friendId), { friendsCount: increment(1) });
      void createNotification({ userId: friendId, type: 'friend_accept', fromUserId: userId, eventId: result.eventId });
    }
    _friendIdsCache.delete(userId);
    _friendIdsCache.delete(friendId);
  } catch (e) {
    console.error('acceptFriendRequest error:', e);
  }
}

/**
 * 友達を削除
 */
export async function removeFriend(userId: string, friendId: string): Promise<void> {
  try {
    const friendshipId = [userId, friendId].sort().join('_');
    const friendshipRef = doc(db, 'friendships', friendshipId);
    await deleteDoc(friendshipRef);
    await updateDoc(doc(db, 'users', userId), { friendsCount: increment(-1) });
    await updateDoc(doc(db, 'users', friendId), { friendsCount: increment(-1) });
    _friendIdsCache.delete(userId);
    _friendIdsCache.delete(friendId);
  } catch (e) {
    console.error('removeFriend error:', e);
  }
}

/**
 * ユーザーの友達ID一覧を取得
 */
export async function getUserFriendIds(userId: string): Promise<string[]> {
  // 未ログインの公開閲覧では friendship の取得権限がないため、
  // 公開投稿の可視性判定に不要なリクエストを発生させない。
  if (!userId || !auth.currentUser) return [];
  const cached = _friendIdsCache.get(userId);
  if (cached && Date.now() - cached.time < FRIEND_CACHE_TTL) return cached.ids;
  const existing = _friendIdsRequests.get(userId);
  if (existing) return existing;
  const request = (async (): Promise<string[]> => {
    try {
      const friendshipsRef = collection(db, 'friendships');
      const q1 = query(friendshipsRef, where('userId', '==', userId));
      const q2 = query(friendshipsRef, where('friendId', '==', userId));

      const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);
      const ids = new Set<string>();
      snap1.forEach(docSnap => {
        const data = docSnap.data();
        const friendId = stringValue(data.friendId);
        if (data.status === 'accepted' && friendId && friendId !== userId) ids.add(friendId);
      });
      snap2.forEach(docSnap => {
        const data = docSnap.data();
        const otherUserId = stringValue(data.userId);
        if (data.status === 'accepted' && otherUserId && otherUserId !== userId) ids.add(otherUserId);
      });
      const result = Array.from(ids);
      _friendIdsCache.set(userId, { ids: result, time: Date.now() });
      return result;
    } catch (e) {
      const errorCode = (e as { code?: unknown } | null)?.code;
      if (errorCode !== 'permission-denied') console.error('getUserFriendIds failed', { errorType: classifyStartupError(e).kind });
      return [];
    }
  })();
  _friendIdsRequests.set(userId, request);
  void request.finally(() => {
    if (_friendIdsRequests.get(userId) === request) _friendIdsRequests.delete(userId);
  }).catch(() => { /* The request resolves to [] for optional visibility hints. */ });
  return request;
}

export async function getUserFriendCount(userId: string): Promise<number> {
  return (await getUserFriendIds(userId)).length;
}

/**
 * ユーザーの友達リスト（プロフィール付き）
 */
export async function getUserFriends(userId: string): Promise<UserProfileRecord[]> {
  const friendIds = await getUserFriendIds(userId);
  if (friendIds.length === 0) return [];
  const profiles = await getDisplayUserProfilesByIds(friendIds);
  return friendIds.map(id => profiles[id]).filter((user): user is UserProfileRecord => Boolean(user)).map(user => ({ ...user, uid: user.uid || user.id }));
}

/**
 * 友達リクエスト一覧
 */
export async function getPendingRequests(userId: string): Promise<Array<FriendshipRecord & { requesterProfile: UserProfileRecord | null }>> {
  const friendshipsRef = collection(db, 'friendships');
  // whereのみ（複合インデックス不要）
  const q = query(friendshipsRef, where('friendId', '==', userId));
  const snap = await getDocs(q);
  const requests: Array<FriendshipRecord & { requesterProfile: UserProfileRecord | null }> = [];
  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (data.status !== 'pending') continue;
    const requester = stringValue(data.requester);
    const profile = requester ? await getDisplayUserProfile(requester) : null;
    requests.push({ id: docSnap.id, ...data, requesterProfile: profile } as FriendshipRecord & { requesterProfile: UserProfileRecord | null });
  }
  return requests;
}

/**
 * 2ユーザー間のフレンドシップ状態を取得
 */
export async function getFriendshipStatus(userId: string, otherId: string): Promise<'self' | 'none' | 'friends' | 'pending_sent' | 'pending_received'> {
  if (userId === otherId) return 'self';
  const friendshipId = [userId, otherId].sort().join('_');
  const ref = doc(db, 'friendships', friendshipId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return 'none';
  const data = snap.data();
  if (data.status === 'accepted') return 'friends';
  if (data.status === 'pending') {
    return data.requester === userId ? 'pending_sent' : 'pending_received';
  }
  return 'none';
}

// ============================================================
// 通知
// ============================================================

/**
 * 通知を作成
 */
export async function createNotification(data: CreateNotificationInput): Promise<void> {
  if (!shouldCreateNotification(data)) return;
  if (!isActiveNotificationType(data.type)) return;
  let responseStatus: number | null = null;
  try {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      console.warn('[Connect notification]', {
        notificationType: data.type,
        recipientId: data.userId,
        subscriptionStatus: 'not_checked',
        pushResponseStatus: null,
        failureReason: 'authentication_required',
      });
      return;
    }
    const response = await fetch('/api/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await currentUser.getIdToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...data,
        // The API derives the actor from the verified Firebase ID token.
        fromUserId: undefined,
      }),
      cache: 'no-store',
      keepalive: true,
    });
    responseStatus = response.status;
    if (!response.ok) {
      console.warn('[Connect notification]', {
        notificationType: data.type,
        recipientId: data.userId,
        subscriptionStatus: 'not_checked',
        pushResponseStatus: null,
        failureReason: `notification_api_http_${response.status}`,
      });
    }
  } catch {
    console.warn('[Connect notification]', {
      notificationType: data.type,
      recipientId: data.userId,
      subscriptionStatus: 'not_checked',
      pushResponseStatus: null,
      failureReason: responseStatus === null ? 'notification_api_request_failed' : `notification_api_http_${responseStatus}`,
    });
    // Notification creation is best-effort and must never fail the originating SNS action.
  }
}

export async function getNotificationsPage(userId: string, pageSize = 30, cursor: DocumentSnapshot | null = null): Promise<{ notifications: NotificationRecord[]; cursor: DocumentSnapshot | null; hasMore: boolean }> {
  const start = perfStart();
  const safeLimit = Math.max(1, Math.min(pageSize, 50));
  const constraints: QueryConstraint[] = [
    where('userId', '==', userId),
    where('type', 'in', [...ACTIVE_NOTIFICATION_TYPES]),
    orderBy('createdAt', 'desc'),
  ];
  if (cursor) constraints.push(startAfter(cursor));
  constraints.push(limit(safeLimit + 1));
  const snap = await getDocs(query(collection(db, 'notifications'), ...constraints));
  const docs = snap.docs.slice(0, safeLimit);
  const notifs: NotificationRecord[] = docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  // Notification rows intentionally keep a lightweight sender snapshot for
  // history. It is not authoritative for display: avatar URLs in old
  // snapshots can point at expired Firebase tokens. Resolve each actor from
  // the current profile projection on every page load, regardless of whether
  // a snapshot exists.
  const fromUserIds = notifs.map((notif) => String(notif.fromUserId || '')).filter(Boolean);
  const profiles = await getDisplayUserProfilesByIds(fromUserIds);
  notifs.forEach(notif => {
    const uid = String(notif.fromUserId || '');
    notif.fromUser = (uid ? profiles[uid] : null) || notificationSenderSummary(notif);
  });
  perfDebug('getNotificationsPage', { fetchedDocs: snap.docs.length, resultCount: notifs.length, actorProfileCount: new Set(fromUserIds).size, durationMs: Math.round(perfStart() - start) });
  return { notifications: notifs, cursor: docs[docs.length - 1] || null, hasMore: snap.docs.length > safeLimit };
}

/**
 * ユーザーの通知一覧を取得
 */
export async function getNotifications(userId: string, limitCount = 20): Promise<NotificationRecord[]> {
  return (await getNotificationsPage(userId, limitCount)).notifications;
}

/**
 * 未読通知数
 */
export async function getUnreadNotificationCount(userId: string): Promise<number> {
  const notifRef = collection(db, 'notifications');
  const q = query(
    notifRef,
    where('userId', '==', userId),
    where('read', '==', false),
    where('type', 'in', [...ACTIVE_NOTIFICATION_TYPES]),
  );
  const snap = await getDocs(q);
  return snap.size;
}

/**
 * 通知を既読にする
 */
export async function markNotificationRead(notificationId: string): Promise<void> {
  const notificationRef = doc(db, 'notifications', notificationId);
  const snapshot = await getDoc(notificationRef);
  if (!snapshot.exists() || !isActiveNotificationType(snapshot.data()?.type)) return;
  await updateDoc(notificationRef, { read: true });
}

/**
 * 全通知を既読にする
 */
export async function markAllNotificationsRead(userId: string): Promise<void> {
  const notifRef = collection(db, 'notifications');
  const q = query(
    notifRef,
    where('userId', '==', userId),
    where('read', '==', false),
    where('type', 'in', [...ACTIVE_NOTIFICATION_TYPES]),
  );
  const snap = await getDocs(q);
  const batch = writeBatch(db);
  snap.forEach(docSnap => {
    batch.update(docSnap.ref, { read: true });
  });
  await batch.commit();
}

// ============================================================
// 広告
// ============================================================

/**
 * 広告を取得（空の場合はFirestoreにデフォルト広告をシードして返す）
 */
export async function trackAdImpression(adId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'ads', adId), { impressions: increment(1) });
  } catch (e) { /* 無視 */ }
}

// ============================================================
// リポスト
// ============================================================

export async function toggleRepost(postId: string, userId: string): Promise<{ reposted: boolean; eventId?: string }> {
  const repostId = `${userId}_${postId}`;
  const ref = doc(db, 'reposts', repostId);
  const postRef = doc(db, 'posts', postId);
  const result = await runTransaction(db, async transaction => {
    const snap = await transaction.get(ref);
    if (snap.exists()) {
      transaction.delete(ref);
      return { reposted: false };
    }
    const eventId = crypto.randomUUID();
    transaction.set(ref, { userId, postId, eventId, createdAt: serverTimestamp() });
    return { reposted: true, eventId };
  });
  await updateDoc(postRef, { repostsCount: increment(result.reposted ? 1 : -1) });
  return result;
}

export async function getRepostedPostIds(userId: string): Promise<string[]> {
  const q = query(collection(db, 'reposts'), where('userId', '==', userId));
  const snap = await getDocs(q);
  const ids: string[] = [];
  snap.forEach(docSnap => { const postId = stringValue(docSnap.data().postId); if (postId) ids.push(postId); });
  return ids;
}

export async function getRepostedPosts(userId: string): Promise<PostRecord[]> {
  const q = query(collection(db, 'reposts'), where('userId', '==', userId), orderBy('createdAt', 'desc'));
  const snap = await getDocs(q);
  const postIds: string[] = [];
  snap.forEach(docSnap => { const postId = stringValue(docSnap.data().postId); if (postId) postIds.push(postId); });
  if (postIds.length === 0) return [];
  return getPostsByIds(postIds);
}
// ============================================================
// フォロワー・フォロー中リスト
// ============================================================

export async function getFollowers(userId: string): Promise<UserProfileRecord[]> {
  try {
    const q = query(collection(db, 'friendships'), where('friendId', '==', userId));
    const snap = await getDocs(q);
    const ids: string[] = [];
    snap.forEach(d => { const data = d.data(); const requester = stringValue(data.requester); if (data.status === 'accepted' && requester) ids.push(requester); });
    const profiles = await getDisplayUserProfilesByIds(ids);
    return [...new Set(ids)].map(id => profiles[id]).filter((user): user is UserProfileRecord => Boolean(user));
  } catch (e) {
    return [];
  }
}

export async function getFollowing(userId: string): Promise<UserProfileRecord[]> {
  try {
    const q = query(collection(db, 'friendships'), where('userId', '==', userId));
    const snap = await getDocs(q);
    const ids: string[] = [];
    snap.forEach(d => { const data = d.data(); const friendId = stringValue(data.friendId); if (data.status === 'accepted' && friendId) ids.push(friendId); });
    const profiles = await getDisplayUserProfilesByIds(ids);
    return [...new Set(ids)].map(id => profiles[id]).filter((user): user is UserProfileRecord => Boolean(user));
  } catch (e) {
    return [];
  }
}

export async function areMutualFriends(uid1: string, uid2: string): Promise<boolean> {
  if (uid1 === uid2) return false;
  const id = [uid1, uid2].sort().join('_');
  const snap = await getDoc(doc(db, 'friendships', id));
  return snap.exists() && snap.data().status === 'accepted';
}

export async function createFriendQrToken(userId: string): Promise<{ app: string; type: string; uid: string; token: string; exp: number }> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const expiresAt = Date.now() + 30 * 60 * 1000;
  await setDoc(doc(db, 'users', userId), {
    friendQrToken: token,
    friendQrExpiresAt: expiresAt,
  }, { merge: true });
  if (_profileCache[userId]) {
    _profileCache[userId] = {
      ..._profileCache[userId],
      friendQrToken: token,
      friendQrExpiresAt: expiresAt,
    };
  }
  return {
    app: 'connect',
    type: 'friend-qr',
    uid: userId,
    token,
    exp: expiresAt,
  };
}

export async function verifyFriendQrPayload(payload: string | FriendQrPayload, currentUserId: string): Promise<{ target: UserProfileRecord; status: string }> {
  let data: FriendQrPayload;
  if (typeof payload === 'string') {
    try {
      const parsed: unknown = JSON.parse(payload);
      data = isRecord(parsed) ? parsed : {};
    } catch (e) {
      throw new Error('QRコードの形式が正しくありません');
    }
  } else {
    data = payload;
  }
  if (!data || data.app !== 'connect' || data.type !== 'friend-qr' || !data.uid || !data.token) {
    throw new Error('Connectの友達QRではありません');
  }
  if (data.uid === currentUserId) {
    throw new Error('自分自身のQRコードは読み取れません');
  }
  const now = Date.now();
  const clockSkewMs = 5 * 60 * 1000;
  if (data.exp && now - clockSkewMs > Number(data.exp)) {
    throw new Error('QRコードの有効期限が切れています');
  }
  const targetSnap = await getDoc(doc(db, 'users', data.uid));
  if (!targetSnap.exists()) {
    throw new Error('ユーザーが見つかりません');
  }
  const target = normalizeProfile(targetSnap);
  _profileCache[stringValue(data.uid)] = target;
  if (target.friendQrToken !== data.token || Number(target.friendQrExpiresAt || 0) + clockSkewMs < now) {
    throw new Error('QRコードの有効期限が切れています');
  }
  const status = await getFriendshipStatus(currentUserId, data.uid);
  return { target, status };
}

export async function createMutualFriendship(userId: string, friendId: string): Promise<FriendshipRecord> {
  if (!userId || !friendId || userId === friendId) {
    throw new Error('友達登録できないユーザーです');
  }
  const friendshipId = [userId, friendId].sort().join('_');
  const friendshipRef = doc(db, 'friendships', friendshipId);
  const result = await runTransaction(db, async transaction => {
    const existing = await transaction.get(friendshipRef);
    const wasAccepted = existing.exists() && existing.data().status === 'accepted';
    const eventId = wasAccepted ? '' : crypto.randomUUID();
    const base = {
      userId,
      friendId,
      status: 'accepted',
      requester: userId,
      ...(eventId ? { acceptEventId: eventId } : {}),
      updatedAt: serverTimestamp(),
    };
    transaction.set(friendshipRef, existing.exists()
      ? base
      : { ...base, createdAt: serverTimestamp() },
      { merge: true }
    );
    return { wasAccepted, eventId, base };
  });
  if (!result.wasAccepted) {
    try {
      await Promise.all([
        updateDoc(doc(db, 'users', userId), { friendsCount: increment(1) }),
        updateDoc(doc(db, 'users', friendId), { friendsCount: increment(1) }),
      ]);
    } catch (e) {
      console.warn('friendsCount update skipped:', e);
    }
  }
  _friendIdsCache.delete(userId);
  _friendIdsCache.delete(friendId);
  return { id: friendshipId, ...result.base, ...(result.eventId ? { eventId: result.eventId } : {}) };
}

export async function searchUserPosts(userId: string, searchText: string, maxResults = 50): Promise<PostRecord[]> {
  const q = query(
    collection(db, 'posts'),
    where('userId', '==', userId),
    limit(maxResults)
  );
  const snap = await getDocs(q);
  const results: PostRecord[] = [];
  const lowerSearch = searchText.toLowerCase();
  snap.forEach(d => {
    const data = d.data();
    if (!data.deletedAt && data.moderationStatus !== 'removed' && data.text && data.text.toLowerCase().includes(lowerSearch)) {
      results.push(toPostRecord(data, d.id));
    }
  });
  return results;
}
