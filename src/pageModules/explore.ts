import { getState, setState } from '../state.ts';
import { escapeHtml, formatTime, formatRelativeTime, getFirebaseErrorMessage, isIndexError, getFirestoreIndexUrl } from '../utils.ts';
import { t } from '../i18n.ts';
import { APP_ICON_PATH } from '../config.ts';
import { COMMENT_ATTACHMENT_LIMIT_BYTES } from '../attachments.ts';
import {
  loginWithEmail, registerWithEmail,
  sendResetPasswordEmail, verifyResetPasswordCode, confirmResetPassword,
  logout,
} from '../auth.ts';
import {
  getUserProfile, getDisplayUserProfile, getPostViewerStates, enrichCommentRecords, updateUserProfile, createUserProfile,
  getFeedPosts, getUserPosts, getPostById, createPost, createQuotePost, updatePost, deletePost,
  toggleLike, hasLiked, getComments, getCommentsPage, addComment,
  searchUsers, getAllUsers,
  getUserFriends, getUserFriendIds, getUserFriendCount, sendFriendRequest, acceptFriendRequest,
  removeFriend, getFriendshipStatus, getPendingRequests,
  getNotifications, getNotificationsPage, getUnreadNotificationCount,
  markNotificationRead, markAllNotificationsRead,
  createNotification,
  getTrendingPosts, searchPosts,
  votePoll, uploadAttachmentFile,
  toggleRepost, getRepostedPostIds, getUserComments, getUserPostCount,
  toggleCommentLike,
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
import { db } from '../firebase.ts';
import { doc, getDoc, collection, updateDoc, serverTimestamp } from 'firebase/firestore';
import { toComment } from '../types/converters.ts';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { authorPostQuery, buildExploreRouteHash, parseExploreRouteState, type ExploreRouteState } from '../exploreRouteState.ts';
import type { Attachment, AuthUser, Comment, Post, TimestampLike, UserProfile } from '../types/domain.ts';
import { notifyMentions, setupCommentDeleteButtons, setupCommentEditButtons, setupCommentLikeButtons, setupPostEventListeners } from './home.ts';
import { isSearchReady } from '../searchReadiness.ts';


type PageParams = { id?: string; tag?: string; uid?: string };
type DbPost = Awaited<ReturnType<typeof getTrendingPosts>>[number];
type DbComment = Awaited<ReturnType<typeof getComments>>[number];
type DbUser = Awaited<ReturnType<typeof getAllUsers>>[number];
type SearchPage = { posts: DbPost[]; cursor: string | null; hasMore: boolean; scanLimitReached: boolean; mode: string };
type DbNotification = Awaited<ReturnType<typeof getNotifications>>[number];
type RenderProfile = Pick<UserProfile, 'uid' | 'displayName' | 'username' | 'photoURL' | 'avatarColor'>;
type EnrichedPost = DbPost & { id: string; userId: string; author: RenderProfile | null; liked: boolean; bookmarked?: boolean; reposted: boolean };
type EnrichedComment = DbComment & { id: string; postId: string; userId: string; text: string; author: RenderProfile | null; liked: boolean; likesCount: number };
type ExploreNewsArticle = { title?: string; url?: string; source?: string; image?: string };
type ExploreNewsItem = {
  category?: string;
  title: string;
  source?: string;
  summary?: string;
  heat?: number;
  url?: string;
  image?: string;
  publishedAt?: string;
  articles?: ExploreNewsArticle[];
};
type ExploreNewsData = { updatedAt?: string; items: ExploreNewsItem[] };
type StoredExploreNewsCache = { data: ExploreNewsData; time: number };
type LoadExploreNewsOptions = { containerId?: string; category?: string; title?: string; force?: boolean };
type ExploreSearchPostState = { query: string; authorId: string; posts: EnrichedPost[]; cursor: string | null; hasMore: boolean };
type NotificationFilter = { key: string; label: string; types: string[] | null };
type RenderPostInput = Parameters<typeof renderPostCard>[0];
type RenderCommentInput = Parameters<typeof renderComment>[0];
type FriendshipStatus = Parameters<typeof renderUserListItem>[2] extends { friendshipStatus?: infer S } ? S : never;

let exploreSearchPostState: ExploreSearchPostState = { query: '', authorId: '', posts: [], cursor: null, hasMore: false };

function toRenderProfile(profile: DbUser | UserProfile | null | undefined): RenderProfile | null {
  if (!profile?.uid) return null;
  return {
    uid: profile.uid,
    displayName: profile.displayName || 'User',
    username: profile.username || '',
    photoURL: profile.photoURL || '',
    avatarColor: profile.avatarColor || '',
  };
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

function getElementById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function toRenderPost(post: DbPost | EnrichedPost): RenderPostInput {
  return {
    ...post,
    id: post.id,
    userId: post.userId || '',
    createdAt: toTimestampLike(post.createdAt),
    updatedAt: toTimestampLike(post.updatedAt),
    scheduledAt: toTimestampLike(post.scheduledAt),
    editedAt: toTimestampLike(post.editedAt),
  } as RenderPostInput;
}

function toRenderComment(comment: EnrichedComment): RenderCommentInput {
  return {
    ...comment,
    id: comment.id,
    postId: comment.postId,
    userId: comment.userId,
    text: comment.text,
    createdAt: toTimestampLike(comment.createdAt),
    editedAt: toTimestampLike(comment.editedAt),
  };
}

function toFriendshipStatus(status: Awaited<ReturnType<typeof getFriendshipStatus>>): FriendshipStatus {
  return status === 'self' ? 'none' : status;
}
const MB = 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 15 * MB;
const MAX_VIDEO_UPLOAD_BYTES = 3 * 1024 * MB;
const MAX_VIDEO_UPLOAD_SECONDS = 180;
const MAX_POST_IMAGE_COUNT = 20;
const MAX_COMMENT_UPLOAD_BYTES = COMMENT_ATTACHMENT_LIMIT_BYTES;
const MAX_OTHER_UPLOAD_BYTES = 10 * MB;
let homeStoryGroupsCache: unknown[] = [];

function getFileExtension(file: File): string {
  return (file.name.split('.').pop() || '').toLowerCase();
}

function isImageFile(file: File): boolean {
  const ext = getFileExtension(file);
  return file.type.startsWith('image/') || ['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(ext);
}

function isVideoFile(file: File): boolean {
  const ext = getFileExtension(file);
  return file.type.startsWith('video/') || ['3gp', 'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm'].includes(ext);
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


function extractGifUrlsFromText(text = ''): string[] {
  const matches = String(text).match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return matches
    .map(url => url.replace(/[)、。.,]+$/g, ''))
    .filter(url => /\.gif(?:\?|#|$)/i.test(url) || /(?:tenor|giphy|gfycat|media\.discordapp|c.tenor)\./i.test(url));
}

function normalizeGifUrl(url = ''): string {
  const cleaned = String(url).trim().replace(/[)、。.,]+$/g, '');
  if (!/^https?:\/\//i.test(cleaned)) return '';
  return cleaned;
}

async function enrichPosts(posts: DbPost[], currentUserId: string): Promise<EnrichedPost[]> {
  const states = currentUserId
    ? await getPostViewerStates(posts.map(post => post.id), currentUserId).catch(() => ({ liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() }))
    : { liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() };
  // The author fields stored on a post are legacy snapshots. Always resolve
  // the current profile by immutable user ID for search, trending, and detail
  // views as well as the home/profile timelines.
  const authorIds = [...new Set(posts.flatMap(post => {
    const quote = post.quotedPost && typeof post.quotedPost === 'object'
      ? post.quotedPost as Record<string, unknown>
      : null;
    return [
      post.userId || '',
      typeof quote?.userId === 'string' ? quote.userId : '',
    ];
  }).filter(Boolean))];
  const profileMap = new Map<string, RenderProfile | null>();
  await Promise.all(authorIds.map(async (uid) => {
    profileMap.set(uid, toRenderProfile(await getDisplayUserProfile(uid).catch((): null => null)));
  }));
  return posts.map((post): EnrichedPost => {
    const userId = post.userId || '';
    // Post snapshots are not authoritative and must not be used when the
    // current profile read is unavailable.
    const author = profileMap.get(userId) ?? null;
    const quote = post.quotedPost && typeof post.quotedPost === 'object'
      ? post.quotedPost as Record<string, unknown>
      : null;
    const quoteUserId = typeof quote?.userId === 'string' ? quote.userId : '';
    const quoteAuthor = quoteUserId ? profileMap.get(quoteUserId) : null;
    const quotedPost = quote ? {
      ...quote,
      authorDisplayName: quoteAuthor?.displayName || '',
      authorUsername: quoteAuthor?.username || '',
      authorPhotoURL: quoteAuthor?.photoURL || '',
      authorAvatarColor: quoteAuthor?.avatarColor || '',
    } : null;
    return { ...post, id: post.id, userId, author, quotedPost, liked: states.liked.has(post.id), bookmarked: states.bookmarked.has(post.id), reposted: states.reposted.has(post.id) };
  });
}

// ============================================================
// ヘルパー: コメントにユーザー情報を付与
// ============================================================
async function enrichComments(comments: DbComment[], currentUserId = ''): Promise<EnrichedComment[]> {
  const enriched = await enrichCommentRecords(comments, currentUserId);
  return enriched.map(comment => ({
    ...comment,
    id: comment.id,
    postId: comment.postId || '',
    userId: comment.userId || '',
    text: comment.text || '',
    likesCount: comment.likesCount,
    author: toRenderProfile(comment.author),
    liked: comment.liked,
  }));
}

function renderCommentThread(comments: EnrichedComment[]): string {
  if (!comments.length) return '';

  const childrenByParent = new Map<string, EnrichedComment[]>();
  const topLevel: EnrichedComment[] = [];
  comments.forEach(comment => {
    if (comment.parentId) {
      const replies = childrenByParent.get(comment.parentId) || [];
      replies.push(comment);
      childrenByParent.set(comment.parentId, replies);
    } else {
      topLevel.push(comment);
    }
  });

  const renderNode = (comment: EnrichedComment, depth = 0): string => {
    const replies = childrenByParent.get(comment.id) || [];
    return `
      <div class="comment-thread" style="--thread-depth:${depth}">
        ${renderComment(toRenderComment(comment), comment.author, comment.liked)}
        ${replies.length ? `<div class="comment-replies">${replies.map(reply => renderNode(reply, depth + 1)).join('')}</div>` : ''}
      </div>
    `;
  };

  return topLevel.map(comment => renderNode(comment)).join('');
}

// ============================================================
// ログインページ
// ============================================================

function getExploreRouteState(): ExploreRouteState {
  return parseExploreRouteState(window.location.hash || '#/explore');
}

function navigateExplore(query: string, tab: ExploreRouteState['tab'], authorId = ''): void {
  window.location.hash = buildExploreRouteHash(query, tab, authorId);
}

function renderNewsSearchItems(items: ExploreNewsItem[]): string {
  if (!items.length) return renderEmptyState(t('ニュースに該当する記事はありません'), '📰');
  return `<section class="search-category"><h3>${t('ニュース')}</h3><div class="news-list search-news-list">${items.slice(0, 5).map((item, index) => `
    <a class="news-trend-item search-news-item" href="${escapeHtml(item.url || item.articles?.[0]?.url || '#')}" target="_blank" rel="noopener noreferrer">
      <span class="news-rank">${index + 1}</span><span class="news-main"><strong>${escapeHtml(item.title || '')}</strong><small>${escapeHtml(item.source || t('ニュース'))}</small></span>
    </a>`).join('')}</div></section>`;
}

async function runExploreSearch(queryText: string, requestId: number, postLimit = 5, tab: ExploreRouteState['tab'] = 'all', postCursor: string | null = null, authorId = ''): Promise<void> {
  const all = document.getElementById('search-results-all');
  const newsBox = document.getElementById('search-results-news');
  const usersBox = document.getElementById('search-results-users');
  const postsBox = document.getElementById('search-results-posts');
  if (!all || !newsBox || !usersBox || !postsBox) return;
  const appendPosts = Boolean(postCursor && exploreSearchPostState.query === queryText && exploreSearchPostState.authorId === authorId);
  if (!appendPosts) {
    all.innerHTML = renderLoadingSpinner();
    newsBox.innerHTML = renderLoadingSpinner();
    usersBox.innerHTML = renderLoadingSpinner();
    postsBox.innerHTML = renderLoadingSpinner();
    exploreSearchPostState = { query: queryText, authorId, posts: [], cursor: null, hasMore: false };
  } else {
    postsBox.innerHTML = renderLoadingSpinner();
  }
  const currentUser = getState('user');
  const shouldFetchNews = tab === 'all' || tab === 'news';
  const shouldFetchUsers = tab === 'all' || tab === 'users';
  const shouldFetchPosts = tab === 'all' || tab === 'posts';
  const newsPromise = shouldFetchNews ? fetchExploreNewsDataWithRetry(false).then(data => {
    const normalized = queryText.normalize('NFKC').toLowerCase().trim();
    const items = (Array.isArray(data.items) ? data.items : []).filter(item => [item.title, item.summary, item.source, item.category].some(value => String(value || '').normalize('NFKC').toLowerCase().includes(normalized)));
    return items;
  }) : Promise.resolve<ExploreNewsItem[]>([]);
  const normalizedQuery = queryText.normalize('NFKC').trim();
  const usersPromise: Promise<DbUser[]> = shouldFetchUsers && !normalizedQuery.startsWith('#') ? searchUsers(queryText).catch((): DbUser[] => []) : Promise.resolve([] as DbUser[]);
  const postsPromise: Promise<SearchPage> = shouldFetchPosts && currentUser
    ? searchPosts(authorPostQuery(queryText, authorId), postLimit, postCursor, authorId || undefined).catch((error): SearchPage => ({ posts: [] as DbPost[], cursor: null, hasMore: false, scanLimitReached: false, mode: String(error?.code || 'error') }))
    : Promise.resolve<SearchPage>({ posts: [] as DbPost[], cursor: null, hasMore: false, scanLimitReached: false, mode: 'auth_required' });
  const [newsResult, usersResult, postsResult] = await Promise.allSettled([newsPromise, usersPromise, postsPromise]);
  if (requestId !== (window as typeof window & { __connectSearchRequestId?: number }).__connectSearchRequestId) return;
  const news = newsResult.status === 'fulfilled' ? newsResult.value : [];
  const users = usersResult.status === 'fulfilled' ? usersResult.value : [];
  const postPage: SearchPage = postsResult.status === 'fulfilled'
    ? postsResult.value
    : { posts: [], cursor: null, hasMore: false, scanLimitReached: false, mode: 'error' };
  const enriched = await enrichPosts(postPage.posts, currentUser?.uid || '').catch((): EnrichedPost[] => []);
  const combinedPosts = appendPosts ? [...exploreSearchPostState.posts, ...enriched] : enriched;
  exploreSearchPostState = { query: queryText, authorId, posts: combinedPosts, cursor: postPage.cursor, hasMore: postPage.hasMore };
  const userHtml = users.length ? users.slice(0, 5).map(user => renderUserListItem(toRenderProfile(user), currentUser?.uid || null)).join('') : renderEmptyState(t('ユーザーに該当する結果はありません'), '👤');
  const postError = postPage.mode === 'SEARCH_NOT_READY'
    ? t('投稿検索は準備中です')
    : postPage.mode === 'SEARCH_NO_ANCHOR' || postPage.mode === 'SEARCH_QUERY_TOO_LONG' || postPage.mode === 'SEARCH_TOO_MANY_TERMS'
      ? t('検索条件を確認してください')
      : postPage.mode === 'error' || postPage.mode === 'SEARCH_INTERNAL_ERROR' || postPage.mode === 'SEARCH_TIMEOUT'
        ? t('投稿検索を読み込めませんでした')
        : '';
  const postHtml = combinedPosts.length
    ? `<section class="search-category"><h3>${t('投稿')}</h3>${combinedPosts.map(post => renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted)).join('')}${postPage.hasMore ? `<button class="btn btn-secondary search-more-posts" data-search-more="posts">${t('投稿をさらに検索')}</button>` : ''}</section>`
    : `${renderEmptyState(postError || (currentUser ? t('投稿に該当する結果はありません') : t('投稿検索にはログインが必要です')), '📝')}${postPage.hasMore ? `<button class="btn btn-secondary search-more-posts" data-search-more="posts">${t('投稿をさらに検索')}</button>` : ''}`;
  const allHtml = `<div class="search-result-summary"><span>${escapeHtml(queryText)}</span></div>${renderNewsSearchItems(news)}<section class="search-category"><h3>${t('ユーザー')}</h3><div class="search-user-results">${userHtml}</div></section>${postHtml}`;
  all.innerHTML = allHtml;
  newsBox.innerHTML = renderNewsSearchItems(news);
  usersBox.innerHTML = `<section class="search-category"><h3>${t('ユーザー')}</h3><div class="search-user-results">${userHtml}</div></section>`;
  postsBox.innerHTML = postHtml;
  setupPostEventListeners(all);
  setupPostEventListeners(postsBox);
  const moreButtons = document.querySelectorAll<HTMLButtonElement>('.search-more-posts');
  moreButtons.forEach(button => button.addEventListener('click', () => {
    if (tab === 'posts' && exploreSearchPostState.cursor) {
      const nextRequestId = ((window as typeof window & { __connectSearchRequestId?: number }).__connectSearchRequestId || 0) + 1;
      (window as typeof window & { __connectSearchRequestId?: number }).__connectSearchRequestId = nextRequestId;
      void runExploreSearch(queryText, nextRequestId, 20, 'posts', exploreSearchPostState.cursor, authorId);
      return;
    }
    navigateExplore(queryText, 'posts', authorId);
  }));
}

export async function renderExplorePage() {
  const routeHash = window.location.hash || '#/feed';
  const state = getExploreRouteState();
  const searchReady = await isSearchReady();
  if (window.location.hash !== routeHash) return;
  const requestId = ((window as typeof window & { __connectSearchRequestId?: number }).__connectSearchRequestId || 0) + 1;
  (window as typeof window & { __connectSearchRequestId?: number }).__connectSearchRequestId = requestId;
  const container = document.getElementById('page-content');
  const hasQuery = Boolean(state.query.trim());
  const canSearch = searchReady || Boolean(state.authorId);
  const searchControls = canSearch ? `
       <form class="explore-search-form" id="explore-search-form" role="search">
         <label class="sr-only" for="explore-search-input">${t('ニュース・ユーザー・投稿を検索…')}</label>
         <div class="explore-search-field"><svg class="explore-search-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>
         <input class="form-input" id="explore-search-input" value="${escapeHtml(state.query)}" maxlength="128" placeholder="${t('ニュース・ユーザー・投稿を検索…')}" autocomplete="off"></div>
         <button class="btn btn-primary" type="submit">${t('検索')}</button>
         <button class="btn btn-secondary ${hasQuery ? '' : 'hidden'}" id="explore-search-clear" type="button">${t('クリア')}</button>
       </form>
       <div class="explore-tabs" role="tablist" aria-label="${t('検索カテゴリ')}" id="explore-tabs">
         ${(['all', 'trending', 'users', 'posts', 'news'] as const).map(tab => `<button class="explore-tab ${state.tab === tab ? 'active' : ''}" data-explore-tab="${tab}" role="tab" aria-controls="explore-panel-${tab}" aria-selected="${state.tab === tab ? 'true' : 'false'}">${tab === 'all' ? t('すべて') : tab === 'news' ? t('ニュース') : tab === 'users' ? t('ユーザー') : tab === 'posts' ? t('投稿') : t('トレンド')}</button>`).join('')}
       </div>` : '';
  const explorePanels = canSearch ? `
       <div class="explore-panel ${state.tab === 'all' ? 'active' : ''}" id="explore-panel-all" role="tabpanel"><div id="search-results-all">${hasQuery ? renderLoadingSpinner() : `
         <section class="explore-discovery-section" aria-label="${t('ニュース')}"><div id="all-discovery-news">${renderLoadingSpinner()}</div></section>
         <section class="explore-discovery-section" aria-label="${t('トレンドの投稿')}"><div id="all-discovery-trending">${renderLoadingSpinner()}</div></section>
       `}</div></div>
       <div class="explore-panel ${state.tab === 'news' ? 'active' : ''}" id="explore-panel-news" role="tabpanel"><div id="search-results-news">${hasQuery ? renderLoadingSpinner() : ''}</div><div class="news-trends" id="news-trends">${renderLoadingSpinner()}</div></div>
       <div class="explore-panel ${state.tab === 'users' ? 'active' : ''}" id="explore-panel-users" role="tabpanel"><div id="search-results-users">${hasQuery ? renderLoadingSpinner() : renderEmptyState(t('検索語を入力してください'), '👤')}</div></div>
       <div class="explore-panel ${state.tab === 'posts' ? 'active' : ''}" id="explore-panel-posts" role="tabpanel"><div id="search-results-posts">${hasQuery ? renderLoadingSpinner() : renderEmptyState(t('検索語を入力してください'), '📝')}</div></div>
       <div class="explore-panel ${state.tab === 'trending' ? 'active' : ''}" id="explore-panel-trending" role="tabpanel"><div class="trending-posts" id="trending-posts">${renderLoadingSpinner()}</div></div>` : `
       ${state.tab === 'trending'
    ? '<div class="explore-panel active" id="explore-panel-trending" role="tabpanel"><div class="trending-posts" id="trending-posts">' + renderLoadingSpinner() + '</div></div>'
    : state.tab === 'news'
      ? '<div class="explore-panel active" id="explore-panel-news" role="tabpanel"><div class="news-trends" id="news-trends">' + renderLoadingSpinner() + '</div></div>'
      : `<div class="explore-panel active" id="explore-panel-${state.tab}" role="tabpanel">${renderEmptyState(t('検索機能は準備中です'), '🔎')}</div>`}`;
  container.innerHTML = `
    <div class="explore-page">
       <div class="page-header"><h2 class="page-title">${t('探す')}</h2></div>
       ${searchControls}
       ${explorePanels}
     </div>
   `;
  const input = document.getElementById('explore-search-input') as HTMLInputElement | null;
  const form = document.getElementById('explore-search-form') as HTMLFormElement | null;
  let isComposing = false;
  input?.addEventListener('compositionstart', () => { isComposing = true; });
  input?.addEventListener('compositionend', () => { isComposing = false; });
  form?.addEventListener('submit', event => {
    event.preventDefault();
    if (isComposing) return;
    navigateExplore(input?.value || '', state.authorId ? 'posts' : input?.value.trim() ? 'all' : 'trending', state.authorId);
  });
  input?.addEventListener('keydown', event => {
    if (event.isComposing && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  document.getElementById('explore-search-clear')?.addEventListener('click', () => navigateExplore('', 'trending'));
  document.querySelectorAll('.explore-tab').forEach(tab => tab.addEventListener('click', () => {
    const nextTab = (tab as HTMLElement).dataset.exploreTab as ExploreRouteState['tab'];
    navigateExplore(state.query, nextTab, nextTab === 'posts' ? state.authorId : '');
  }));
  if (state.authorId && input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  if (hasQuery && state.tab === 'trending') {
    loadTrendingPosts();
  } else if (hasQuery) {
    await runExploreSearch(state.query, requestId, state.tab === 'posts' ? 20 : 5, state.tab, null, state.authorId);
  } else {
    if (state.tab === 'trending') loadTrendingPosts();
    if (state.tab === 'news') loadExploreNews({ category: 'ニュース', title: t('ニュース') });
    if (state.tab === 'all') {
      loadExploreNews({ containerId: 'all-discovery-news', category: 'ニュース', title: t('ニュース') });
      loadTrendingPosts('all-discovery-trending');
    }
  }
}

async function loadTrendingPosts(containerId = 'trending-posts') {
  const routeHash = window.location.hash;
  try {
    const posts = await getTrendingPosts(10);
    const currentUser = getState('user');
    const enriched = await enrichPosts(posts, currentUser?.uid || '');
    const container = document.getElementById(containerId);
    if (!container || window.location.hash !== routeHash) return;
    if (enriched.length === 0) {
      container.innerHTML = '<p class="no-items">' + t('トレンド投稿はまだありません') + '</p>';
      return;
    }
    let html = '<h3 class="trending-section-title">' + t('トレンドの投稿') + '</h3>';
    for (const post of enriched) {
      html += renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted);
    }
    container.innerHTML = html;
    setupPostEventListeners(container);
  } catch (e) {
    console.error('loadTrendingPosts error:', e);
    const container = document.getElementById(containerId);
    if (container && window.location.hash === routeHash) container.innerHTML = '<p class="no-items">読み込みエラー</p>';
  }
}

let exploreNewsCache: ExploreNewsData | null = null;
let exploreNewsCacheAt = 0;
let exploreNewsInflight: Promise<ExploreNewsData> | null = null;
const EXPLORE_NEWS_CACHE_KEY = 'connect_explore_news_cache_v2';
const EXPLORE_NEWS_CACHE_TTL = 10 * 60 * 1000;
const EXPLORE_NEWS_STALE_TTL = 60 * 60 * 1000;

function readStoredExploreNewsCache(): StoredExploreNewsCache | null {
  try {
    const raw = sessionStorage.getItem(EXPLORE_NEWS_CACHE_KEY) || localStorage.getItem(EXPLORE_NEWS_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached?.data || !cached?.time) return null;
    return cached;
  } catch (_) {
    return null;
  }
}

function writeStoredExploreNewsCache(data: ExploreNewsData, time: number): void {
  const payload = JSON.stringify({ data, time });
  try { sessionStorage.setItem(EXPLORE_NEWS_CACHE_KEY, payload); } catch (_) {}
  try { localStorage.setItem(EXPLORE_NEWS_CACHE_KEY, payload); } catch (_) {}
}

function getExploreNewsFallback(): ExploreNewsData {
  const stored = readStoredExploreNewsCache();
  if (exploreNewsCache) return exploreNewsCache;
  if (stored?.data) return stored.data;
  return {
    items: [
      { category: 'ニュース', title: '主要ニュースを更新中', source: 'Connect News', summary: '最新記事を取得しています。少し待つと自動で更新されます。', heat: 0, articles: [] },
      { category: 'エンタメ', title: 'エンタメ記事を更新中', source: 'Connect News', summary: '映画、音楽、アニメなどの記事を取得しています。', heat: 0, articles: [] },
      { category: 'スポーツ', title: 'スポーツ記事を更新中', source: 'Connect News', summary: '試合結果や注目ニュースを取得しています。', heat: 0, articles: [] },
    ],
  };
}

async function fetchExploreNewsData(force = false): Promise<ExploreNewsData> {
  const now = Date.now();
  if (!force && exploreNewsCache && now - exploreNewsCacheAt < EXPLORE_NEWS_CACHE_TTL) return exploreNewsCache;
  const stored = readStoredExploreNewsCache();
  if (!force && stored && now - stored.time < EXPLORE_NEWS_CACHE_TTL) {
    exploreNewsCache = stored.data;
    exploreNewsCacheAt = stored.time;
    return exploreNewsCache;
  }
  if (!force && exploreNewsInflight) return exploreNewsInflight;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6200);
  exploreNewsInflight = fetch(`/api/news${force ? '?refresh=1' : ''}`, { signal: controller.signal })
    .then(async res => {
      if (!res.ok) throw new Error('news api failed');
      const payload = await res.json();
      const data: ExploreNewsData = { ...payload, updatedAt: payload.updatedAt || new Date().toISOString() };
      const cacheTime = Date.now();
      exploreNewsCache = data;
      exploreNewsCacheAt = cacheTime;
      writeStoredExploreNewsCache(data, cacheTime);
      return data;
    })
    .catch(error => {
      if (force) throw error;
      if (exploreNewsCache) return exploreNewsCache;
      if (stored && now - stored.time < EXPLORE_NEWS_STALE_TTL) {
        exploreNewsCache = stored.data;
        exploreNewsCacheAt = stored.time;
        return stored.data;
      }
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      exploreNewsInflight = null;
    });
  return exploreNewsInflight;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchExploreNewsDataWithRetry(force = false): Promise<ExploreNewsData> {
  try {
    return await fetchExploreNewsData(force);
  } catch (error) {
    return getExploreNewsFallback();
  }
}

async function loadExploreNews(options: LoadExploreNewsOptions = {}): Promise<void> {
  const routeHash = window.location.hash;
  const { containerId = 'news-trends', category = '', title = t('ニュース') } = options;
  const container = document.getElementById(containerId);
  if (!container) return;
  const refreshId = `news-refresh-${containerId}`;
  const refreshButton = options.force ? container.querySelector<HTMLButtonElement>(`#${refreshId}`) : null;
  const isRefreshing = Boolean(refreshButton);
  if (isRefreshing && refreshButton) {
    container.querySelector('.news-refresh-status')?.remove();
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    refreshButton.textContent = t('更新中…');
    const status = document.createElement('span');
    status.className = 'news-refresh-status';
    status.setAttribute('role', 'status');
    status.textContent = t('ニュースを更新しています…');
    refreshButton.insertAdjacentElement('afterend', status);
    container.setAttribute('aria-busy', 'true');
  } else {
    container.innerHTML = renderLoadingSpinner();
  }
  try {
    let data = options.force
      ? await fetchExploreNewsData(true)
      : await fetchExploreNewsDataWithRetry(false);
    let allItems = Array.isArray(data.items) ? data.items : [];
    let items = category
      ? allItems.filter(item => item.category === category || String(item.source || '').includes(category))
      : allItems;
    if (items.length === 0) {
      if (!options.force) {
        container.innerHTML = renderLoadingSpinner();
        await wait(900);
        if (window.location.hash !== routeHash) return;
        data = await fetchExploreNewsDataWithRetry(true);
        allItems = Array.isArray(data.items) ? data.items : [];
        items = category
          ? allItems.filter(item => item.category === category || String(item.source || '').includes(category))
          : allItems;
      }
      if (items.length === 0) items = getExploreNewsFallback().items.filter(item => !category || item.category === category);
    }
    if (window.location.hash !== routeHash) return;
    const detailId = `news-detail-${containerId}`;
    const updated = data.updatedAt ? formatRelativeTime({ toDate: () => new Date(data.updatedAt) }) : t('更新日時を確認できません');
    container.innerHTML = `
      <div class="news-headline-card">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p>${t('ポストではなく、ニュース記事の流行と更新状況から表示しています')} · ${updated}</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="${refreshId}">${t('更新')}</button>
      </div>
      <div class="news-list">
        ${items.map((item, index) => `
          <button class="news-trend-item" data-news-index="${index}" type="button">
            <span class="news-rank">${index + 1}</span>
            <span class="news-main">
              <strong>${escapeHtml(item.title)}</strong>
              <small>${escapeHtml(item.source || t('ニュース'))} · ${escapeHtml(String(item.heat || 0))}${t('件の記事反応')}</small>
            </span>
          </button>
        `).join('')}
      </div>
      <div class="news-detail" id="${detailId}"></div>
    `;
    container.setAttribute('aria-busy', 'false');
    const renderDetail = (item: ExploreNewsItem | undefined): void => {
      if (!item) return;
      const detail = document.getElementById(detailId);
      if (!detail) return;
      const itemUrl = item.url || item.articles?.[0]?.url || '#';
      const articleCards = (item.articles || []).filter(article => {
        const sameUrl = (article.url || '') === (item.url || '');
        const sameTitle = (article.title || item.title || '') === (item.title || '');
        return !(sameUrl || sameTitle);
      });
      detail.innerHTML = `
        <article class="news-detail-card">
          <a href="${escapeHtml(itemUrl)}" class="news-detail-link" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(item.title)}">
            ${item.image ? `<div class="news-detail-hero"><img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" onerror="this.closest('.news-detail-hero')?.remove()"></div>` : ''}
            <div class="news-detail-body">
              <small>${escapeHtml(item.source || t('ニュース'))} · ${item.publishedAt ? escapeHtml(item.publishedAt) : ''}</small>
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.summary || '')}</p>
            </div>
          </a>
          ${articleCards.length ? `
            <div class="news-article-grid">
              ${articleCards.map(article => `
                <a href="${escapeHtml(article.url || item.url || '#')}" class="news-article-card" target="_blank" rel="noopener noreferrer">
                  ${article.image ? `<img src="${escapeHtml(article.image)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
                  <span><strong>${escapeHtml(article.title || item.title)}</strong><small>${escapeHtml(article.source || item.source || '')}</small></span>
                </a>
              `).join('')}
            </div>
          ` : ''}
        </article>
      `;
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    container.querySelectorAll('.news-trend-item').forEach(btn => {
      btn.addEventListener('click', () => renderDetail(items[Number((btn as HTMLElement).dataset.newsIndex)]));
    });
    document.getElementById(refreshId)?.addEventListener('click', () => loadExploreNews({ ...options, force: true }));
  } catch (e) {
    console.error('loadExploreNews error:', e);
    if (window.location.hash !== routeHash) return;
    if (isRefreshing && refreshButton?.isConnected) {
      refreshButton.disabled = false;
      refreshButton.removeAttribute('aria-busy');
      refreshButton.textContent = t('更新');
      container.setAttribute('aria-busy', 'false');
      const status = container.querySelector<HTMLElement>('.news-refresh-status');
      if (status) status.textContent = t('更新できませんでした。前回の内容を表示しています');
      return;
    }
    container.innerHTML = renderLoadingSpinner();
    await wait(1200);
    if (window.location.hash !== routeHash) return;
    try {
      const data = await fetchExploreNewsData(true);
      if (window.location.hash !== routeHash) return;
      const allItems = Array.isArray(data.items) ? data.items : [];
      const items = category
        ? allItems.filter(item => item.category === category || String(item.source || '').includes(category))
        : allItems;
      if (items.length) {
        await loadExploreNews({ ...options, force: false });
        return;
      }
    } catch (_) {}
    if (window.location.hash !== routeHash) return;
    container.innerHTML = renderEmptyState(t('ニュースを取得できませんでした'), '📰');
    container.setAttribute('aria-busy', 'false');
  }
}
function toRenderNotification(notif: DbNotification) {
  const fromUser = toRenderProfile(notif.fromUser || null) || undefined;
  return {
    id: notif.id,
    userId: typeof notif.userId === 'string' ? notif.userId : '',
    type: typeof notif.type === 'string' ? notif.type : 'other',
    context: typeof notif.context === 'string' ? notif.context : '',
    fromUser,
    fromUserId: typeof notif.fromUserId === 'string' ? notif.fromUserId : '',
    postId: typeof notif.postId === 'string' ? notif.postId : undefined,
    conversationId: typeof notif.conversationId === 'string' ? notif.conversationId : undefined,
    commentId: typeof notif.commentId === 'string' ? notif.commentId : undefined,
    storyId: typeof notif.storyId === 'string' ? notif.storyId : undefined,
    messageId: typeof notif.messageId === 'string' ? notif.messageId : undefined,
    deepLink: typeof notif.deepLink === 'string' ? notif.deepLink : undefined,
    read: Boolean(notif.read),
    createdAt: toTimestampLike(notif.createdAt),
  };
}
// ============================================================
// 通知ページ
// ============================================================
export async function renderNotificationsPage() {
  const routeHash = window.location.hash;
  const currentUser = getState('user');
  if (!currentUser) { window.location.hash = '#/login'; return; }

  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="notifications-page">
      <div class="page-header">
        <h2 class="page-title">${t('通知')}</h2>
        <button class="btn btn-sm btn-text" id="mark-all-read">${t('すべて既読')}</button>
      </div>
      <div class="notification-filters" id="notification-filters" role="tablist" aria-label="${t('通知フィルタ')}"></div>
      <div class="notifications-list" id="notifications-list">
        ${renderLoadingSpinner()}
      </div>
      <div class="notifications-load-more-wrap"><button class="btn btn-secondary hidden" id="notifications-load-more">${t('さらに読み込む')}</button></div>
    </div>
  `;

  try {
    const firstPage = await getNotificationsPage(currentUser.uid, 30);
    if (window.location.hash !== routeHash) return;
    let notifs = firstPage.notifications;
    let nextCursor = firstPage.cursor;
    let hasMoreNotifications = firstPage.hasMore;
    const list = document.getElementById('notifications-list');
    const filters: NotificationFilter[] = [
      { key: 'all', label: t('すべて'), types: null },
      { key: 'reply', label: t('返信'), types: ['comment', 'reply', 'thread_reply'] },
      { key: 'like', label: t('いいね'), types: ['like'] },
      { key: 'mention', label: t('メンション'), types: ['mention'] },
      { key: 'friend', label: t('友達'), types: ['friend_request', 'friend_accept', 'friend_post', 'friend_story'] },
      { key: 'story', label: t('近況'), types: ['friend_story', 'story_reaction'] },
    ];
    let activeFilter = sessionStorage.getItem('connect_notification_filter') || 'all';
    const updateLoadMoreButton = () => {
      const btn = document.getElementById('notifications-load-more') as HTMLButtonElement | null;
      if (!btn) return;
      btn.classList.toggle('hidden', !hasMoreNotifications);
      btn.disabled = false;
      btn.textContent = t('さらに読み込む');
    };
    const renderFilterTabs = () => {
      const filterEl = document.getElementById('notification-filters');
      if (!filterEl) return;
      filterEl.innerHTML = filters.map(filter => {
        const count = filter.types ? notifs.filter(n => filter.types.includes(n.type)).length : notifs.length;
        const unread = filter.types ? notifs.filter(n => filter.types.includes(n.type) && !n.read).length : notifs.filter(n => !n.read).length;
        return `
          <button class="notification-filter ${activeFilter === filter.key ? 'active' : ''}" data-filter="${filter.key}" role="tab" aria-selected="${activeFilter === filter.key ? 'true' : 'false'}">
            <span>${filter.label}</span>
            <span class="notification-filter-count">${count}</span>
            ${unread ? `<span class="notification-filter-unread">${unread}</span>` : ''}
          </button>
        `;
      }).join('');
      filterEl.querySelectorAll('.notification-filter').forEach(btn => {
        btn.addEventListener('click', () => {
          activeFilter = (btn as HTMLElement).dataset.filter || 'all';
          sessionStorage.setItem('connect_notification_filter', activeFilter);
          renderFilterTabs();
          renderNotificationList();
        });
      });
    };
    const renderNotificationList = () => {
      const active = filters.find(f => f.key === activeFilter) || filters[0];
      const visible = active.types ? notifs.filter(n => active.types.includes(n.type)) : notifs;
      if (!list) return;
      if (visible.length === 0) {
        list.innerHTML = renderEmptyState(t('通知はありません'), '🔔');
        updateLoadMoreButton();
        return;
      }
      list.innerHTML = visible.map(n => renderNotification(toRenderNotification(n))).join('');
      list.querySelectorAll('.notif-item').forEach(item => {
        item.addEventListener('click', () => {
          const id = (item as HTMLElement).dataset.notifId;
          if (id) markNotificationRead(id).catch(() => {});
          item.classList.remove('notif-unread');
        });
      });
      updateLoadMoreButton();
    };
    if (notifs.length === 0) {
      list.innerHTML = renderEmptyState(t('通知はありません'), '🔔');
      updateLoadMoreButton();
    } else {
      renderFilterTabs();
      renderNotificationList();
    }

    document.getElementById('mark-all-read')?.addEventListener('click', async () => {
      await markAllNotificationsRead(currentUser.uid);
      if (window.location.hash !== routeHash) return;
      notifs.forEach(n => { n.read = true; });
      document.querySelectorAll('.notif-unread').forEach(el => el.classList.remove('notif-unread'));
      renderFilterTabs();
      updateLoadMoreButton();
    });

    document.getElementById('notifications-load-more')?.addEventListener('click', async (event) => {
      const btn = event.currentTarget as HTMLButtonElement;
      if (!nextCursor || !hasMoreNotifications) return;
      btn.disabled = true;
      btn.textContent = t('読み込み中...');
      const page = await getNotificationsPage(currentUser.uid, 30, nextCursor);
      if (window.location.hash !== routeHash) return;
      const seen = new Set(notifs.map(n => n.id));
      notifs = [...notifs, ...page.notifications.filter(n => !seen.has(n.id))];
      nextCursor = page.cursor;
      hasMoreNotifications = page.hasMore;
      renderFilterTabs();
      renderNotificationList();
    });
  } catch (e) {
    if (window.location.hash === routeHash) {
      const list = document.getElementById('notifications-list');
      if (list) list.innerHTML = renderEmptyState(t('読み込みエラー'), '😵');
    }
  }
}

// ============================================================
// 投稿詳細ページ
// ============================================================
export async function renderPostDetailPage(params: PageParams = {}): Promise<void> {
  const currentUser = getState('user');

  const postId = params?.id;
  if (!postId) { window.location.hash = '#/'; return; }

  const container = document.getElementById('page-content');
  container.innerHTML = `<div class="post-detail-page" id="post-detail-container">${renderLoadingSpinner()}</div>`;

  try {
    // Firebase remains the source for normal Connect posts. Test/synthetic
    // records are never injected into the production UI; the Ask AI action
    // always targets the post the user is actually viewing.
    const post = await getPostById(postId);
    if (!post) {
      window.location.hash = '#/notifications';
      return;
    }
    const enriched = await enrichPosts([post], currentUser?.uid || '');
    const detailPost = enriched[0];

    const firstCommentsPage = await getCommentsPage(postId, 30);
    let loadedComments = [...firstCommentsPage.comments];
    let commentsCursor = firstCommentsPage.cursor;
    let hasMoreComments = firstCommentsPage.hasMore;
    const notificationCommentId = new URLSearchParams(window.location.hash.split('?')[1] || '').get('commentId');
    if (notificationCommentId && !loadedComments.some(comment => comment.id === notificationCommentId)) {
      const existingIds = new Set(loadedComments.map(comment => comment.id));
      const targetPath: DbComment[] = [];
      let nextCommentId: string | null = notificationCommentId;
      for (let depth = 0; nextCommentId && depth < 12 && !existingIds.has(nextCommentId); depth++) {
        const snapshot = await getDoc(doc(db, 'comments', nextCommentId)).catch((): null => null);
        if (!snapshot?.exists()) break;
        const comment = toComment(snapshot.data(), snapshot.id) as DbComment;
        if (comment.postId !== postId) break;
        targetPath.push(comment);
        existingIds.add(comment.id);
        nextCommentId = typeof comment.parentId === 'string' ? comment.parentId : null;
      }
      loadedComments = [...loadedComments, ...targetPath.reverse()];
    }
    const renderDetailCommentsHtml = async (): Promise<string> => {
      const enrichedComments = await enrichComments(loadedComments, currentUser?.uid || '');
      return enrichedComments.length === 0
        ? `<p class="no-comments">${t('コメントはまだありません')}</p>`
        : renderCommentThread(enrichedComments);
    };
    const detailCommentsCount = () => Math.max(Number(detailPost.commentsCount || 0), loadedComments.length);
    const commentsHtml = await renderDetailCommentsHtml();
    let html = renderPostCard(toRenderPost(detailPost), detailPost.author, detailPost.liked, detailPost.reposted, { detail: true });
    html += `<div class="comments-section"><h3 id="detail-comments-heading">${t('コメント')} (${detailCommentsCount()})</h3><div id="detail-comments-list">${commentsHtml}</div><button type="button" class="btn btn-secondary btn-sm comments-load-more ${hasMoreComments ? '' : 'hidden'}" id="detail-comments-load-more">${t('さらにコメントを読み込む')}</button>`;
    html += currentUser ? `      <div class="add-comment">
        <div class="replying-to hidden" id="detail-replying-to">
          <span id="detail-replying-to-text"></span>
          <button type="button" id="detail-cancel-reply" aria-label="${t('返信をキャンセル')}">×</button>
        </div>
        <textarea id="comment-textarea" placeholder="${t('コメントを入力...')}" rows="2"></textarea>
        <div class="add-comment-tools">
          <input type="file" id="detail-comment-file" accept="*/*" style="display:none">
          <button class="btn-icon detail-comment-attach-btn" id="detail-comment-btn-file" type="button" title="${t('ファイルを添付')}" aria-label="${t('ファイルを添付')}"><span>＋</span><span>${t('添付')}</span></button>
          <div id="detail-comment-preview" class="comment-media-preview hidden"></div>
          <button class="btn btn-primary" id="submit-comment">${t('投稿')}</button>
        </div>
      </div>
    </div>` : `
      <div class="guest-cta-card guest-cta-card-inline"><strong>${t('コメントするにはログインが必要です')}</strong><a class="btn btn-primary" href="#/login">${t('ログイン')}</a></div>
    </div>`;

    const detailContainer = document.getElementById('post-detail-container');
    if (detailContainer) detailContainer.innerHTML = html;
    else container.innerHTML = `<div class="post-detail-page" id="post-detail-container">${html}</div>`;
    if (notificationCommentId) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`.comment[data-comment-id="${CSS.escape(notificationCommentId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }

    let detailSelectedFile: File | null = null;
    let detailPreviewUrl = '';
    let detailReplyToCommentId: string | null = null;

    const bindDetailReplyButtons = (scope: ParentNode): void => {
      scope.querySelectorAll('[data-action="reply-comment"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const textarea = getElementById<HTMLTextAreaElement>('comment-textarea');
          const commentName = btn.closest('.comment')?.querySelector('.comment-name')?.textContent || '';
          detailReplyToCommentId = (btn as HTMLElement).dataset.commentId || null;
          if (textarea) {
            textarea.focus();
            textarea.placeholder = `@${commentName}${t('に返信...')}`;
            textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          const replyingTo = document.getElementById('detail-replying-to');
          const replyingToText = document.getElementById('detail-replying-to-text');
          if (replyingTo && replyingToText) {
            replyingToText.textContent = `${commentName}${t('に返信中')}`;
            replyingTo.classList.remove('hidden');
          }
        });
      });
    };

    const refreshDetailComments = async (): Promise<void> => {
      const list = getElementById<HTMLElement>('detail-comments-list');
      const loadMore = getElementById<HTMLButtonElement>('detail-comments-load-more');
      const heading = getElementById<HTMLElement>('detail-comments-heading');
      if (list) {
        list.innerHTML = await renderDetailCommentsHtml();
        setupCommentLikeButtons(list);
        setupCommentEditButtons(list, (commentId, text) => {
          const comment = loadedComments.find(item => item.id === commentId);
          if (comment) comment.text = text;
        });
        setupCommentDeleteButtons(list, async () => {
          await renderPostDetailPage(params);
        });
        bindDetailReplyButtons(list);
      }
      if (heading) heading.textContent = `${t('コメント')} (${detailCommentsCount()})`;
      if (loadMore) {
        loadMore.classList.toggle('hidden', !hasMoreComments);
        loadMore.disabled = false;
        loadMore.textContent = t('さらにコメントを読み込む');
      }
    };

    document.getElementById('detail-comment-btn-file')?.addEventListener('click', () => document.getElementById('detail-comment-file')?.click());

    document.getElementById('detail-comment-file')?.addEventListener('change', () => {
      const inputEl = getElementById<HTMLInputElement>('detail-comment-file');
      const file = inputEl?.files?.[0];
      if (!file) return;
      if (!validateUploadFile(file, inputEl)) return;
      detailSelectedFile = file;
      if (detailPreviewUrl) URL.revokeObjectURL(detailPreviewUrl);
      detailPreviewUrl = URL.createObjectURL(file);
      const preview = getElementById<HTMLElement>('detail-comment-preview');
      if (!preview) return;
      if (isVideoFile(file)) {
        preview.innerHTML = `<div class="preview-item"><video src="${detailPreviewUrl}" controls preload="none" playsinline></video><button class="preview-remove-btn">✕</button></div>`;
        preview.classList.remove('hidden');
        return;
      }
      if (isAudioFile(file)) {
        preview.innerHTML = `<div class="preview-item preview-file"><span class="preview-file-icon">♫</span><span class="preview-file-name">${escapeHtml(file.name)}</span><audio src="${detailPreviewUrl}" controls preload="none"></audio><button class="preview-remove-btn">✕</button></div>`;
        preview.classList.remove('hidden');
        return;
      }
      if (isImageFile(file)) {
        preview.innerHTML = `<div class="preview-item"><img src="${escapeHtml(detailPreviewUrl)}" alt="" decoding="async"><button class="preview-remove-btn">✕</button></div>`;
        preview.classList.remove('hidden');
        return;
      }
      preview.innerHTML = `<div class="preview-item preview-file"><span class="preview-file-icon">＋</span><span class="preview-file-name">${escapeHtml(file.name)}</span><button class="preview-remove-btn">✕</button></div>`;
      preview.classList.remove('hidden');
    });

    document.getElementById('detail-comment-preview')?.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.classList.contains('preview-remove-btn')) {
        detailSelectedFile = null;
        if (detailPreviewUrl) {
          URL.revokeObjectURL(detailPreviewUrl);
          detailPreviewUrl = '';
        }
        const detailFileInput = getElementById<HTMLInputElement>('detail-comment-file');
        if (detailFileInput) detailFileInput.value = '';
        const preview = getElementById<HTMLElement>('detail-comment-preview');
        if (!preview) return;
        preview.classList.add('hidden');
        preview.innerHTML = '';
      }
    });

    document.getElementById('submit-comment')?.addEventListener('click', async () => {
      const textarea = getElementById<HTMLTextAreaElement>('comment-textarea');
      const text = textarea?.value.trim() || '';
      if (!text && !detailSelectedFile) return;
      const btn = getElementById<HTMLButtonElement>('submit-comment');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = t('送信中...');
      try {
        let imageURL = '';
        let videoURL = '';
        let audioURL = '';
        let fileURL = '';
        let fileName = '';
        let attachments: Attachment[] = [];
        if (detailSelectedFile) {
          const ext = detailSelectedFile.name.split('.').pop() || 'file';
          const path = `comments/${currentUser.uid}/${Date.now()}.${ext}`;
          const attachment = await uploadAttachmentFile(detailSelectedFile, path, () => {});
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
          parentId: detailReplyToCommentId,
        });
        const replyTarget = detailReplyToCommentId
          ? loadedComments.find(comment => comment.id === detailReplyToCommentId)
          : null;
        const targetUserId = (detailReplyToCommentId && replyTarget?.userId)
          || detailPost.author?.uid
          || detailPost.userId
          || '';
        if (targetUserId !== currentUser.uid) {
          await createNotification({
            userId: targetUserId,
            type: detailReplyToCommentId ? 'reply' : 'comment',
            fromUserId: currentUser.uid,
            postId,
            commentId: createdComment.id,
            eventId: createdComment.id,
            context: text.slice(0, 80),
          });
        }
        await notifyMentions(text, currentUser.uid, postId, [targetUserId], createdComment.id);
        textarea.value = '';
        detailReplyToCommentId = null;
        detailSelectedFile = null;
        if (detailPreviewUrl) {
          URL.revokeObjectURL(detailPreviewUrl);
          detailPreviewUrl = '';
        }
        const detailFileInput = getElementById<HTMLInputElement>('detail-comment-file');
        if (detailFileInput) detailFileInput.value = '';
        document.getElementById('detail-comment-preview')?.classList.add('hidden');
        const commentPreview = document.getElementById('detail-comment-preview');
        if (commentPreview) commentPreview.innerHTML = '';
        const existingCommentIds = new Set(loadedComments.map(comment => comment.id));
        if (!existingCommentIds.has(createdComment.id)) loadedComments = [...loadedComments, createdComment];
        await refreshDetailComments();
      } catch (e) {
        console.error('Comment submission error:', e);
        alert(t('コメント投稿に失敗しました'));
      } finally {
        if (document.body.contains(btn)) {
          btn.disabled = false;
          btn.textContent = t('投稿');
        }
      }
    });

    setupPostEventListeners(container);
    setupCommentLikeButtons(container);
    setupCommentEditButtons(container, (commentId, text) => {
      const comment = loadedComments.find(item => item.id === commentId);
      if (comment) comment.text = text;
    });
    setupCommentDeleteButtons(container, async () => {
      await renderPostDetailPage(params);
    });

    document.getElementById('detail-comments-load-more')?.addEventListener('click', async () => {
      const button = getElementById<HTMLButtonElement>('detail-comments-load-more');
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
        await refreshDetailComments();
      } catch (error) {
        console.error('Load more detail comments error:', error);
        button.disabled = false;
        button.textContent = t('さらにコメントを読み込む');
      }
    });

    bindDetailReplyButtons(container);

    document.getElementById('detail-cancel-reply')?.addEventListener('click', () => {
      detailReplyToCommentId = null;
      const textarea = getElementById<HTMLTextAreaElement>('comment-textarea');
      if (textarea) (textarea as HTMLTextAreaElement).placeholder = t('コメントを入力...');
      document.getElementById('detail-replying-to')?.classList.add('hidden');
    });
  } catch (e) {
    container.innerHTML = renderEmptyState(t('読み込みエラー'), '😵');
  }
}

