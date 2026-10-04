import { getState, setState } from '../state.ts';
import { escapeHtml, formatTime, formatRelativeTime, getFirebaseErrorMessage, isIndexError, getFirestoreIndexUrl } from '../utils.ts';
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

const MB = 1024 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 15 * MB;
const MAX_VIDEO_UPLOAD_BYTES = 3 * 1024 * MB;
const MAX_VIDEO_UPLOAD_SECONDS = 180;
const MAX_POST_IMAGE_COUNT = 20;
const MAX_OTHER_UPLOAD_BYTES = 10 * MB;
let homeStoryGroupsCache: unknown[] = [];

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

function toDisplayProfile(value: unknown, fallbackUid: string): UserProfile | null {
  if (!isObjectRecord(value)) return null;
  const uid = stringField(value, 'uid') || stringField(value, 'id') || fallbackUid;
  if (!uid) return null;
  return {
    uid,
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
      const rawAuthor = await getDisplayUserProfile(post.userId).catch((): null => null);
      const author = toDisplayProfile(rawAuthor, post.userId);
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

export async function renderLoginPage() {
  const container = getRequiredElement('page-content', HTMLElement);
  const currentUser = getState('user');

  if (currentUser) {
    setState('currentPage', 'feed');
    window.location.hash = '#/feed';
    return;
  }

  container.innerHTML = `
    <div class="login-page">
      <div class="login-hero">
        <div class="login-logo">
          <img class="login-logo-icon" src="${APP_ICON_PATH}" alt="Connect">
        </div>
        <h1 class="login-title">Connect</h1>
        <p class="login-subtitle">${t('友達とつながる、新しいSNS体験')}</p>
      </div>

      <div class="login-tabs">
        <button class="login-tab active" data-tab="login">${t('ログイン')}</button>
        <button class="login-tab" data-tab="register">${t('新規登録')}</button>
      </div>

      <div class="login-form-container" id="login-form-container">
        <!-- Login form -->
        <form id="login-form" class="auth-form">
          <div class="form-group">
            <label class="form-label">${t('メールアドレス')}</label>
            <input type="email" class="form-input" id="login-email" placeholder="your@email.com" required>
          </div>
          <div class="form-group">
            <label class="form-label">${t('パスワード')}</label>
            <input type="password" class="form-input" id="login-password" placeholder="••••••" required>
          </div>
          <a href="#/forgot-password" class="auth-link" data-navigate>${t('パスワードを忘れた方')}</a>
          <div class="form-error" id="login-error"></div>
          <button type="submit" class="btn btn-primary btn-full" id="login-submit">${t('ログイン')}</button>
        </form>

        <form id="register-form" class="auth-form hidden">
          <div class="form-group">
            <label class="form-label">${t('表示名')}</label>
            <input type="text" class="form-input" id="register-name" placeholder="${t('表示名')}" required>
          </div>
          <div class="form-group">
            <label class="form-label">${t('ユーザー名')}</label>
            <input type="text" class="form-input" id="register-username" placeholder="yamada_taro" required>
          </div>
          <div class="form-group">
            <label class="form-label">${t('メールアドレス')}</label>
            <input type="email" class="form-input" id="register-email" placeholder="your@email.com" required>
          </div>
          <div class="form-group">
            <label class="form-label">${t('パスワード (6文字以上)')}</label>
            <input type="password" class="form-input" id="register-password" placeholder="••••••" minlength="6" required>
          </div>
          <div class="form-error" id="register-error"></div>
          <button type="submit" class="btn btn-primary btn-full" id="register-submit">${t('アカウント作成')}</button>
        </form>
      </div>

    </div>
  `;

  // タブ切り替え
  const tabs = container.querySelectorAll<HTMLButtonElement>('.login-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      getOptionalElement('login-form', HTMLFormElement)?.classList.toggle('hidden', !isLogin);
      getOptionalElement('register-form', HTMLFormElement)?.classList.toggle('hidden', isLogin);
      getOptionalElement('login-error', HTMLElement)?.replaceChildren();
      getOptionalElement('register-error', HTMLElement)?.replaceChildren();
    });
  });

  // ログインフォーム
  getRequiredElement('login-form', HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = getInputValue('login-email');
    const password = getInputValue('login-password');
    const errorEl = getRequiredElement('login-error', HTMLElement);
    const submitBtn = getRequiredElement('login-submit', HTMLButtonElement);
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = t('ログイン中...');
    const { user, error } = await loginWithEmail(email, password);
    if (error) {
      errorEl.textContent = error;
      submitBtn.disabled = false;
      submitBtn.textContent = t('ログイン');
    }
  });

  // 登録フォーム
  getRequiredElement('register-form', HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = getInputValue('register-name');
    const username = getInputValue('register-username');
    const email = getInputValue('register-email');
    const password = getInputValue('register-password');
    const errorEl = getRequiredElement('register-error', HTMLElement);
    const submitBtn = getRequiredElement('register-submit', HTMLButtonElement);
    errorEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = t('作成中...');
    const { user, error } = await registerWithEmail(email, password, name);
    if (error) {
      errorEl.textContent = error;
      submitBtn.disabled = false;
      submitBtn.textContent = t('アカウント作成');
      return;
    }
    // プロフィール作成
    if (user) {
      await createUserProfile(user.uid, {
        displayName: name,
        username,
        email: user.email,
      });
    }
  });
}

