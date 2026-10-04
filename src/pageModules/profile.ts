import { buildExploreRouteHash } from '../exploreRouteState.ts';
import { getState, setState } from '../state.ts';
import { attachmentDisplayURL } from '../attachments.ts';
import { escapeHtml, formatTime, formatRelativeTime, getFirebaseErrorMessage, isIndexError, getFirestoreIndexUrl, normalizeProfileBio } from '../utils.ts';
import { t } from '../i18n.ts';
import { resolveAvatarURL } from '../avatar.ts';
import { disablePushNotifications, enablePushNotifications, getPushStatus, type PushStatus } from '../pushNotifications.ts';
import { APP_ICON_PATH } from '../config.ts';
import {
  loginWithEmail, registerWithEmail,
  sendResetPasswordEmail, verifyResetPasswordCode, confirmResetPassword,
  logout,
} from '../auth.ts';
import {
  getUserProfile, getDisplayUserProfile, getLatestProfileProjection, getPostViewerStates, enrichCommentRecords, updateUserProfile, uploadProfileImage, createUserProfile, prefetchPostMediaURL,
  getFeedPosts, getUserPosts, getPostById, getPostsByIds, createPost, createQuotePost, updatePost, deletePost,
  toggleLike, hasLiked, getComments, addComment,
  searchUsers, getAllUsers,
  getUserFriends, getUserFriendIds, getUserFriendCount, sendFriendRequest, acceptFriendRequest,
  removeFriend, getFriendshipStatus, getPendingRequests,
  getNotifications, getUnreadNotificationCount,
  markNotificationRead, markAllNotificationsRead,
  getTrendingPosts,
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
import { auth, db } from '../firebase.ts';
import { doc, getDoc, collection, updateDoc, serverTimestamp } from 'firebase/firestore';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import type { AuthUser, Post, TimestampLike, UserProfile } from '../types/domain.ts';
import { openProfileAskAiDialog, setupAiPreferenceSettings } from '../askAi.ts';
import { getPostContentKind, type PostContentKind } from '../contentKinds.ts';
import {
  applyLocalViewedStories,
  decorateStoryAvatars,
  deletePostDraft,
  openImageViewer,
  openStoryViewer,
  readPostDrafts,
  setupPostEventListeners,
  showAppToast,
} from './home.ts';


type ProfilePageParams = { uid?: string; username?: string };
type DbPost = NonNullable<Awaited<ReturnType<typeof getPostById>>>;
type DbComment = Awaited<ReturnType<typeof getComments>>[number];
type DbUser = Awaited<ReturnType<typeof getAllUsers>>[number];
type RenderProfile = Parameters<typeof createAvatarHTML>[0];
type RenderPostInput = Parameters<typeof renderPostCard>[0];
type RenderCommentInput = Parameters<typeof renderComment>[0];
type ProfileEnrichedPost = DbPost & {
  id: string;
  userId: string;
  author: RenderProfile | null;
  liked: boolean;
  bookmarked?: boolean;
  reposted: boolean;
  userComments?: DbComment[];
  isPinnedProfilePost?: boolean;
  isRepost?: boolean;
  originalUserId?: string;
};
type ProfileEnrichedComment = DbComment & {
  id: string;
  postId: string;
  userId: string;
  text: string;
  author: RenderProfile | null;
  liked: boolean;
  likesCount: number;
};
type ProfileMediaItem = {
  type: 'image' | 'video';
  contentKind: PostContentKind;
  url: string;
  displayUrl?: string;
  postId: string;
  index: number;
  text: string;
  createdAt?: unknown;
};
type PostDraft = {
  id: string;
  text?: string;
  visibility?: string;
  scheduledAt?: string;
  updatedAt?: string | number | Date;
  imageNames?: string[];
  videoName?: string;
};
type NotificationSettings = Record<string, boolean | undefined>;
type EditableProfile = { displayName?: string; username?: string; bio?: string; photoURL?: string; coverURL?: string; pinnedPostId?: string };

type ToastType = Parameters<typeof showAppToast>[1];

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

function timestampMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value) || 0;
  const timestamp = toTimestampLike(value);
  return timestamp && typeof timestamp === 'object' && 'toDate' in timestamp ? timestamp.toDate().getTime() : 0;
}

function toRenderProfile(profile: DbUser | UserProfile | null | undefined): RenderProfile | null {
  if (!profile?.uid) return null;
  const profileImage = profile.profileImage || '';
  const profilePhotoPreviewURL = profile.profilePhotoPreviewURL || '';
  return {
    uid: profile.uid,
    displayName: profile.displayName || 'User',
    username: profile.username || '',
    photoURL: profile.photoURL || profileImage,
    profileImage,
    profilePhotoPreviewURL,
    avatarColor: profile.avatarColor || '',
  };
}

