import { getState, setState } from '../state.ts';
import { escapeHtml, formatTime, formatRelativeTime, getFirebaseErrorMessage, isIndexError, getFirestoreIndexUrl, normalizeProfileBio } from '../utils.ts';
import { t } from '../i18n.ts';
import { APP_ICON_PATH } from '../config.ts';
import {
  loginWithEmail, registerWithEmail,
  sendResetPasswordEmail, verifyResetPasswordCode, confirmResetPassword,
  logout,
} from '../auth.ts';
import {
  getUserProfile, getDisplayUserProfile, updateUserProfile, createUserProfile,
  getFeedPosts, getUserPosts, getPostById, createPost, createQuotePost, updatePost, deletePost,
  toggleLike, getComments, addComment,
  searchUsers, getAllUsers,
  getUserFriends, getUserFriendIds, getUserFriendCount, sendFriendRequest, acceptFriendRequest,
  removeFriend, getFriendshipStatus, getPendingRequests,
  getNotifications, getUnreadNotificationCount,
  markNotificationRead, markAllNotificationsRead,
  createNotification,
  getTrendingPosts,
  votePoll, uploadFile,
  toggleRepost, getUserComments, getUserPostCount,
  toggleCommentLike,
  getFollowers, getFollowing, areMutualFriends,
  createFriendQrToken, verifyFriendQrPayload, createMutualFriendship,
  createStory, deleteStory, getHomeStoryGroups, getUserStoryGroup, markStoryViewed, reactToStory, voteStoryPoll, STORY_REACTIONS,
  recordPostView, recordPostProfileClick, getLikes, getUserLikedPosts, toggleBookmark, getUserBookmarks, getPostViewerStates, enrichCommentRecords,
} from '../db.ts';
import {
  renderPostCard, renderComment,
  renderNotification, renderCreatePostForm,
  renderLoadingSpinner, renderEmptyState,
  renderLoadMoreButton, renderModal, createAvatarHTML,
  renderPoll, linkifyHashtags, renderExpandablePostText, renderUserListItem,
} from '../components.ts';
import { db } from '../firebase.ts';
import type { Comment, Post, UserProfile } from '../types/domain.ts';
import { doc, getDoc, collection, updateDoc, serverTimestamp } from 'firebase/firestore';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

const MB = 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 15 * MB;
const MAX_VIDEO_UPLOAD_BYTES = 3 * 1024 * MB;
const MAX_VIDEO_UPLOAD_SECONDS = 180;
const MAX_POST_IMAGE_COUNT = 20;
const MAX_OTHER_UPLOAD_BYTES = 10 * MB;
let homeStoryGroupsCache: unknown[] = [];

type CurrentUser = {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
};

type EnrichedPost = Post & {
  author: UserProfile | null;
  liked: boolean;
  bookmarked?: boolean;
  reposted: boolean;
};

type CommentAuthorSnapshot = {
  authorDisplayName?: string;
  authorUsername?: string;
  authorPhotoURL?: string;
  authorAvatarColor?: string;
};

type EnrichedComment = Comment & CommentAuthorSnapshot & {
  author?: UserProfile | null;
  liked?: boolean;
};

type MaybeUserProfile = UserProfile & {
  id?: string;
  avatarColor?: string;
};

type PendingFriendRequest = {
  id: string;
  requester: string;
  requesterProfile?: MaybeUserProfile | null;
};

type FriendQrPayload = string | Record<string, unknown>;

type FriendQrVerifyResult = {
  target: MaybeUserProfile;
  status: string;
};

type BarcodeDetectorResult = {
  rawValue?: string;
};

type BarcodeDetectorInstance = {
  detect(source: HTMLVideoElement): Promise<BarcodeDetectorResult[]>;
};

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance;

function getRequiredElement<T extends HTMLElement>(id: string, ctor: { new (...args: never[]): T }): T {
  const element = document.getElementById(id);
  if (element instanceof ctor) return element;
  throw new Error(`Missing required element: ${id}`);
}

function getOptionalElement<T extends HTMLElement>(id: string, ctor: { new (...args: never[]): T }): T | null {
  const element = document.getElementById(id);
  return element instanceof ctor ? element : null;
}