// ============================================================
// ============================================================
// フォロワー・フォロー中一覧
// ============================================================
export async function renderFollowersPage(params: PageParams = {}): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser) { window.location.hash = '#/login'; return; }
  const targetUid = params?.uid || currentUser.uid;
  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="user-list-page">
      <div class="page-header">
        <button class="btn btn-secondary btn-back" onclick="history.back()">${t('戻る')}</button>
        <h2 class="page-title">${t('フォロワー')}</h2>
      </div>
      <div id="user-list-content">${renderLoadingSpinner()}</div>
    </div>
  `;
  try {
    const users = await getFollowers(targetUid);
    const list = document.getElementById('user-list-content');
    if (users.length === 0) {
      list.innerHTML = renderEmptyState(t('フォロワーはいません'), '👤');
      return;
    }
    let html = '';
    for (const u of users) {
      const status = u.uid === currentUser.uid ? 'none' : await getFriendshipStatus(currentUser.uid, u.uid);
      html += renderUserListItem(toRenderProfile(u) || { uid: u.uid, displayName: 'User', username: '' }, currentUser.uid, { showFollowBtn: true, friendshipStatus: toFriendshipStatus(status) });
    }
    list.innerHTML = html;
    setupUserListActions(list);
  } catch (e) {
    document.getElementById('user-list-content').innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

export async function renderFollowingPage(params: PageParams = {}): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser) { window.location.hash = '#/login'; return; }
  const targetUid = params?.uid || currentUser.uid;
  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="user-list-page">
      <div class="page-header">
        <button class="btn btn-secondary btn-back" onclick="history.back()">${t('戻る')}</button>
        <h2 class="page-title">${t('フォロー中')}</h2>
      </div>
      <div id="user-list-content">${renderLoadingSpinner()}</div>
    </div>
  `;
  try {
    const users = await getFollowing(targetUid);
    const list = document.getElementById('user-list-content');
    if (users.length === 0) {
      list.innerHTML = renderEmptyState(t('フォロー中はいません'), '👤');
      return;
    }
    let html = '';
    for (const u of users) {
      const status = u.uid === currentUser.uid ? 'none' : await getFriendshipStatus(currentUser.uid, u.uid);
      html += renderUserListItem(toRenderProfile(u) || { uid: u.uid, displayName: 'User', username: '' }, currentUser.uid, { showFollowBtn: true, friendshipStatus: toFriendshipStatus(status) });
    }
    list.innerHTML = html;
    setupUserListActions(list);
  } catch (e) {
    document.getElementById('user-list-content').innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

function setupUserListActions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>('[data-action="add-friend"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.uid;
      const currentUser = getState('user');
      if (!currentUser || !uid) return;
      await sendFriendRequest(currentUser.uid, uid);
      btn.textContent = t('リクエスト済み');
      if (!btn) return;
      btn.disabled = true;
    });
  });
    container.querySelectorAll<HTMLButtonElement>('[data-action="accept-friend"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const uid = btn.dataset.uid;
          const currentUser = getState('user');
          if (!currentUser || !uid) return;
          await acceptFriendRequest(currentUser.uid, uid);
          btn.textContent = t('友達');
          if (!btn) return;
      btn.disabled = true;
        } catch (e) {
          console.error('accept error:', e);
        }
      });
    });
  container.querySelectorAll<HTMLButtonElement>('[data-action="remove-friend"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('友達を解除しますか？'))) return;
      const uid = btn.dataset.uid;
      const currentUser = getState('user');
      if (!currentUser || !uid) return;
      await removeFriend(currentUser.uid, uid);
      btn.textContent = t('解除しました');
      if (!btn) return;
      btn.disabled = true;
    });
  });
}