function toRenderPost(post: DbPost | ProfileEnrichedPost): RenderPostInput {
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

function toRenderComment(comment: ProfileEnrichedComment): RenderCommentInput {
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

function getElementById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function closeModalById(id: string): void {
  document.getElementById(id)?.remove();
}

function setupProfileAskAiAndSearch(profileId: string, username: string): void {
  const askButton = getElementById<HTMLButtonElement>('btn-profile-ask-ai');
  askButton?.addEventListener('click', (event) => {
    event.preventDefault();
    const content = getElementById<HTMLElement>('profile-content');
    const contextPostIds = Array.from(content?.querySelectorAll<HTMLElement>('.post-card[data-post-id][data-author-id][data-visibility="public"]') || [])
      .filter((card) => card.dataset.authorId === profileId)
      .map((card) => card.dataset.postId || '')
      .filter((postId) => /^[A-Za-z0-9_-]{1,160}$/.test(postId))
      .slice(0, 12);
    void openProfileAskAiDialog(profileId, contextPostIds);
  });
  const searchToggle = getElementById<HTMLButtonElement>('btn-profile-search');
  searchToggle?.addEventListener('click', (event) => {
    event.preventDefault();
    window.location.hash = buildExploreRouteHash(`@${username.replace(/^@/, '')} `, 'posts', profileId);
  });
}
const MB = 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 15 * MB;
const MAX_VIDEO_UPLOAD_BYTES = 3 * 1024 * MB;
const MAX_VIDEO_UPLOAD_SECONDS = 180;
const MAX_POST_IMAGE_COUNT = 20;
const MAX_OTHER_UPLOAD_BYTES = 10 * MB;
let homeStoryGroupsCache: unknown[] = [];

function validateUploadFile(file: File | null | undefined, inputEl: HTMLInputElement | null = null): boolean {
  if (!file) return false;
  const isVideo = file.type.startsWith('video/');
  const isImage = file.type.startsWith('image/');
  const limit = isVideo ? MAX_VIDEO_UPLOAD_BYTES : (isImage ? MAX_IMAGE_UPLOAD_BYTES : MAX_OTHER_UPLOAD_BYTES);
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

async function enrichPosts(posts: DbPost[], currentUserId = ''): Promise<ProfileEnrichedPost[]> {
  const states = currentUserId
    ? await getPostViewerStates(posts.map(post => post.id), currentUserId).catch(() => ({ liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() }))
    : { liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() };
  // Posts retain only the immutable owner ID as authoritative identity. The
  // author fields on old documents are creation-time snapshots and are used
  // only if the current profile no longer exists.
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
  return posts.map((post): ProfileEnrichedPost => {
    const userId = post.userId || '';
    // Never use the post's creation-time author snapshot for display.
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
async function enrichComments(comments: DbComment[], currentUserId = ''): Promise<ProfileEnrichedComment[]> {
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

function renderCommentThread(comments: ProfileEnrichedComment[]): string {
  if (!comments.length) return '';

  const childrenByParent = new Map<string, ProfileEnrichedComment[]>();
  const topLevel: ProfileEnrichedComment[] = [];
  comments.forEach(comment => {
    if (comment.parentId) {
      const replies = childrenByParent.get(comment.parentId) || [];
      replies.push(comment);
      childrenByParent.set(comment.parentId, replies);
    } else {
      topLevel.push(comment);
    }
  });

  const renderNode = (comment: ProfileEnrichedComment, depth = 0): string => {
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

export async function renderProfilePage(params: ProfilePageParams = {}): Promise<void> {
  const routeHash = window.location.hash;
  const currentUser = getState('user');

  const targetUid = params?.uid || currentUser?.uid;
  if (!targetUid) { window.location.hash = '#/login'; return; }
  const profile = await getDisplayUserProfile(targetUid).catch((): null => null);
  if (window.location.hash !== routeHash) return;
  if (!profile) {
    window.location.hash = '#/notifications';
    return;
  }

  const isOwnProfile = !!currentUser && targetUid === currentUser.uid;
  const displayName = escapeHtml(profile.displayName || 'User');
  const username = escapeHtml(profile.username || 'user');
  const bio = escapeHtml(normalizeProfileBio(profile.bio));
  const photoURL = resolveAvatarURL(profile);
  const coverURL = profile.coverURL || profile.coverPhotoPreviewURL || profile.coverImage || '';
  const color = profile.avatarColor || '#6366f1';
  const [friendsCount, postCount] = await Promise.all([getUserFriendCount(targetUid), getUserPostCount(targetUid)]);
  if (window.location.hash !== routeHash) return;
  const profileStoryGroup = currentUser ? applyLocalViewedStories(
    [await getUserStoryGroup(targetUid, currentUser.uid).catch((): null => null)],
    currentUser.uid,
  )[0] || null : null;
  if (window.location.hash !== routeHash) return;
  const profileStoryBtnHTML = profileStoryGroup?.hasUnseen
    ? `<button class="btn btn-secondary profile-story-open" id="btn-profile-story" data-author-id="${targetUid}">${t('ストーリーを見る')}</button>`
    : '';
  let friendshipStatus = 'none';
  let friendBtnHTML = '';
  if (!isOwnProfile && currentUser?.uid) {
    friendshipStatus = await getFriendshipStatus(currentUser.uid, targetUid);
    switch (friendshipStatus) {
      case 'none':
        friendBtnHTML = `<button class="btn btn-primary" id="btn-add-friend">${t('友達追加')}</button>`;
        break;
      case 'pending_sent':
        friendBtnHTML = `<button class="btn btn-secondary" disabled>${t('リクエスト送信済み')}</button>`;
        break;
      case 'pending_received':
        friendBtnHTML = `<button class="btn btn-primary" id="btn-accept-friend">${t('リクエストを承認')}</button>`;
        break;
      case 'friends':
        friendBtnHTML = `<button class="btn btn-secondary" id="btn-remove-friend">${t('友達を解除')}</button>`;
        break;
    }
  } else if (isOwnProfile) {
    friendBtnHTML = `<button class="btn btn-secondary" id="btn-edit-profile">${t('プロフィール編集')}</button>`;
  } else {
    friendBtnHTML = `<a class="btn btn-primary" href="#/login">${t('ログインして友達追加')}</a>`;
  }
  if (window.location.hash !== routeHash) return;

  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="profile-page">
      <div class="profile-cover ${coverURL ? 'profile-media-clickable' : ''}" ${coverURL ? `data-profile-media="${escapeHtml(coverURL)}" role="button" tabindex="0" aria-label="${t('カバー画像を拡大')}"` : ''} style="background: ${coverURL ? `url(${escapeHtml(coverURL)}) center/cover` : `linear-gradient(135deg, ${color}, ${color}88)`}">
      </div>
      <div class="profile-info">
        <div class="profile-avatar-wrapper">
          ${createAvatarHTML(profile as unknown as Partial<UserProfile>, 104, { imageClassName: 'profile-avatar-img', fallbackClassName: 'profile-avatar-fallback', mediaClickable: Boolean(photoURL), mediaLabel: t('プロフィール画像を拡大') })}
        </div>

        <div class="profile-details">
          <div class="profile-title-row">
            <h1 class="profile-name">${displayName}</h1>
            <div class="profile-header-tools" aria-label="プロフィール操作">
              <button type="button" class="btn btn-secondary profile-ask-ai-btn" id="btn-profile-ask-ai" data-profile-id="${escapeHtml(targetUid)}"><span aria-hidden="true">✦</span> Ask AI</button>
              <button type="button" class="profile-search-toggle" id="btn-profile-search" aria-label="探す画面で投稿を検索">⌕</button>
            </div>
          </div>
          <p class="profile-username">@${username}</p>
          <p class="profile-bio${bio ? '' : ' profile-bio-empty'}">${bio || t('自己紹介はまだありません')}</p>
          <div class="profile-stats">
            <div class="profile-stat">
              <span class="profile-stat-count">${postCount}</span>
              <span class="profile-stat-label">${t('件のポスト')}</span>
            </div>
            <a href="#/profile/${targetUid}/friends" class="profile-stat-link" data-navigate>
              <span class="profile-stat-count">${friendsCount}</span>
              <span class="profile-stat-label">${t('人の友達')}</span>
            </a>
          </div>
          <div class="profile-actions">
            ${profileStoryBtnHTML}
            ${friendBtnHTML}
          </div>
        </div>
      </div>


      <div class="profile-tabs ${isOwnProfile ? 'profile-tabs-five' : 'profile-tabs-four'}">
        <button class="profile-tab active" data-tab="posts">${t('投稿')}</button>
        <button class="profile-tab" data-tab="replies">${t('返信')}</button>
        <button class="profile-tab" data-tab="likes">${t('いいね')}</button>
        ${isOwnProfile ? `<button class="profile-tab" data-tab="bookmarks">${t('ブックマーク')}</button>` : ''}
        <button class="profile-tab" data-tab="media">${t('メディア')}</button>
      </div>

      <div class="profile-content" id="profile-content">
        ${renderLoadingSpinner()}
      </div>
    </div>
  `;

  await loadProfilePosts(targetUid);
  setupProfileAskAiAndSearch(targetUid, profile.username || targetUid);
  if (isOwnProfile) {

  }

  container.querySelectorAll<HTMLElement>('[data-profile-media]').forEach(el => {
    const open = () => {
      const url = el.getAttribute('data-profile-media');
      if (url) openImageViewer([url], 0);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });

  const tabs = container.querySelectorAll<HTMLButtonElement>('.profile-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', async () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const content = document.getElementById('profile-content');
      if (tab.dataset.tab === 'posts') {
        await loadProfilePosts(targetUid);
      } else if (tab.dataset.tab === 'replies') {
        await loadProfileReplies(targetUid);
      } else if (tab.dataset.tab === 'likes') {
        await loadProfileLikes(targetUid);
      } else if (tab.dataset.tab === 'bookmarks') {
        await loadProfileBookmarks(targetUid);
      } else if (tab.dataset.tab === 'media') {
        await loadProfileMedia(targetUid);
      }
    });
  });

  const addBtn = getElementById<HTMLButtonElement>('btn-add-friend');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      await sendFriendRequest(currentUser.uid, targetUid);
      addBtn.textContent = t('リクエスト送信済み');
      addBtn.disabled = true;
    });
  }

  const acceptBtn = getElementById<HTMLButtonElement>('btn-accept-friend');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', async () => {
      try {
        await acceptFriendRequest(currentUser.uid, targetUid);
        acceptBtn.textContent = t('友達になりました！');
        acceptBtn.disabled = true;
      } catch (e) {
        console.error('accept error:', e);
      }
    });
  }

  const removeBtn = getElementById<HTMLButtonElement>('btn-remove-friend');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!confirm(t('友達を解除しますか？'))) return;
      await removeFriend(currentUser.uid, targetUid);
      removeBtn.textContent = t('解除しました');
      removeBtn.disabled = true;
    });
  }

  const editBtn = getElementById<HTMLButtonElement>('btn-edit-profile');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      openEditProfileModal(profile);
    });
  }

  document.getElementById('btn-profile-story')?.addEventListener('click', () => {
    openStoryViewer(targetUid, profileStoryGroup ? [profileStoryGroup] : null);
  });

}

async function renderPinnedPostSection(uid: string, profile: (DbUser & { pinnedPostId?: string }) | null, isOwnProfile: boolean): Promise<void> {
  const box = document.getElementById('profile-pinned-section');
  if (!box) return;
  const pinnedPostId = typeof profile?.pinnedPostId === 'string' ? profile.pinnedPostId : '';
  if (!pinnedPostId) {
    box.innerHTML = isOwnProfile ? `<div class="profile-pinned-empty">📌 ${t('固定したい投稿の「固定」を押すと、ここに表示されます')}</div>` : '';
    return;
  }
  try {
    const post = await getPostById(pinnedPostId);
    if (!post) {
      box.innerHTML = isOwnProfile ? `<div class="profile-pinned-empty">${t('固定投稿が見つかりません')}</div>` : '';
      return;
    }
    const enriched = (await enrichPosts([{ ...post, isPinnedProfilePost: true }], getState('user')?.uid))[0];
    box.innerHTML = `<div class="profile-pinned-label">📌 ${t('固定ポスト')}</div>${renderPostCard(toRenderPost(enriched), enriched.author, enriched.liked, enriched.reposted)}`;
    setupPostEventListeners(box);
    if (isOwnProfile) addProfilePinButtons(box, uid, pinnedPostId);
  } catch (e) {
    box.innerHTML = '';
  }
}

function addProfilePinButtons(container: HTMLElement, profileUid: string, pinnedPostId = ''): void {
  const currentUser = getState('user');
  if (!currentUser || currentUser.uid !== profileUid || !container) return;
  container.querySelectorAll<HTMLElement>('.post-card').forEach(card => {
    const postId = card.dataset.postId;
    const header = card.querySelector('.post-header');
    if (!postId || !header || header.querySelector('[data-action="pin-post"]')) return;
    const isPinned = postId === pinnedPostId;
    header.insertAdjacentHTML('beforeend', `<button class="post-pin-btn ${isPinned ? 'pinned' : ''}" data-action="pin-post" data-post-id="${escapeHtml(postId)}" title="${isPinned ? t('固定解除') : t('固定')}">${isPinned ? '📌' : '📍'}</button>`);
  });
  container.querySelectorAll<HTMLButtonElement>('[data-action="pin-post"]').forEach(btn => {
    btn.addEventListener('click', async (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const postId = btn.dataset.postId;
      const isPinned = btn.classList.contains('pinned');
      btn.disabled = true;
      try {
        await updateUserProfile(profileUid, { pinnedPostId: isPinned ? '' : postId });
        const profile = await getDisplayUserProfile(profileUid);
        await renderPinnedPostSection(profileUid, profile, true);
        await loadProfilePosts(profileUid);
        showAppToast(isPinned ? t('固定を解除しました') : t('投稿を固定しました'), 'success');
      } catch (e) {
        showAppToast(t('固定の更新に失敗しました'), 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

export async function renderBookmarksPage() {
  const currentUser = getState('user');
  if (!currentUser) {
    window.location.hash = '#/login';
    return;
  }
  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="page-container narrow-page settings-page bookmarks-page">
      <div class="settings-hero drafts-hero">
        <div>
          <h1>${t('ブックマーク')}</h1>
          <p class="page-subtitle">${t('保存した投稿は自分だけが見られます')}</p>
        </div>
        <a class="btn btn-secondary" href="#/feed">${t('ホームへ')}</a>
      </div>
      <section class="settings-section">
        <div class="settings-section-header"><h2>${t('保存済み投稿')}</h2><p>${t('投稿者には通知されません')}</p></div>
        <div id="bookmark-posts" class="hashtag-posts">${renderLoadingSpinner()}</div>
      </section>
    </div>
  `;
  const list = document.getElementById('bookmark-posts');
  try {
    const bookmarks = await getUserBookmarks(currentUser.uid, 50);
    const posts = await getPostsByIds(bookmarks.map(bookmark => bookmark.postId)).catch((): DbPost[] => []);
    if (!posts.length) {
      list.innerHTML = renderEmptyState(t('保存した投稿はまだありません'), '🔖');
      return;
    }
    const enriched = await enrichPosts(posts, currentUser.uid);
    list.innerHTML = enriched.map(post => renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted)).join('');
    setupPostEventListeners(list);
    decorateStoryAvatars(list);
  } catch (error) {
    list.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}
export async function renderDraftsPage() {
  const currentUser = getState('user');
  if (!currentUser) {
    window.location.hash = '#/login';
    return;
  }
  const drafts = readPostDrafts(currentUser.uid) as PostDraft[];
  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="page-container narrow-page settings-page drafts-page">
      <div class="settings-hero drafts-hero">
        <div>
          <h1>${t('下書き')}</h1>
          <p class="page-subtitle">${t('投稿前の内容をここから再開できます')}</p>
        </div>
        <a class="btn btn-secondary" href="#/feed">${t('ホームへ')}</a>
      </div>
      ${drafts.length === 0 ? renderEmptyState(t('下書きはありません'), '📝') : `
        <section class="settings-section draft-section">
          <div class="settings-section-header">
            <h2>${t('保存中の下書き')}</h2>
            <p>${drafts.length}${t('件の下書きがあります')}</p>
          </div>
          <div class="draft-list">
            ${drafts.map(draft => {
              const visibilityLabel = draft.visibility === 'friends' ? t('友達のみ') : draft.visibility === 'private' ? t('自分のみ') : t('全体公開');
              const files = [...(draft.imageNames || []), draft.videoName].filter(Boolean);
              const text = (draft.text || '').trim() || t('メディアのみの下書き');
              return `
                <article class="settings-row draft-row" data-draft-id="${escapeHtml(draft.id)}">
                  <div class="draft-card-main">
                    <strong>${escapeHtml(text)}</strong>
                    <div class="draft-meta-row">
                      <span class="draft-chip">${visibilityLabel}</span>
                      ${draft.scheduledAt ? `<span class="draft-chip">${t('予約')}: ${escapeHtml(new Date(draft.scheduledAt).toLocaleString())}</span>` : ''}
                      <span>${t('更新')}: ${formatRelativeTime(new Date(draft.updatedAt || Date.now()))}</span>
                    </div>
                    ${files.length ? `<small>${t('添付ファイル')}: ${escapeHtml(files.join(', '))}</small>` : ''}
                  </div>
                  <div class="draft-actions">
                    <button class="btn btn-primary" data-action="resume-draft">${t('再開')}</button>
                    <button class="btn btn-secondary" data-action="delete-draft">${t('削除')}</button>
                  </div>
                </article>
              `;
            }).join('')}
          </div>
        </section>
      `}
    </div>
  `;
  container.querySelectorAll<HTMLElement>('[data-action="resume-draft"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = btn.closest<HTMLElement>('[data-draft-id]');
      const id = row?.dataset.draftId;
      if (id) window.location.hash = `#/feed?draft=${encodeURIComponent(id)}`;
    });
  });
  container.querySelectorAll<HTMLElement>('[data-action="delete-draft"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest<HTMLElement>('[data-draft-id]');
      const id = row?.dataset.draftId;
      if (!id || !confirm(t('この下書きを削除しますか？'))) return;
      deletePostDraft(currentUser.uid, id);
      await renderDraftsPage();
    });
  });
}

export async function renderSettingsPage() {
  const routeHash = window.location.hash;
  const currentUser = getState('user');
  if (!currentUser) {
    window.location.hash = '#/login';
    return;
  }
  const profile = getState('userProfile') || await getUserProfile(currentUser.uid);
  if (window.location.hash !== routeHash) return;
  const defaultVisibility = localStorage.getItem(`connect_default_visibility_${currentUser.uid}`) || 'public';
  const notificationSettings = JSON.parse(localStorage.getItem(`connect_notification_settings_${currentUser.uid}`) || '{}') as NotificationSettings;
  const notificationRows: Array<[string, string]> = [
    ['reply', t('返信通知')],
    ['like', t('いいね通知')],
    ['mention', t('メンション通知')],
    ['friend', t('友達申請通知')],
    ['friendPost', t('友達の投稿通知')],
    ['thread', t('スレッド参加通知')],
  ];
  const container = document.getElementById('page-content');
  container.innerHTML = `
    <div class="page-container narrow-page settings-page">
      <div class="settings-hero">
        <div>
          <h1>${t('設定')}</h1>
          <p class="page-subtitle">${t('アカウントと使い方をまとめて管理します')}</p>
        </div>
      </div>
      <section class="settings-section">
        <div class="settings-section-header">
          <h2>${t('アカウント')}</h2>
          <p>${t('プロフィール、下書き、ログイン状態を管理します')}</p>
        </div>
        <button class="settings-row" id="settings-edit-profile"><span>${t('プロフィール編集')}</span><strong>›</strong></button>
        <a class="settings-row" href="#/drafts"><span>${t('下書き')}</span><strong>›</strong></a>
        <a class="settings-row" href="#/bookmarks"><span>${t('ブックマーク')}</span><strong>›</strong></a>
        <button class="settings-row" id="settings-logout"><span>${t('ログアウト')}</span><strong aria-hidden="true">⇥</strong></button>
      </section>
      <section class="settings-section">
        <div class="settings-section-header">
          <h2>${t('通知設定')}</h2>
          <p>${t('必要な反応だけを受け取れるようにします')}</p>
        </div>
        <div class="settings-row settings-push-row">
            <span class="settings-push-copy">
            <strong>${t('この端末のPush通知')}</strong>
            <small id="settings-push-status" role="status" aria-live="polite">${t('通知状態を確認中…')}</small>
              <small id="settings-push-device-count" class="settings-push-device-count"></small>
          </span>
          <button type="button" class="btn btn-secondary btn-sm" id="settings-push-toggle" disabled aria-busy="true">${t('確認中…')}</button>
        </div>
        ${notificationRows.map(([key, label]) => `
          <label class="settings-row settings-toggle">
            <span>${label}</span>
            <input type="checkbox" data-notification-key="${key}" ${notificationSettings[key] !== false ? 'checked' : ''}>
          </label>
        `).join('')}
      </section>
      <section class="settings-section">
        <div class="settings-section-header">
          <h2>${t('プライバシー')}</h2>
          <p>${t('投稿の公開範囲と安全管理の入口です')}</p>
        </div>
        <label class="settings-row settings-select">
          <span>${t('投稿の標準公開範囲')}</span>
          <select id="settings-default-visibility">
            <option value="public">${t('全体公開')}</option>
            <option value="friends">${t('友達のみ')}</option>
            <option value="private">${t('自分のみ')}</option>
          </select>
        </label>
        <div class="settings-muted-box">${t('ブロック/ミュート一覧は今後の詳細管理に接続できる土台としてここに集約します。')}</div>
      </section>
      <section class="settings-section">
        <div class="settings-section-header">
          <h2>${t('表示')}</h2>
          <p>${t('画面の見た目を切り替えます')}</p>
        </div>
        <button class="settings-row" id="settings-theme"><span>${t('テーマ切替')}</span><strong>☾</strong></button>
      </section>
      <section class="settings-section" id="settings-ai-analysis" hidden>
        <div class="settings-section-header">
          <h2>AIによる投稿分析</h2>
          <p>投稿本文と画像を外部AIで分析してよい範囲を設定します。友達限定・非公開の投稿は、投稿編集画面で投稿ごとの許可も必要です。</p>
        </div>
        <label class="settings-row settings-select">
          <span>投稿本文のAI分析</span>
          <select id="settings-ai-text"><option value="DISABLED">許可しない</option><option value="PUBLIC_ONLY">公開投稿のみ</option><option value="AUTHORIZED_CONTEXT">閲覧を許可した投稿</option></select>
        </label>
        <label class="settings-row settings-select">
          <span>投稿画像のAI分析</span>
          <select id="settings-ai-media"><option value="DISABLED">許可しない</option><option value="PUBLIC_ONLY">公開投稿のみ</option><option value="AUTHORIZED_CONTEXT">閲覧を許可した投稿</option></select>
        </label>
        <div class="settings-muted-box">画像に写る第三者の同意や、画像内の個人情報を送信前に完全検知できるものではありません。</div>
        <p class="settings-ai-state" data-ai-preference-state>AI設定を確認中...</p>
        <button type="button" class="btn btn-primary" id="settings-ai-save">AI設定を保存</button>
        <div class="settings-muted-box" data-ai-admin-tools hidden>
          <strong>Production admin verification</strong>
          <p>Migration integrityとOpenRouter policy smokeを確認します。predeployはこの画面につき1回だけ開始し、Workerは429を検知するとcircuit-openしてchainを停止します。Retry-Afterまたは十分なcooldown後の次回確認まで追加requestは行いません。</p>
          <div class="settings-actions">
            <button type="button" class="btn btn-secondary" id="settings-ai-integrity">Migration verify</button>
            <button type="button" class="btn btn-secondary" id="settings-ai-predeploy">OpenRouter predeploy（1回）</button>
          </div>
          <pre class="settings-ai-state" data-ai-admin-state>未実行</pre>
        </div>
      </section>
      <section class="settings-section account-delete-section">
        <button class="settings-row account-delete-row" id="settings-delete-account" disabled>
          <span class="account-delete-title">${t('アカウント削除')}</span>
          <small>${t('※安全確認フロー準備中')}</small>
        </button>
      </section>
    </div>
  `;
  void auth.currentUser?.getIdTokenResult(true).then((tokenResult) => {
    if (tokenResult.claims.role !== 'admin' || getState('user')?.uid !== currentUser.uid) return;
    const accountSection = container.querySelector<HTMLElement>('.settings-page .settings-section');
    if (!accountSection || accountSection.querySelector('[data-admin-moderation-link]')) return;
    accountSection.insertAdjacentHTML('beforeend', '<a class="settings-row" href="#/admin/moderation" data-navigate data-admin-moderation-link><span>投稿モデレーション（管理者）</span><strong>›</strong></a>');
  }).catch(() => {});
  const vis = getElementById<HTMLSelectElement>('settings-default-visibility');
  if (vis) vis.value = defaultVisibility;
  vis?.addEventListener('change', () => {
    localStorage.setItem(`connect_default_visibility_${currentUser.uid}`, vis.value);
    showAppToast(t('公開範囲の初期値を保存しました'), 'success');
  });
  container.querySelectorAll<HTMLInputElement>('[data-notification-key]').forEach(input => {
    input.addEventListener('change', () => {
      const next = JSON.parse(localStorage.getItem(`connect_notification_settings_${currentUser.uid}`) || '{}');
      const key = input.dataset.notificationKey;
      if (key) next[key] = input.checked;
      localStorage.setItem(`connect_notification_settings_${currentUser.uid}`, JSON.stringify(next));
    });
  });
  const pushButton = document.getElementById('settings-push-toggle') as HTMLButtonElement | null;
  const pushStatusText = document.getElementById('settings-push-status');
  const pushDeviceCountText = document.getElementById('settings-push-device-count');
  const renderPushStatus = (status: PushStatus): void => {
    if (pushStatusText) {
      pushStatusText.textContent = status.message;
    }
    if (pushDeviceCountText) {
      pushDeviceCountText.textContent = typeof status.deviceCount === 'number'
        ? t('登録端末数: {count}台').replace('{count}', String(status.deviceCount))
        : '';
    }
    if (pushButton) {
      const canRetry = status.code === 'error';
      pushButton.textContent = canRetry ? t('再確認') : status.code === 'subscribed' ? t('OFFにする') : t('ONにする');
      pushButton.dataset.pushAction = canRetry ? 'retry' : 'toggle';
      pushButton.disabled = !canRetry && ['unsupported', 'ios-install-required', 'unconfigured', 'authentication-required', 'denied'].includes(status.code);
      pushButton.setAttribute('aria-busy', 'false');
      pushButton.dataset.pushEnabled = status.code === 'subscribed' ? 'true' : 'false';
    }
  };
  getPushStatus().then(renderPushStatus).catch(() => renderPushStatus({
    code: 'error',
    permission: 'unsupported',
    subscription: 'unknown',
    message: t('通知状態を確認できませんでした'),
  }));
  pushButton?.addEventListener('click', async () => {
    const retryStatus = pushButton.dataset.pushAction === 'retry';
    pushButton.disabled = true;
    pushButton.setAttribute('aria-busy', 'true');
    pushButton.textContent = retryStatus ? t('確認中…') : t('処理中…');
    try {
      if (retryStatus) {
        renderPushStatus(await getPushStatus());
        return;
      }
      const next = pushButton.dataset.pushEnabled === 'true'
        ? await disablePushNotifications()
        : await enablePushNotifications();
      renderPushStatus(next);
    } catch {
      renderPushStatus({
        code: 'error',
        permission: 'unsupported',
        subscription: 'unknown',
        message: t('Push通知の設定に失敗しました'),
      });
    } finally {
      if (pushButton.isConnected) pushButton.setAttribute('aria-busy', 'false');
    }
  });
  document.getElementById('settings-edit-profile')?.addEventListener('click', () => { if (profile) openEditProfileModal(profile); });
  void setupAiPreferenceSettings(container);
  document.getElementById('settings-theme')?.addEventListener('click', () => document.getElementById('theme-toggle-btn')?.click());
  document.getElementById('settings-logout')?.addEventListener('click', async () => {
    const button = document.getElementById('settings-logout') as HTMLButtonElement | null;
    if (!button || button.disabled || !window.confirm(t('ログアウトしますか？'))) return;
    button.disabled = true;
    try {
      await logout();
      window.location.hash = '#/login';
    } catch (error) {
      console.error('settings logout failed:', error);
      showAppToast(t('ログアウトに失敗しました。もう一度お試しください。'), 'error');
      button.disabled = false;
    }
  });
}

export async function renderUserMentionRedirectPage(params: ProfilePageParams = {}): Promise<void> {
  const currentUser = getState('user');
  if (!currentUser) {
    window.location.hash = '#/login';
    return;
  }
  const rawUsername = decodeURIComponent(params.username || '').replace(/^@/, '').trim().toLowerCase();
  const container = document.getElementById('page-content');
  container.innerHTML = `<div class="page-container narrow-page">${renderLoadingSpinner()}</div>`;
  if (!rawUsername) {
    container.innerHTML = renderEmptyState(t('ユーザーが見つかりません'), '👤');
    return;
  }
  try {
    const users = await getAllUsers();
    const user = users.find(item => String(item.username || '').replace(/^@/, '').toLowerCase() === rawUsername);
    if (user?.uid) {
      window.location.hash = `#/profile/${user.uid}`;
      return;
    }
    container.innerHTML = renderEmptyState(t('ユーザーが見つかりません'), '👤');
  } catch (e) {
    container.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

async function loadProfilePosts(uid: string): Promise<void> {
  const content = document.getElementById('profile-content');
  if (!content) return;
  content.innerHTML = renderLoadingSpinner();
  try {
    const viewerId = getState('user')?.uid || '';
    const { posts } = await getUserPosts(uid, viewerId, 'all');
    const repostedIds = await getRepostedPostIds(uid).catch((e): string[] => {
      console.warn('profile repost ids unavailable:', e);
      return [];
    });
    const repostedSourcePosts = await getPostsByIds(repostedIds.slice(0, 80)).catch((): DbPost[] => []);
    const repostedPosts = repostedSourcePosts
      .map((p): DbPost & { isRepost: boolean; originalUserId: string } => ({ ...p, isRepost: true, originalUserId: p.userId || '' }));
    const allPosts = [...posts, ...repostedPosts];
    allPosts.sort((a, b) => {
      const tA = timestampMillis(a.createdAt);
      const tB = timestampMillis(b.createdAt);
      return tB - tA;
    });
    const profile = await getDisplayUserProfile(uid).catch((): null => null);
    const pinnedPostId = typeof profile?.pinnedPostId === 'string' ? profile.pinnedPostId : '';
    const regularPosts = allPosts.filter(post => post.id !== pinnedPostId);
    const enriched = await enrichPosts(regularPosts, getState('user')?.uid);
    let pinnedEnriched: ProfileEnrichedPost | null = null;
    if (pinnedPostId) {
      const pinnedSource = allPosts.find(post => post.id === pinnedPostId) || await getPostById(pinnedPostId).catch((): null => null);
      if (pinnedSource) {
        pinnedEnriched = (await enrichPosts([{ ...pinnedSource, isPinnedProfilePost: true }], getState('user')?.uid))[0] || null;
      }
    }

    if (!pinnedEnriched && enriched.length === 0) {
      content.innerHTML = renderEmptyState(t('まだ投稿がありません'), '📝');
      return;
    }

    const renderProfilePost = (post: ProfileEnrichedPost, pinned = false): string => {
      const postHtml = renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted);
      if (!pinned) return postHtml;
      return postHtml.replace(/(<div class="post-card[^"]*"[^>]*>)/, '$1<div class="post-pinned-inline">📌 ' + t('固定') + '</div>');
    };
    let html = pinnedEnriched ? renderProfilePost(pinnedEnriched, true) : '';
    for (const post of enriched) {
      html += renderProfilePost(post, false);
    }
    content.innerHTML = html;
    addProfilePinButtons(content, uid, pinnedPostId);
    setupPostEventListeners(content);
    decorateStoryAvatars(content);
  } catch (e) {
    console.error('loadProfilePosts error:', e);
    content.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
    return;
  }
}

async function loadProfileReplies(uid: string): Promise<void> {
  const content = document.getElementById('profile-content');
  if (!content) return;
  content.innerHTML = renderLoadingSpinner();
  try {
    const commentsByPost = await getUserComments(uid);
    const postIds = Object.keys(commentsByPost);
    if (postIds.length === 0) {
      content.innerHTML = renderEmptyState(t('まだ返信がありません'), '💬');
      return;
    }
    const sourcePosts = await getPostsByIds(postIds).catch((): DbPost[] => []);
    const posts: DbPost[] = sourcePosts
      .filter(post => !!commentsByPost[post.id])
      .map(post => ({ ...post, userComments: commentsByPost[post.id] }));
    posts.sort((a, b) => {
      const tA = timestampMillis(a.createdAt);
      const tB = timestampMillis(b.createdAt);
      return tB - tA;
    });
    const enriched = await enrichPosts(posts, getState('user')?.uid);

    let html = '';
    for (const post of enriched) {
      html += `<div class="reply-context">💬 ${t('この投稿に返信')}</div>`;
      html += renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted);
      if (post.userComments) {
        for (const c of post.userComments) {
          html += `<div class="reply-preview">${escapeHtml(c.text)}</div>`;
        }
      }
    }
    content.innerHTML = html;
    setupPostEventListeners(content);
    decorateStoryAvatars(content);
  } catch (e) {
    console.error('loadProfileReplies error:', e);
    content.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

async function loadProfileLikes(uid: string): Promise<void> {
  const content = document.getElementById('profile-content');
  if (!content) return;
  content.innerHTML = renderLoadingSpinner();
  try {
    const viewerId = getState('user')?.uid || '';
    const likedPosts = await getUserLikedPosts(uid, viewerId, 80);
    if (!likedPosts.length) {
      content.innerHTML = renderEmptyState(t('まだ公開できるいいねはありません'), '♡');
      return;
    }
    const enriched = await enrichPosts(likedPosts, viewerId);
    content.innerHTML = enriched.map(post => renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted)).join('');
    setupPostEventListeners(content);
    decorateStoryAvatars(content);
  } catch (e) {
    console.error('loadProfileLikes error:', e);
    content.innerHTML = renderEmptyState(t('いいね一覧を読み込めませんでした'), '😵');
  }
}

async function loadProfileBookmarks(uid: string): Promise<void> {
  const content = document.getElementById('profile-content');
  const currentUser = getState('user');
  if (!content || !currentUser || currentUser.uid !== uid) return;
  content.innerHTML = renderLoadingSpinner();
  try {
    const bookmarks = await getUserBookmarks(currentUser.uid, 80);
    const posts = await getPostsByIds(bookmarks.map(bookmark => bookmark.postId)).catch((): DbPost[] => []);
    if (!posts.length) {
      content.innerHTML = renderEmptyState(t('保存した投稿はまだありません'), '🔖');
      return;
    }
    const enriched = await enrichPosts(posts, currentUser.uid);
    content.innerHTML = enriched.map(post => renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted)).join('');
    setupPostEventListeners(content);
    decorateStoryAvatars(content);
  } catch (e) {
    console.error('loadProfileBookmarks error:', e);
    content.innerHTML = renderEmptyState(t('ブックマークを読み込めませんでした'), '😵');
  }
}

async function loadProfileMedia(uid: string): Promise<void> {
  const content = document.getElementById('profile-content');
  if (!content) return;
  content.innerHTML = renderLoadingSpinner();
  try {
    const viewerId = getState('user')?.uid || '';
    const { posts } = await getUserPosts(uid, viewerId, 'all');
    const mediaItems: ProfileMediaItem[] = [];
    posts.forEach(post => {
      const contentKind = getPostContentKind(post);
      const attachmentImages = (post.attachments || [])
        .filter(attachment => attachment.kind === 'image' && attachment.url)
        .map((attachment, index) => ({ url: attachment.url, displayUrl: attachmentDisplayURL(attachment), index }));
      const legacyImages = post.imageURLs || (post.imageURL ? [post.imageURL] : []);
      const images = attachmentImages.length > 0
        ? [...attachmentImages, ...legacyImages.filter((url) => !attachmentImages.some((image) => image.url === url)).map((url, index) => ({ url, displayUrl: url, index: attachmentImages.length + index }))]
        : legacyImages.map((url, index) => ({ url, displayUrl: url, index }));
      images.forEach((image) => {
        mediaItems.push({ type: 'image', contentKind, url: image.url, displayUrl: image.displayUrl, postId: post.id, index: image.index, text: post.text || '', createdAt: post.createdAt });
      });
      if (post.videoURL) {
        mediaItems.push({ type: 'video', contentKind, url: post.videoURL, postId: post.id, index: 0, text: post.text || '', createdAt: post.createdAt });
      }
    });
    mediaItems.sort((a, b) => {
      const tA = timestampMillis(a.createdAt);
      const tB = timestampMillis(b.createdAt);
      return tB - tA;
    });
    if (mediaItems.length === 0) {
      content.innerHTML = renderEmptyState(t('メディア投稿がありません'), '📷');
      return;
    }
    const mediaKindLabels: Record<PostContentKind, string> = {
      user: t('ユーザー投稿'),
      news: t('ニュース'),
      advertisement: t('広告 / PR'),
      system: t('システム画面'),
      unclassified: t('分類未設定'),
    };
    const mediaGroups = (['user', 'news', 'advertisement', 'system', 'unclassified'] as const)
      .map(kind => ({ kind, items: mediaItems.filter(item => item.contentKind === kind) }))
      .filter(group => group.items.length > 0);
    content.innerHTML = mediaGroups.map(group => `
      <section class="profile-media-section" data-content-kind="${group.kind}" aria-label="${group.kind === 'unclassified' ? t('メディア投稿') : mediaKindLabels[group.kind]}">
        ${group.kind !== 'unclassified' ? `<h3 class="profile-media-section-title">${mediaKindLabels[group.kind]}</h3>` : ''}
        <div class="profile-media-grid">
          ${group.items.map((item) => `
            <a class="profile-media-tile" href="#/post/${encodeURIComponent(item.postId)}" data-navigate aria-label="${item.contentKind !== 'unclassified' ? `${mediaKindLabels[item.contentKind]}、` : ''}${item.type === 'video' ? t('動画投稿を開く') : t('画像投稿を開く')}">
              ${item.type === 'video'
                ? `<video data-profile-media-video="true" data-post-id="${escapeHtml(item.postId)}" data-media-kind="video" data-media-index="${item.index}" data-src="${escapeHtml(item.url)}" muted playsinline preload="none" aria-label="${t('動画投稿を開く')}"></video><span class="profile-media-video-fallback" role="status" hidden>▶</span><span class="profile-media-type" aria-hidden="true">▶</span>`
                : `<img src="${escapeHtml(item.displayUrl || item.url)}" alt="${escapeHtml(item.text || t('投稿メディア'))}" loading="lazy" decoding="async" data-post-media-image="true" data-post-id="${escapeHtml(item.postId)}" data-media-kind="image" data-media-index="${item.index}" data-media-source="${escapeHtml(item.displayUrl || item.url)}"><span class="profile-media-image-fallback" role="status" hidden>${t('画像を読み込めませんでした')}</span><span class="profile-media-type" aria-hidden="true">▣</span>`}
              ${item.contentKind !== 'user' && item.contentKind !== 'unclassified' ? `<span class="profile-media-kind-badge content-kind-${item.contentKind}">${mediaKindLabels[item.contentKind]}</span>` : ''}
            </a>
          `).join('')}
        </div>
      </section>
    `).join('');
    setupPostEventListeners(content);
    setupProfileMediaVideoThumbnails(content);
  } catch (e) {
    console.error('loadProfileMedia error:', e);
    content.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

let profileMediaVideoObserver: IntersectionObserver | null = null;
function setupProfileMediaVideoThumbnails(container: HTMLElement): void {
  profileMediaVideoObserver?.disconnect();
  const videos = Array.from(container.querySelectorAll<HTMLVideoElement>('video[data-profile-media-video="true"]'));
  const loadThumbnail = (video: HTMLVideoElement): void => {
    if (video.dataset.thumbnailLoadStarted === 'true') return;
    video.dataset.thumbnailLoadStarted = 'true';
    const postId = video.dataset.postId || '';
    const sourceURL = video.dataset.src || '';
    const mediaIndex = Number(video.dataset.mediaIndex || 0);
    const fallback = video.parentElement?.querySelector<HTMLElement>('.profile-media-video-fallback');
    const showFallback = (): void => {
      video.hidden = true;
      if (fallback) fallback.hidden = false;
    };
    if (!postId || !sourceURL) {
      showFallback();
      return;
    }
    void prefetchPostMediaURL(postId, sourceURL, 'video', mediaIndex).then((resolvedURL) => {
      if (!video.isConnected) return;
      video.muted = true;
      video.playsInline = true;
      video.controls = false;
      video.preload = 'metadata';
      video.addEventListener('error', showFallback, { once: true });
      video.addEventListener('loadedmetadata', () => {
        if (!video.isConnected) return;
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const frameTime = duration > 0.12 ? 0.12 : duration / 2;
        const showFrame = (): void => {
          video.pause();
          video.dataset.thumbnailReady = 'true';
          if (fallback) fallback.hidden = true;
        };
        if (frameTime <= 0.01) {
          video.addEventListener('loadeddata', showFrame, { once: true });
          return;
        }
        video.addEventListener('seeked', showFrame, { once: true });
        try { video.currentTime = frameTime; } catch { showFallback(); }
      }, { once: true });
      video.src = resolvedURL;
      video.load();
    }).catch(() => showFallback());
  };

  if (typeof IntersectionObserver === 'undefined') {
    videos.forEach(loadThumbnail);
    return;
  }
  profileMediaVideoObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const video = entry.target;
      if (!(video instanceof HTMLVideoElement)) return;
      profileMediaVideoObserver?.unobserve(video);
      loadThumbnail(video);
    });
  }, { rootMargin: '180px', threshold: 0.01 });
  videos.forEach(video => profileMediaVideoObserver?.observe(video));
}

function openProfileMediaViewer(items: ProfileMediaItem[], startIndex = 0): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const modalId = 'profile-media-viewer';
  closeModalById(modalId);
  let index = Math.max(0, Math.min(startIndex, items.length - 1));
  document.body.insertAdjacentHTML('beforeend', `
    <div class="image-lightbox profile-media-viewer" id="${modalId}" role="dialog" aria-modal="true">
      <button class="image-lightbox-close" id="profile-media-close" aria-label="${t('閉じる')}">&times;</button>
      <button class="image-lightbox-nav prev" id="profile-media-prev" aria-label="${t('前へ')}">‹</button>
      <div class="profile-media-stage" id="profile-media-stage"></div>
      <button class="image-lightbox-nav next" id="profile-media-next" aria-label="${t('次へ')}">›</button>
      <div class="image-lightbox-counter" id="profile-media-counter"></div>
    </div>
  `);
  const root = document.getElementById(modalId);
  const stage = document.getElementById('profile-media-stage');
  const counter = document.getElementById('profile-media-counter');
  const render = () => {
    const item = items[index];
    if (!stage || !item) return;
    stage.innerHTML = item.type === 'video'
      ? `<video src="${escapeHtml(item.url)}" controls autoplay playsinline></video>`
      : `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.text || t('投稿メディア'))}">`;
    if (counter) counter.textContent = `${index + 1}/${items.length}`;
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    root?.remove();
  };
  const move = (delta: number): void => {
    index = (index + delta + items.length) % items.length;
    render();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') move(-1);
    if (e.key === 'ArrowRight') move(1);
  };
  document.getElementById('profile-media-close')?.addEventListener('click', close);
  document.getElementById('profile-media-prev')?.addEventListener('click', () => move(-1));
  document.getElementById('profile-media-next')?.addEventListener('click', () => move(1));
  root?.addEventListener('click', (e) => { if (e.target === root) close(); });
  document.addEventListener('keydown', onKey);
  render();
}