function getInputValue(id: string): string {
  return getRequiredElement(id, HTMLInputElement).value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  return typeof field === 'string' ? field : '';
}

function toDisplayProfile(value: unknown, fallbackUid: string): MaybeUserProfile | null {
  if (!isObjectRecord(value)) return null;
  const uid = stringField(value, 'uid') || stringField(value, 'id') || fallbackUid;
  if (!uid) return null;
  return {
    uid,
    id: stringField(value, 'id') || uid,
    displayName: stringField(value, 'displayName') || stringField(value, 'username') || 'User',
    username: stringField(value, 'username'),
    email: stringField(value, 'email') || undefined,
    bio: stringField(value, 'bio') || undefined,
    photoURL: stringField(value, 'photoURL') || stringField(value, 'profileImage') || undefined,
    profileImage: stringField(value, 'profileImage') || undefined,
    coverImage: stringField(value, 'coverImage') || undefined,
    avatarColor: stringField(value, 'avatarColor') || undefined,
  };
}

function getUserId(user: MaybeUserProfile): string {
  return user.uid || user.id || '';
}

function toPendingFriendRequest(value: unknown): PendingFriendRequest | null {
  if (!isObjectRecord(value)) return null;
  const requester = stringField(value, 'requester') || stringField(value, 'requesterId') || stringField(value, 'fromUserId');
  if (!requester) return null;
  return {
    id: stringField(value, 'id'),
    requester,
    requesterProfile: toDisplayProfile(value.requesterProfile, requester),
  };
}

function toDisplayProfiles(values: readonly unknown[]): MaybeUserProfile[] {
  return values
    .map(value => {
      const fallbackUid = isObjectRecord(value) ? stringField(value, 'uid') || stringField(value, 'id') : '';
      return toDisplayProfile(value, fallbackUid);
    })
    .filter((profile): profile is MaybeUserProfile => Boolean(profile));
}

function getCurrentUser(): CurrentUser | null {
  const user = getState('user') as unknown;
  return isObjectRecord(user) && typeof user.uid === 'string' ? user as CurrentUser : null;
}

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

// ============================================================
// ヘルパー: 投稿にユーザー情報とライク状態を付与
// ============================================================
async function enrichPosts(posts: Post[], currentUserId: string | null | undefined): Promise<EnrichedPost[]> {
  const viewerStates = currentUserId
    ? await getPostViewerStates(posts.map(post => post.id), currentUserId).catch(() => ({ liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() }))
    : { liked: new Set<string>(), bookmarked: new Set<string>(), reposted: new Set<string>() };
  return Promise.all(posts.map(async (post): Promise<EnrichedPost> => {
    try {
      const author = await getDisplayUserProfile(post.userId).then(profile => toDisplayProfile(profile, post.userId)).catch((): null => null);
      return { ...post, author, liked: viewerStates.liked.has(post.id), bookmarked: viewerStates.bookmarked.has(post.id), reposted: viewerStates.reposted.has(post.id) };
    } catch (e) {
      return { ...post, author: null, liked: false, bookmarked: false, reposted: false };
    }
  }));
}