// ============================================================
// パスワード再設定
// ============================================================
function getResetCodeFromUrl() {
  const hashQuery = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '';
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(hashQuery);
  return hashParams.get('oobCode') || searchParams.get('oobCode') || '';
}

export async function renderForgotPasswordPage() {
  const container = getRequiredElement('page-content', HTMLElement);
  container.innerHTML = `
    <div class="login-page">
      <div class="login-hero">
        <div class="login-logo"><img class="login-logo-icon" src="${APP_ICON_PATH}" alt="Connect"></div>
        <h1 class="login-title">${t('パスワード再設定')}</h1>
        <p class="login-subtitle">${t('登録済みメールアドレスに再設定URLを送信します')}</p>
      </div>
      <div class="login-form-container">
        <form id="forgot-password-form" class="auth-form">
          <div class="form-group">
            <label class="form-label">${t('メールアドレス')}</label>
            <input type="email" class="form-input" id="forgot-email" placeholder="your@email.com" required>
          </div>
          <div class="form-error" id="forgot-error"></div>
          <div class="form-success" id="forgot-success"></div>
          <button type="submit" class="btn btn-primary btn-full" id="forgot-submit">${t('再設定URLを送信')}</button>
          <a href="#/login" class="auth-link auth-link-center" data-navigate>${t('ログインに戻る')}</a>
        </form>
      </div>
    </div>
  `;

  getOptionalElement('forgot-password-form', HTMLFormElement)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = getInputValue('forgot-email').trim();
    const errorEl = getRequiredElement('forgot-error', HTMLElement);
    const successEl = getRequiredElement('forgot-success', HTMLElement);
    const submitBtn = getRequiredElement('forgot-submit', HTMLButtonElement);
    errorEl.textContent = '';
    successEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = t('送信中...');
    const { error, fallback } = await sendResetPasswordEmail(email);
    submitBtn.disabled = false;
    submitBtn.textContent = t('再設定URLを送信');
    if (error) {
      errorEl.textContent = error;
      return;
    }
    successEl.textContent = fallback
      ? t('パスワード再設定メールを送信しました。メール内のFirebase公式画面で新しいパスワードを設定してください。届かない場合は迷惑メールフォルダも確認してください。')
      : t('パスワード再設定URLをメールで送信しました。メール内のリンクを開いて新しいパスワードを設定してください。');
  });
}

export async function renderResetPasswordPage() {
  const container = getRequiredElement('page-content', HTMLElement);
  const code = getResetCodeFromUrl();
  let verifiedEmail = '';
  let initialError = '';

  if (code) {
    const result = await verifyResetPasswordCode(code);
    verifiedEmail = result.email || '';
    initialError = result.error || '';
  } else {
    initialError = t('再設定URLが無効です。メールのリンクを開き直してください。');
  }

  container.innerHTML = `
    <div class="login-page">
      <div class="login-hero">
        <div class="login-logo"><img class="login-logo-icon" src="${APP_ICON_PATH}" alt="Connect"></div>
        <h1 class="login-title">${t('新しいパスワード')}</h1>
        <p class="login-subtitle">${verifiedEmail ? escapeHtml(verifiedEmail) : t('確認のため2回入力してください')}</p>
      </div>
      <div class="login-form-container">
        <form id="reset-password-form" class="auth-form">
          <div class="form-group">
            <label class="form-label">${t('新しいパスワード (6文字以上)')}</label>
            <input type="password" class="form-input" id="reset-password" placeholder="••••••" minlength="6" required ${initialError ? 'disabled' : ''}>
          </div>
          <div class="form-group">
            <label class="form-label">${t('新しいパスワード（確認）')}</label>
            <input type="password" class="form-input" id="reset-password-confirm" placeholder="••••••" minlength="6" required ${initialError ? 'disabled' : ''}>
          </div>
          <div class="form-error" id="reset-error">${escapeHtml(initialError)}</div>
          <div class="form-success" id="reset-success"></div>
          <button type="submit" class="btn btn-primary btn-full" id="reset-submit" ${initialError ? 'disabled' : ''}>${t('パスワードを更新')}</button>
          <a href="#/forgot-password" class="auth-link auth-link-center" data-navigate>${t('再設定メールを送り直す')}</a>
        </form>
      </div>
    </div>
  `;

  getOptionalElement('reset-password-form', HTMLFormElement)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = getInputValue('reset-password');
    const confirm = getInputValue('reset-password-confirm');
    const errorEl = getRequiredElement('reset-error', HTMLElement);
    const successEl = getRequiredElement('reset-success', HTMLElement);
    const submitBtn = getRequiredElement('reset-submit', HTMLButtonElement);
    errorEl.textContent = '';
    successEl.textContent = '';
    if (password !== confirm) {
      errorEl.textContent = t('確認用パスワードが一致しません');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = t('更新中...');
    const { error } = await confirmResetPassword(code, password);
    submitBtn.disabled = false;
    submitBtn.textContent = t('パスワードを更新');
    if (error) {
      errorEl.textContent = error;
      return;
    }
    successEl.textContent = t('パスワードを更新しました。新しいパスワードでログインしてください。');
    setTimeout(() => { window.location.hash = '#/login'; }, 1600);
  });
}

// ============================================================
// フィードページ
// ============================================================