async function loadProfileMediaLegacy(uid: string): Promise<void> {
  const content = document.getElementById('profile-content');
  if (!content) return;
  content.innerHTML = renderLoadingSpinner();
  try {
    const viewerId = getState('user')?.uid || '';
    const { posts } = await getUserPosts(uid, viewerId, 'all');
    const mediaPosts = posts.filter(p => (p.imageURLs && p.imageURLs.length > 0) || p.imageURL || p.videoURL);
    mediaPosts.sort((a, b) => {
      const tA = timestampMillis(a.createdAt);
      const tB = timestampMillis(b.createdAt);
      return tB - tA;
    });
    const enriched = await enrichPosts(mediaPosts, getState('user')?.uid);

    if (enriched.length === 0) {
      content.innerHTML = renderEmptyState(t('メディア投稿がありません'), '📷');
      return;
    }

    let html = '';
    for (const post of enriched) {
      html += renderPostCard(toRenderPost(post), post.author, post.liked, post.reposted);
    }
    content.innerHTML = html;
    setupPostEventListeners(content);
    decorateStoryAvatars(content);
  } catch (e) {
    console.error('loadProfileMedia error:', e);
    content.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

async function loadProfileFriends(uid: string): Promise<void> {
  const content = document.getElementById('profile-content');
  if (!content) return;
  content.innerHTML = renderLoadingSpinner();
  try {
    const friends = await getUserFriends(uid);

    if (friends.length === 0) {
      content.innerHTML = renderEmptyState(t('まだ友達がいません'), '👥');
      return;
    }

    const friendCounts = await Promise.all(friends.map(friend => getUserFriendCount((friend.uid || friend.id) || friend.id).catch(() => 0)));
    let html = '<div class="friends-list-compact">';
  for (const [index, friend] of friends.entries()) {
    const name = escapeHtml(friend.displayName || 'User');
    const uname = escapeHtml(friend.username || 'user');
    const friendBio = normalizeProfileBio(friend.bio);
    const bio = friendBio
      ? `${escapeHtml(friendBio.substring(0, 64))}${friendBio.length > 64 ? `… <span class="friend-bio-more">${t('プロフィールで全文を見る')}</span>` : ''}`
      : t('自己紹介はまだありません');
    const count = `${friendCounts[index]} ${t('人の友達')}`;
    html += `
      <a href="#/profile/${(friend.uid || friend.id)}" class="friend-card" data-navigate>
        ${createAvatarHTML(friend as unknown as Partial<UserProfile>, 46, { imageClassName: 'friend-avatar-img', fallbackClassName: 'friend-avatar-initials' })}
        <div class="friend-info">
          <div class="friend-name">${name}</div>
          <div class="friend-username">@${uname}</div>
          <div class="friend-bio">${bio}</div>
        </div>
        <div class="friend-meta">${count}</div>
      </a>
    `;
  }
  html += '</div>';
  content.innerHTML = html;
  } catch (e) {
    content.innerHTML = renderEmptyState(t('読み込みエラー'), '😵');
  }
}

// ============================================================
// プロフィール編集モーダル
// ============================================================
function openEditProfileModal(profile: EditableProfile): void {
  const displayName = escapeHtml(profile.displayName || '');
  const username = escapeHtml(profile.username || '');
  const bio = escapeHtml(normalizeProfileBio(profile.bio));

  const content = `
    <form id="edit-profile-form">
      <div class="form-group">
        <label class="form-label">${t('表示名')}</label>
        <input type="text" class="form-input" id="edit-display-name" value="${displayName}" required>
      </div>
      <div class="form-group">
        <label class="form-label">${t('ユーザー名')}</label>
        <input type="text" class="form-input" id="edit-username" value="${username}" required>
      </div>
      <div class="form-group">
        <label class="form-label">${t('自己紹介')}</label>
        <textarea class="form-input form-textarea" id="edit-bio" rows="3">${bio}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">${t('プロフィール画像')}</label>
        <small class="form-hint">${t('正方形（1:1）の画像がおすすめです。カバー画像と色味や雰囲気をそろえると統一感が出ます。')}</small>
        <div class="profile-file-inputs">
          <input type="file" class="form-input" id="edit-photo-file" accept="image/avif,image/jpeg,image/png,image/webp">
          <div class="file-preview" id="edit-photo-preview" style="display:none;">
            <img id="edit-photo-preview-img" src="" alt="preview">
            <button type="button" class="post-preview-remove" id="edit-photo-preview-remove">✕</button>
          </div>
          <small class="form-hint">${t('画像は5MB以下')}</small>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('カバー画像')}</label>
        <small class="form-hint">${t('横長（3:1〜16:9）の画像がおすすめです。プロフィール画像とトーンをそろえてください。')}</small>
        <div class="profile-file-inputs">
          <input type="file" class="form-input" id="edit-cover-file" accept="image/avif,image/jpeg,image/png,image/webp">
          <div class="file-preview" id="edit-cover-preview" style="display:none;">
            <img id="edit-cover-preview-img" src="" alt="preview">
            <button type="button" class="post-preview-remove" id="edit-cover-preview-remove">✕</button>
          </div>
          <small class="form-hint">${t('画像は5MB以下')}</small>
        </div>
      </div>
      <div class="form-error" id="edit-profile-error"></div>
      <button type="submit" class="btn btn-primary btn-full">${t('保存')}</button>
    </form>
  `;

  const modalHTML = renderModal(t('プロフィール編集'), content);
  document.body.insertAdjacentHTML('beforeend', modalHTML);

  const overlay = getElementById<HTMLElement>('modal-overlay');
  const closeBtn = getElementById<HTMLButtonElement>('modal-close');

  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) overlay?.remove();
  });
  closeBtn?.addEventListener('click', () => overlay?.remove());

  // プロフィール画像のファイル選択 & プレビュー
  let selectedPhotoFile: File | null = null;
  const photoFileInput = getElementById<HTMLInputElement>('edit-photo-file');
  const photoPreviewDiv = getElementById<HTMLElement>('edit-photo-preview');
  const photoPreviewImg = getElementById<HTMLImageElement>('edit-photo-preview-img');
  const photoRemoveBtn = getElementById<HTMLButtonElement>('edit-photo-preview-remove');

  if (photoFileInput) {
    photoFileInput.addEventListener('change', () => {
      const file = photoFileInput.files?.[0];
      if (!file) return;
      if (!['image/avif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) {
        alert('JPEG、PNG、WebP、AVIF形式の画像を選んでください');
        photoFileInput.value = '';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert(t('画像は5MB以下にしてください'));
        photoFileInput.value = '';
        return;
      }
      selectedPhotoFile = file;
      const reader = new FileReader();
      reader.onload = (e) => {
        if (photoPreviewImg) photoPreviewImg.src = typeof e.target?.result === 'string' ? e.target.result : '';
        if (photoPreviewDiv) photoPreviewDiv.style.display = 'block';
      };
      reader.readAsDataURL(file);
    });
  }

  if (photoRemoveBtn) {
    photoRemoveBtn.addEventListener('click', () => {
      selectedPhotoFile = null;
      if (photoFileInput) photoFileInput.value = '';
      if (photoPreviewDiv) photoPreviewDiv.style.display = 'none';
      if (photoPreviewImg) photoPreviewImg.src = '';
    });
  }

  // カバー画像のファイル選択 & プレビュー
  let selectedCoverFile: File | null = null;
  const coverFileInput = getElementById<HTMLInputElement>('edit-cover-file');
  const coverPreviewDiv = getElementById<HTMLElement>('edit-cover-preview');
  const coverPreviewImg = getElementById<HTMLImageElement>('edit-cover-preview-img');
  const coverRemoveBtn = getElementById<HTMLButtonElement>('edit-cover-preview-remove');

  if (coverFileInput) {
    coverFileInput.addEventListener('change', () => {
      const file = coverFileInput.files?.[0];
      if (!file) return;
      if (!['image/avif', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type.toLowerCase())) {
        alert('JPEG、PNG、WebP、AVIF形式の画像を選んでください');
        coverFileInput.value = '';
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        alert(t('画像は5MB以下にしてください'));
        coverFileInput.value = '';
        return;
      }
      selectedCoverFile = file;
      const reader = new FileReader();
      reader.onload = (e) => {
        if (coverPreviewImg) coverPreviewImg.src = typeof e.target?.result === 'string' ? e.target.result : '';
        if (coverPreviewDiv) coverPreviewDiv.style.display = 'block';
      };
      reader.readAsDataURL(file);
    });
  }

  if (coverRemoveBtn) {
    coverRemoveBtn.addEventListener('click', () => {
      selectedCoverFile = null;
      if (coverFileInput) coverFileInput.value = '';
      if (coverPreviewDiv) coverPreviewDiv.style.display = 'none';
      if (coverPreviewImg) coverPreviewImg.src = '';
    });
  }

  getElementById<HTMLFormElement>('edit-profile-form')?.addEventListener('submit', async (e: SubmitEvent) => {
    e.preventDefault();
    const currentUser = getState('user');
    if (!currentUser) return;

    const form = e.currentTarget instanceof HTMLFormElement ? e.currentTarget : null;
    const submitBtn = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!submitBtn) return;
    submitBtn.disabled = true;
    submitBtn.textContent = t('保存中...');

    try {
      let photoURL = profile.photoURL || '';
      if (selectedPhotoFile) {
        photoURL = await uploadProfileImage(selectedPhotoFile, currentUser.uid, 'avatar');
      }
      let coverURL = profile.coverURL || '';
      if (selectedCoverFile) {
        coverURL = await uploadProfileImage(selectedCoverFile, currentUser.uid, 'cover');
      }

      await updateUserProfile(currentUser.uid, {
        displayName: getElementById<HTMLInputElement>('edit-display-name')?.value || '',
        username: getElementById<HTMLInputElement>('edit-username')?.value || '',
        bio: getElementById<HTMLTextAreaElement>('edit-bio')?.value || '',
        ...(selectedPhotoFile ? { photoURL } : {}),
        ...(selectedCoverFile ? { coverURL } : {}),
      });
      // Keep the session-level profile in sync immediately. Existing posts do
      // not need to be rewritten; their render path resolves this user ID to
      // the latest profile on the next display.
      const updatedProfile = await getLatestProfileProjection(currentUser.uid);
      if (updatedProfile) setState('userProfile', updatedProfile as unknown as UserProfile);
      overlay?.remove();
      renderProfilePage({ uid: currentUser.uid });
    } catch (error) {
      const errorBox = getElementById<HTMLElement>('edit-profile-error');
      if (errorBox) errorBox.textContent = getFirebaseErrorMessage(error);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = t('保存');
    }
  });
}

// ============================================================
// 友達ページ
// ============================================================