// ============================================================
// ヘルパー: コメントにユーザー情報を付与
// ============================================================
async function enrichComments(comments: EnrichedComment[], currentUserId: string | null | undefined): Promise<EnrichedComment[]> {
  const enriched = await enrichCommentRecords(comments, currentUserId || '');
  return enriched.map(comment => ({
    ...comment,
    id: comment.id || '',
    postId: comment.postId || '',
    userId: comment.userId || '',
    text: comment.text || '',
    likesCount: comment.likesCount,
    author: toDisplayProfile(comment.author, comment.userId || ''),
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
        ${renderComment(comment, comment.author, comment.liked)}
        ${replies.length ? `<div class="comment-replies">${replies.map(reply => renderNode(reply, depth + 1)).join('')}</div>` : ''}
      </div>
    `;
  };

  return topLevel.map(comment => renderNode(comment)).join('');
}

// ============================================================
// ログインページ
// ============================================================

export async function renderFriendsPage(): Promise<void> {
  const currentUser = getCurrentUser();

  const container = getRequiredElement('page-content', HTMLElement);
  if (!currentUser) {
    window.location.hash = '#/login';
    return;
  }
  container.innerHTML = `
    <div class="friends-page">
      <div class="friends-header">
        <h2 class="page-title">${t('友達')}</h2>
        <div class="friends-header-actions">
          <button class="btn btn-secondary" id="btn-show-friend-qr" aria-label="${t('自分のQRコードを表示')}">QR</button>
          <button class="btn btn-primary" id="btn-scan-friend-qr" aria-label="${t('友達QRコードを読み取る')}">${t('QR読取')}</button>
        </div>
      </div>

      <div class="friends-search">
        <input type="text" class="form-input" id="friends-search-input" placeholder="${t('ユーザー名または表示名で検索…')}">
        <button class="btn btn-primary" id="friends-search-btn">${t('検索')}</button>
      </div>

      <div class="friends-search-results" id="friends-search-results"></div>

      <div class="friends-pending" id="friends-pending">
        <h3 class="section-title">${t('保留中のリクエスト')}</h3>
        <div id="pending-requests">${renderLoadingSpinner()}</div>
      </div>

      <div class="friends-list-section">
        <h3 class="section-title">${t('友達一覧')}</h3>
        <div id="friends-list">${renderLoadingSpinner()}</div>
      </div>
    </div>
  `;

  loadFriendsList(currentUser.uid);

  // 保留中リクエスト
  loadPendingRequests(currentUser.uid);

  document.getElementById('btn-show-friend-qr')?.addEventListener('click', () => openFriendQrModal(currentUser));
  document.getElementById('btn-scan-friend-qr')?.addEventListener('click', () => openFriendQrScanner(currentUser));

  // 検索
  const searchInput = getRequiredElement('friends-search-input', HTMLInputElement);
  const searchBtn = getRequiredElement('friends-search-btn', HTMLButtonElement);

  const doSearch = async () => {
    const query = searchInput.value.trim();
    const resultsDiv = getRequiredElement('friends-search-results', HTMLElement);
    if (!query) {
      resultsDiv.innerHTML = '';
      return;
    }

    resultsDiv.innerHTML = renderLoadingSpinner();
    const users = await searchUsers(query);
    const filtered = users.filter(u => u.uid !== currentUser.uid);

    if (filtered.length === 0) {
      resultsDiv.innerHTML = renderEmptyState(t('ユーザーが見つかりません'), '🔍');
      return;
    }

    let html = '<div class="search-results-list">';
    for (const user of filtered) {
      const name = escapeHtml(user.displayName || 'User');
      const uname = escapeHtml(user.username || 'user');
      const status = await getFriendshipStatus(currentUser.uid, user.uid);

      let actionBtn = '';
      if (status === 'none') {
        actionBtn = `<button class="btn btn-sm btn-primary add-friend-btn" data-uid="${user.uid}">${t('追加')}</button>`;
      } else if (status === 'pending_sent') {
        actionBtn = `<span class="status-text">${t('送信済み')}</span>`;
      } else if (status === 'pending_received') {
        actionBtn = `<button class="btn btn-sm btn-primary accept-friend-btn" data-uid="${user.uid}">${t('承認')}</button>`;
      } else if (status === 'friends') {
        actionBtn = `<span class="status-text friend-status">${t('友達')}</span>`;
      }

      html += `
        <div class="search-result-item">
          <a href="#/profile/${user.uid}" class="search-result-link" data-navigate>
            ${createAvatarHTML(user as unknown as Partial<UserProfile>, 40, { imageClassName: 'search-result-avatar', fallbackClassName: 'search-result-avatar-initials' })}
            <div class="search-result-info">
              <div class="search-result-name">${name}</div>
              <div class="search-result-username">@${uname}</div>
            </div>
          </a>
          <div class="search-result-action">${actionBtn}</div>
        </div>
      `;
    }
    html += '</div>';
    resultsDiv.innerHTML = html;

    // 友達追加ボタン
    resultsDiv.querySelectorAll<HTMLButtonElement>('.add-friend-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetUid = btn.dataset.uid;
        if (!targetUid) return;
        await sendFriendRequest(currentUser.uid, targetUid);
        btn.textContent = t('送信済み');
        btn.disabled = true;
      });
    });

    resultsDiv.querySelectorAll<HTMLButtonElement>('.accept-friend-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const targetUid = btn.dataset.uid;
          if (!targetUid) return;
          await acceptFriendRequest(currentUser.uid, targetUid);
          btn.textContent = t('友達になりました！');
          btn.disabled = true;
        } catch (e) {
          console.error('accept error:', e);
        }
      });
    });
  };

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
}

function closeModalById(id: string): void {
  document.getElementById(id)?.remove();
}

async function openFriendQrModal(currentUser: CurrentUser): Promise<void> {
  const profile = toDisplayProfile(getState('userProfile'), currentUser.uid) || {
    uid: currentUser.uid,
    displayName: currentUser.displayName || 'User',
    username: '',
    photoURL: currentUser.photoURL || undefined,
  };
  const modalId = 'friend-qr-modal';
  closeModalById(modalId);
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="${modalId}" role="dialog" aria-modal="true" aria-label="${t('自分のQRコード')}">
      <div class="modal-container friend-qr-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${t('自分のQRコード')}</h3>
          <button type="button" class="modal-close" id="friend-qr-close" aria-label="${t('閉じる')}">&times;</button>
        </div>
        <div class="modal-body">
          <div class="friend-qr-profile">
            ${createAvatarHTML(profile, 44)}
            <div>
              <div class="friend-qr-name">${escapeHtml(profile.displayName || 'User')}</div>
              <div class="friend-qr-sub">@${escapeHtml(profile.username || 'user')}</div>
            </div>
          </div>
          <div class="friend-qr-code" id="friend-qr-code">${renderLoadingSpinner()}</div>
          <p class="friend-qr-note">${t('このQRコードは10分間だけ有効です。相手が読み取ると確認後に相互友達になります。')}</p>
        </div>
      </div>
    </div>
  `);

  const close = () => closeModalById(modalId);
  document.getElementById('friend-qr-close')?.addEventListener('click', close);
  document.getElementById(modalId)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  try {
    const payload = await createFriendQrToken(currentUser.uid);
    const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), { width: 260, margin: 2, errorCorrectionLevel: 'M' });
    const code = document.getElementById('friend-qr-code');
    if (code) code.innerHTML = `<img src="${dataUrl}" alt="${t('友達追加用QRコード')}" class="friend-qr-img">`;
  } catch (e) {
    const code = document.getElementById('friend-qr-code');
    if (code) code.innerHTML = `<div class="form-error">${escapeHtml(getFirebaseErrorMessage(e))}</div>`;
  }
}