// ============================================================
// 友達一覧（フォロワー＋フォロー中を統合）
// ============================================================
export async function renderFriendsListPage(params: PageParams = {}): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser) { window.location.hash = '#/login'; return; }
  const targetUid = params?.uid || currentUser.uid;
  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="user-list-page">
      <div class="page-header">
        <button class="btn btn-secondary btn-back" onclick="history.back()">${t('戻る')}</button>
        <h2 class="page-title">${t('友達')}</h2>
      </div>
      <div id="user-list-content">${renderLoadingSpinner()}</div>
    </div>
  `;
  try {
    const [followers, following] = await Promise.all([getFollowers(targetUid), getFollowing(targetUid)]);
    const seen = new Set<string>();
    const allUsers: DbUser[] = [];
    for (const u of [...followers, ...following]) {
      if (!seen.has(u.uid)) { seen.add(u.uid); allUsers.push(u); }
    }
    const list = document.getElementById('user-list-content');
    if (allUsers.length === 0) {
      list.innerHTML = renderEmptyState(t('友達はいません'), '👤');
      return;
    }
    let html = '';
    for (const u of allUsers) {
      const status = u.uid === currentUser.uid ? 'none' : await getFriendshipStatus(currentUser.uid, u.uid);
      html += renderUserListItem(toRenderProfile(u) || { uid: u.uid, displayName: 'User', username: '' }, currentUser.uid, { showFollowBtn: true, friendshipStatus: toFriendshipStatus(status) });
    }
    list.innerHTML = html;
    setupUserListActions(list);
  } catch (e) {
    document.getElementById('user-list-content').innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

// ============================================================
// ============================================================