async function openFriendQrScanner(currentUser: CurrentUser): Promise<void> {
  const modalId = 'friend-qr-scan-modal';
  closeModalById(modalId);
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-overlay" id="${modalId}" role="dialog" aria-modal="true" aria-label="${t('QRコードを読み取る')}">
      <div class="modal-container friend-qr-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${t('QRコードを読み取る')}</h3>
          <button type="button" class="modal-close" id="friend-qr-scan-close" aria-label="${t('閉じる')}">&times;</button>
        </div>
        <div class="modal-body">
          <video class="friend-qr-video" id="friend-qr-video" autoplay playsinline muted></video>
          <div class="friend-qr-scan-status" id="friend-qr-scan-status">${t('カメラを起動しています...')}</div>
          <div class="friend-qr-manual">
            <label class="form-label">${t('読み取れない場合はQR内容を貼り付け')}</label>
            <textarea class="form-input" id="friend-qr-manual-input" rows="3" placeholder='{"app":"connect",...}'></textarea>
            <button class="btn btn-secondary btn-full" id="friend-qr-manual-btn">${t('確認する')}</button>
          </div>
          <div id="friend-qr-result"></div>
        </div>
      </div>
    </div>
  `);

  let stream: MediaStream | null = null;
  let stopped = false;
  const video = getRequiredElement('friend-qr-video', HTMLVideoElement);
  const status = getOptionalElement('friend-qr-scan-status', HTMLElement);
  const close = () => {
    stopped = true;
    stream?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    closeModalById(modalId);
  };
  document.getElementById('friend-qr-scan-close')?.addEventListener('click', close);
  document.getElementById(modalId)?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  document.getElementById('friend-qr-manual-btn')?.addEventListener('click', async () => {
    const value = getOptionalElement('friend-qr-manual-input', HTMLTextAreaElement)?.value.trim();
    if (value) await handleFriendQrPayload(value, currentUser);
  });

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      if (status) status.textContent = t('この環境ではカメラ読み取りを使えません。QR内容の貼り付けを使ってください。');
      return;
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const readWithJsQr = (): { data: string } | null => {
      if (!ctx || !video.videoWidth || !video.videoHeight) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
    };

    const BarcodeDetectorCtor = 'BarcodeDetector' in window ? (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector : undefined;
    const detector = BarcodeDetectorCtor ? new BarcodeDetectorCtor({ formats: ['qr_code'] }) : null;
    const scan = async (): Promise<void> => {
      if (stopped) return;
      try {
        let payload = '';
        if (detector) {
          const codes = await detector.detect(video);
          payload = codes[0]?.rawValue || '';
        }
        if (!payload) payload = readWithJsQr()?.data || '';
        if (payload) {
          await handleFriendQrPayload(payload, currentUser);
          stream?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
          if (status) status.textContent = t('QRコードを読み取りました');
          return;
        }
        if (status) status.textContent = t('QRコードをカメラに映してください');
      } catch (e) {}
      requestAnimationFrame(scan);
    };
    video.addEventListener('loadedmetadata', scan, { once: true });
    video.play?.().catch(() => {});
  } catch (e) {
    if (status) status.textContent = t('カメラを起動できませんでした。Androidの設定でExpo Goのカメラ権限を許可してください。');
  }
}

async function handleFriendQrPayload(payload: string, currentUser: CurrentUser): Promise<void> {
  const result = document.getElementById('friend-qr-result');
  if (!result) return;
  result.innerHTML = renderLoadingSpinner();
  try {
    const verified = await verifyFriendQrPayload(payload, currentUser.uid) as unknown;
    if (!isObjectRecord(verified)) throw new Error(t('QRコードを確認できませんでした'));
    const target = toDisplayProfile(verified.target, '');
    const status = typeof verified.status === 'string' ? verified.status : '';
    if (!target) throw new Error(t('ユーザーを確認できませんでした'));
    const already = status === 'friends';
    result.innerHTML = `
      <div class="friend-qr-confirm">
        ${createAvatarHTML(target, 48)}
        <div class="friend-qr-confirm-body">
          <div class="friend-qr-name">${escapeHtml(target.displayName || 'User')}</div>
          <div class="friend-qr-sub">@${escapeHtml(target.username || 'user')}</div>
          <div class="friend-qr-note">${already ? t('すでに友達です') : t('確認後、相互友達として登録します。')}</div>
        </div>
        <button class="btn btn-primary" id="friend-qr-add-btn" ${already ? 'disabled' : ''}>${already ? t('友達') : t('友達になる')}</button>
      </div>
    `;
    document.getElementById('friend-qr-add-btn')?.addEventListener('click', async (e) => {
      if (!(e.currentTarget instanceof HTMLButtonElement)) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = t('登録中...');
      const friendship = await createMutualFriendship(currentUser.uid, target.uid);
      if (friendship.eventId) {
        await createNotification({ userId: target.uid, type: 'friend_accept', fromUserId: currentUser.uid, eventId: friendship.eventId });
      }
      btn.textContent = t('友達になりました');
      loadFriendsList(currentUser.uid);
      closeModalById('friend-qr-scan-modal');
      window.location.hash = `#/profile/${target.uid}`;
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : getFirebaseErrorMessage(e);
    result.innerHTML = `<div class="form-error">${escapeHtml(message)}</div>`;
  }
}

async function loadPendingRequests(uid: string): Promise<void> {
  const container = getOptionalElement('pending-requests', HTMLElement);
  if (!container) return;
  try {
    const requests = await getPendingRequests(uid);
    if (requests.length === 0) {
      container.innerHTML = `
        <div class="empty-state empty-state-compact">
          <div class="empty-emoji">👋</div>
          <div class="empty-text">${t('保留中のリクエストはありません')}</div>
          <button class="btn btn-sm btn-secondary" id="focus-friend-search">${t('ユーザーを検索')}</button>
        </div>
      `;
      document.getElementById('focus-friend-search')?.addEventListener('click', () => {
        getOptionalElement('friends-search-input', HTMLInputElement)?.focus();
      });
      return;
    }
    let html = '';
    for (const req of requests) {
      const request = toPendingFriendRequest(req);
      if (!request) continue;
      const profile = request.requesterProfile;
      const name = escapeHtml(profile?.displayName || t('不明なユーザー'));
      html += `
        <div class="pending-request-item" data-request-id="${request.id}">
          <a href="#/profile/${request.requester}" class="pending-request-link" data-navigate>
            ${createAvatarHTML(profile, 36)}
            <span class="pending-request-name">${name}</span>
          </a>
          <div class="pending-request-actions">
            <button class="btn btn-sm btn-primary accept-request-btn" data-uid="${request.requester}">${t('承認')}</button>
            <button class="btn btn-sm btn-secondary reject-request-btn" data-uid="${request.requester}">${t('拒否')}</button>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;

    container.querySelectorAll<HTMLButtonElement>('.accept-request-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          const targetUid = btn.dataset.uid;
          if (!targetUid) return;
          await acceptFriendRequest(uid, targetUid);
          btn.closest('.pending-request-item')?.remove();
          if (container.querySelectorAll('.pending-request-item').length === 0) {
            loadPendingRequests(uid);
          }
          loadFriendsList(uid);
        } catch (e) {
          console.error('accept error:', e);
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>('.reject-request-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('このリクエストを拒否しますか？'))) return;
        const targetUid = btn.dataset.uid;
        if (!targetUid) return;
        await removeFriend(uid, targetUid);
        btn.closest('.pending-request-item')?.remove();
        if (container.querySelectorAll('.pending-request-item').length === 0) {
          loadPendingRequests(uid);
        }
      });
    });
  } catch (e) {
    container.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

async function loadFriendsList(uid: string): Promise<void> {
  const container = getOptionalElement('friends-list', HTMLElement);
  if (!container) return;
  try {
    const rawFriends = await getUserFriends(uid);
    const friends = toDisplayProfiles(rawFriends);
    if (friends.length === 0) {
      container.innerHTML = renderEmptyState(t('まだ友達がいません。「検索」から友達を追加しましょう'), '👥');
      return;
    }
    const friendCounts = await Promise.all(friends.map(friend => getUserFriendCount(getUserId(friend)).catch(() => 0)));
    let html = '<div class="friends-list-compact">';
    for (const [index, friend] of friends.entries()) {
      const name = escapeHtml(friend.displayName || 'User');
      const friendBio = normalizeProfileBio(friend.bio);
      const bio = friendBio
        ? `${escapeHtml(friendBio.substring(0, 64))}${friendBio.length > 64 ? `… <span class="friend-bio-more">${t('プロフィールで全文を見る')}</span>` : ''}`
        : t('自己紹介はまだありません');
      const count = `${friendCounts[index]} ${t('人の友達')}`;
      html += `
        <div class="friend-card">
          <a href="#/profile/${getUserId(friend)}" class="friend-card-main" data-navigate>
            ${createAvatarHTML(friend as unknown as Partial<UserProfile>, 46, { imageClassName: 'friend-avatar-img', fallbackClassName: 'friend-avatar-initials' })}
            <div class="friend-info">
              <div class="friend-name">${name}</div>
              <div class="friend-username">@${escapeHtml(friend.username || '')}</div>
              <div class="friend-bio">${bio}</div>
            </div>
          </a>
          <div class="friend-card-actions">
            <div class="friend-meta">${count}</div>
          </div>
        </div>
      `;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = renderEmptyState(t('読み込みに失敗しました'), '😵');
  }
}

// ============================================================
// トレンド/探索ページ
// ============================================================





