import './style.css';

import { APP_ICON_PATH } from './config.ts';
import { calculateBottomNavigationContentInset } from './bottomNavigation.ts';
import { getState, setState, onStateChange, toggleTheme, applyTheme } from './state.ts';
import { initAuthListener } from './auth.ts';
import { t, getLocale, setLocale, getLocales } from './i18n.ts';
import { normalizeProfileBio } from './utils.ts';
import { initRouter, registerRoute, navigateTo } from './router.ts';
import { getDisplayUserProfile, prefetchPostVideoURL, createUserProfile } from './db.ts';
import { updateCurrentUserComposerAvatars } from './components.ts';
import { auth, db } from './firebase.ts';
import { onSnapshot, collection, query, where, limit } from 'firebase/firestore';
import type { UserProfile } from './types/domain.ts';
import { bindPushServiceWorkerMessages, registerConnectServiceWorker, syncExistingPushSubscription } from './pushNotifications.ts';
import { bindVideoLongPress } from './videoLongPress.ts';
import { bindLazyVideoLoader as bindMediaLazyVideoLoader } from './lazyVideo.ts';
import { renderLoginPage, renderForgotPasswordPage, renderResetPasswordPage } from './pageModules/auth.ts';
import { renderFeedPage, showAppToast } from './pageModules/home.ts';
import { ACTIVE_NOTIFICATION_TYPES } from './notificationDomain.ts';
import { InitialLoadProgress, type InitialLoadSnapshot, type InitialLoadTaskDefinition } from './initialLoadProgress.ts';
import { initialLoadDebugEnabled, waitForInitialLoadDebugStep } from './initialLoadDebug.ts';
import { classifyStartupError, withTimeout } from './startupResilience.ts';
import { clearStartupTraceSession, startStartupTraceSession, startupTraceEnabled, type StartupTraceSession } from './startupTrace.ts';

type RouteParams = Record<string, string>;
const renderProfilePage = async (params: RouteParams) => (await import('./pageModules/profile.ts')).renderProfilePage(params);
const renderDraftsPage = async () => (await import('./pageModules/profile.ts')).renderDraftsPage();
const renderBookmarksPage = async () => (await import('./pageModules/profile.ts')).renderBookmarksPage();
const renderSettingsPage = async () => (await import('./pageModules/profile.ts')).renderSettingsPage();
const renderFriendsPage = async () => (await import('./pageModules/friends.ts')).renderFriendsPage();
const renderUserMentionRedirectPage = async (params: RouteParams) => (await import('./pageModules/profile.ts')).renderUserMentionRedirectPage(params);
const renderNotificationsPage = async () => (await import('./pageModules/explore.ts')).renderNotificationsPage();
const renderExplorePage = async () => (await import('./pageModules/explore.ts')).renderExplorePage();
const renderPostDetailPage = async (params: RouteParams) => (await import('./pageModules/explore.ts')).renderPostDetailPage(params);
const renderFollowersPage = async (params: RouteParams) => (await import('./pageModules/explore.ts')).renderFollowersPage(params);
const renderFollowingPage = async (params: RouteParams) => (await import('./pageModules/explore.ts')).renderFollowingPage(params);
const renderFriendsListPage = async (params: RouteParams) => (await import('./pageModules/explore.ts')).renderFriendsListPage(params);
const renderAdminModerationPage = async () => (await import('./pageModules/moderation.ts')).renderAdminModerationPage();
const renderModerationAppealPage = async (params: RouteParams) => (await import('./pageModules/moderation.ts')).renderModerationAppealPage(params);
// ============================================================
// UIコンポーネントのレンダリング
// ============================================================

let unsubscribeNotifications: Unsubscribe | null = null;
const AUTH_ROUTES = ['/login', '/forgot-password', '/reset-password', '/register'];
const PUBLIC_ROUTES = ['/feed', '/explore', '/post', '/profile', '/u'];

function getCurrentRoutePath(): string {
  return (window.location.hash || '#/feed').replace(/^#/, '').split('?')[0] || '/feed';
}

type Unsubscribe = () => void;

type ProfileRecordLike = {
  id?: string;
  uid?: string;
  email?: string;
  displayName?: string;
  username?: string;
  bio?: string;
  photoURL?: string;
  profileImage?: string;
  profilePhotoPreviewURL?: string;
  coverImage?: string;
  friendsCount?: number;
  postsCount?: number;
};

function toStateUserProfile(profile: ProfileRecordLike): UserProfile {
  const fallbackName = profile.displayName || profile.username || 'User';
  return {
    uid: profile.uid || profile.id || '',
    email: profile.email,
    displayName: fallbackName,
    username: profile.username || fallbackName.toLowerCase().replace(/\s+/g, '_'),
    bio: normalizeProfileBio(profile.bio),
    photoURL: profile.photoURL,
    profileImage: profile.profileImage,
    profilePhotoPreviewURL: profile.profilePhotoPreviewURL,
    coverImage: profile.coverImage,
    friendsCount: profile.friendsCount,
    postsCount: profile.postsCount,
  };
}


function bindLazyVideoLoader(): void {
  bindMediaLazyVideoLoader(document, {
    resolveURL: prefetchPostVideoURL,
    bindVideoLongPress,
    onVideoError: ({ postId, mediaErrorCode, source }) => {
      console.error('[Connect] post video request failed', { postId, mediaErrorCode: mediaErrorCode || 0, source: source || 'unknown' });
      showAppToast(t('動画を読み込めませんでした。もう一度お試しください'), 'error');
    },
    onSourceError: ({ postId, reason }) => {
      console.error('[Connect] post video source resolution failed', { postId, reason });
      showAppToast(t('動画を読み込めませんでした。もう一度お試しください'), 'error');
    },
    onPlaybackError: ({ postId, reason }) => {
      console.error('[Connect] post video playback failed', { postId, reason });
      showAppToast(t('動画を読み込めませんでした。もう一度お試しください'), 'error');
    },
  });
}
function setTextIfPresent(target: Element | null | undefined, text: string): void {
  if (target) target.textContent = text;
}

/**
 * The shell is rendered before Firebase restores a persisted session. Keep
 * the anonymous login affordance initially, then swap in the authenticated
 * actions when the auth listener resolves so a signed-in user never gets a
 * stale header that only contains "ログイン".
 */
function accountControlsMarkup(authenticated: boolean): string {
  if (!authenticated) {
    return `
          <a href="#/login" class="header-icon-btn header-login-btn" title="${t('ログイン')}" aria-label="${t('ログイン')}" data-navigate>
            <span class="header-action-icon" aria-hidden="true">↪</span>
            <span class="header-action-label">${t('ログイン')}</span>
          </a>
        `;
  }
  return `
          <a href="#/settings" class="header-icon-btn header-settings-btn" title="${t('設定')}" aria-label="${t('設定')}" data-navigate>
            <span class="header-action-icon">⚙</span>
            <span class="header-action-label">${t('設定')}</span>
          </a>
        `;
}

function syncAccountControls(authenticated: boolean): void {
  const container = document.getElementById('account-controls');
  if (!container) return;
  container.innerHTML = accountControlsMarkup(authenticated);
  container.dataset.authenticated = authenticated ? 'true' : 'false';
}

let bottomNavResizeObserver: ResizeObserver | null = null;
let bottomNavMutationObserver: MutationObserver | null = null;
let bottomNavWindowSync: (() => void) | null = null;
function trackBottomNavigationInset(): void {
  bottomNavResizeObserver?.disconnect();
  bottomNavMutationObserver?.disconnect();
  if (bottomNavWindowSync) {
    window.removeEventListener('resize', bottomNavWindowSync);
    window.visualViewport?.removeEventListener('resize', bottomNavWindowSync);
  }
  const nav = document.getElementById('bottom-nav');
  const sync = (): void => {
    const root = document.documentElement;
    if (!nav || nav.classList.contains('hidden') || getComputedStyle(nav).display === 'none') {
      root.style.setProperty('--bottom-nav-height', '0px');
      root.style.setProperty('--bottom-nav-bottom-offset', '0px');
      root.style.setProperty('--bottom-nav-content-inset', '0px');
      return;
    }
    const rect = nav.getBoundingClientRect();
    const height = Math.max(0, rect.height);
    const bottomOffset = Math.max(0, window.innerHeight - rect.bottom);
    root.style.setProperty('--bottom-nav-height', `${height}px`);
    root.style.setProperty('--bottom-nav-bottom-offset', `${bottomOffset}px`);
    root.style.setProperty('--bottom-nav-content-inset', `${calculateBottomNavigationContentInset(rect, window.innerHeight)}px`);
  };
  bottomNavWindowSync = sync;
  sync();
  if (nav && typeof ResizeObserver !== 'undefined') {
    bottomNavResizeObserver = new ResizeObserver(sync);
    bottomNavResizeObserver.observe(nav);
  }
  if (nav && typeof MutationObserver !== 'undefined') {
    bottomNavMutationObserver = new MutationObserver(sync);
    bottomNavMutationObserver.observe(nav, { attributes: true, attributeFilter: ['class', 'style'] });
  }
  window.addEventListener('resize', sync, { passive: true });
  window.visualViewport?.addEventListener('resize', sync, { passive: true });
}

function isAuthRoute(path = getCurrentRoutePath()): boolean {
  return AUTH_ROUTES.includes(path);
}

function isPublicRoute(path = getCurrentRoutePath()): boolean {
  return PUBLIC_ROUTES.some(route => path === route || path.startsWith(route + '/'));
}

const INITIAL_LOAD_PLAN: readonly InitialLoadTaskDefinition[] = [
  { id: 'bootstrap', task: 'bootstrap開始', weight: 4 },
  { id: 'auth-listener', task: '認証監視の開始', weight: 9 },
  { id: 'auth-resolved', task: '認証状態確定', weight: 18 },
  { id: 'profile', task: 'ユーザー情報確定', weight: 0, blocking: false },
  { id: 'notifications', task: '通知リスナー設定', weight: 0, blocking: false },
  { id: 'route', task: '初期ルート解析', weight: 7 },
  { id: 'page-request', task: '初期画面データ取得', weight: 30 },
  { id: 'page-data', task: '初期データ正規化', weight: 17 },
  { id: 'page-dom', task: '初期DOM反映', weight: 15 },
];

type InitialLoadGate = {
  unmount: () => void;
  setRetryHandler: (handler: () => void) => void;
};

function initialLoadGateMarkup(): string {
  return `
    <div class="initial-load-panel">
      <p class="initial-load-status" role="status" aria-live="polite">
        <span class="initial-load-message">読み込んでいます</span>
        <span class="initial-load-value">0%</span>
      </p>
      <div class="initial-load-track" role="progressbar" aria-label="読み込みの進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0%">
        <span class="initial-load-bar" style="width: 0%"></span>
      </div>
      <p class="initial-load-error" role="alert" hidden></p>
      <button class="initial-load-retry btn btn-primary" type="button" hidden>再試行</button>
    </div>
  `;
}

function initialLoadErrorMessage(code?: string): string {
  switch (code) {
    case 'NETWORK_ERROR': return 'ネットワークに接続できませんでした。';
    case 'TIMEOUT': return '読み込みがタイムアウトしました。';
    case 'AUTH_ERROR': return '認証状態を確認できませんでした。';
    case 'RATE_LIMIT': return 'アクセスが集中しています。時間をおいてください。';
    case 'SERVER_ERROR': return 'サーバーで問題が発生しました。';
    case 'ABORTED': return '読み込みを中止しました。';
    default: return '読み込みに失敗しました。';
  }
}

function mountInitialLoadGate(progress: InitialLoadProgress): InitialLoadGate {
  // Keep the established app surface unchanged during normal startup. The
  // progress overlay is opt-in for diagnostics only (?debugInitialLoad=1).
  if (!initialLoadDebugEnabled) {
    return { setRetryHandler: () => {}, unmount: () => {} };
  }
  const existing = document.getElementById('initial-load-gate');
  const gate = existing || document.createElement('section');
  gate.id = 'initial-load-gate';
  gate.className = 'initial-load-gate';
  gate.setAttribute('aria-label', 'Connectの読み込み状況');
  if (!gate.querySelector('.initial-load-panel')) gate.innerHTML = initialLoadGateMarkup();
  if (!existing) document.body.append(gate);

  const message = gate.querySelector<HTMLElement>('.initial-load-message');
  const valueLabel = gate.querySelector<HTMLElement>('.initial-load-value');
  const track = gate.querySelector<HTMLElement>('.initial-load-track');
  const bar = gate.querySelector<HTMLElement>('.initial-load-bar');
  const errorLabel = gate.querySelector<HTMLElement>('.initial-load-error');
  const retry = gate.querySelector<HTMLButtonElement>('.initial-load-retry');
  let retryHandler: (() => void) | null = null;
  const domTrace: Array<Record<string, unknown>> = [];
  retry?.addEventListener('click', () => {
    if (progress.getSnapshot().status === 'error') retryHandler?.();
  });

  const render = (snapshot: InitialLoadSnapshot): void => {
    const value = snapshot.displayProgress;
    const statusText = snapshot.status === 'error'
      ? '読み込みに失敗しました'
      : snapshot.status === 'complete'
        ? '読み込み完了'
        : snapshot.status === 'cancelled'
          ? '読み込みを中止しました'
          : '読み込んでいます';

    gate.dataset.status = snapshot.status;
    gate.dataset.task = snapshot.task;
    gate.dataset.rawProgress = String(snapshot.rawProgress);
    gate.dataset.displayProgress = String(snapshot.displayProgress);
    if (snapshot.errorCode) gate.dataset.errorCode = snapshot.errorCode;
    else delete gate.dataset.errorCode;
    gate.setAttribute('aria-busy', snapshot.status === 'loading' ? 'true' : 'false');
    message?.replaceChildren(statusText);
    valueLabel?.replaceChildren(`${value}%`);
    track?.setAttribute('aria-valuenow', String(value));
    track?.setAttribute('aria-valuetext', `${value}%`);
    if (bar) bar.style.width = `${value}%`;
    if (errorLabel) {
      errorLabel.hidden = snapshot.status !== 'error';
      errorLabel.textContent = snapshot.status === 'error' ? initialLoadErrorMessage(snapshot.errorCode) : '';
    }
    if (retry) retry.hidden = snapshot.status !== 'error';
    if (initialLoadDebugEnabled) {
      const traceWindow = window as typeof window & { __connectInitialLoadTrace?: Array<Record<string, unknown>> };
      const trace = traceWindow.__connectInitialLoadTrace || (traceWindow.__connectInitialLoadTrace = []);
      trace.push({
        task: snapshot.task,
        completedUnits: snapshot.completedUnits,
        totalUnits: snapshot.totalUnits,
        rawProgress: snapshot.rawProgress,
        displayProgress: snapshot.displayProgress,
        status: snapshot.status,
        duration: snapshot.duration,
        valueText: valueLabel?.textContent || '',
        barWidth: bar?.style.width || '',
      });
      if (trace.length > 200) trace.splice(0, trace.length - 200);
      domTrace.push({ value, status: snapshot.status, raw: snapshot.rawProgress, task: snapshot.task, barWidth: bar?.style.width || '' });
      if (domTrace.length > 200) domTrace.splice(0, domTrace.length - 200);
      document.body.dataset.initialLoadTrace = JSON.stringify(domTrace);
    }
  };

  const unsubscribe = progress.subscribe(render);
  return {
    setRetryHandler: (handler) => { retryHandler = handler; },
    unmount: () => {
      unsubscribe();
      gate.remove();
    },
  };
}

function nextPaint(): Promise<void> {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

async function unmountAfterCompletePaint(unmount: () => void): Promise<void> {
  // The first callback gives the completed 99% state a frame to paint. The
  // second callback removes the gate on the following paint opportunity.
  await nextPaint();
  await nextPaint();
  unmount();
}

function classifyInitialLoadError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'ABORTED';
  const candidate = error as { code?: unknown; name?: unknown; status?: unknown; message?: unknown } | null;
  const code = String(candidate?.code || candidate?.name || '').toLowerCase();
  const message = String(candidate?.message || error || '').toLowerCase();
  if (code.includes('abort') || message.includes('aborted')) return 'ABORTED';
  if (code.includes('timeout') || message.includes('timeout')) return 'TIMEOUT';
  if (code.includes('auth') || code.includes('unauth') || code.includes('permission-denied')) return 'AUTH_ERROR';
  if (Number(candidate?.status) === 429 || code.includes('resource-exhausted') || code.includes('rate')) return 'RATE_LIMIT';
  if (Number(candidate?.status) >= 500 || code.includes('unavailable') || code.includes('internal')) return 'SERVER_ERROR';
  if (code.includes('network') || message.includes('network') || message.includes('offline') || message.includes('failed to fetch')) return 'NETWORK_ERROR';
  return 'UNKNOWN';
}

function initialAbortError(): Error {
  const error = new Error('Initial loading session was aborted');
  error.name = 'AbortError';
  return error;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(initialAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(initialAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function renderAppShell(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('Missing #app root element');
  const currentUser = getState('user');
  const theme = getState('theme');
  document.getElementById('bottom-nav')?.remove();

  app.innerHTML = `
    <!-- ヘッダー -->
    <header id="header" class="header ${currentUser ? '' : 'hidden'}">
      <div class="header-inner">
        <a href="#/feed" class="header-logo" data-navigate>
          <img class="header-logo-icon" src="${APP_ICON_PATH}" alt="Connect">
          <span class="header-logo-text">Connect</span>
        </a>
        <div class="header-actions">
          <button id="theme-toggle-btn" class="header-icon-btn" title="${t('テーマ切替')}" aria-label="${t('テーマ切替')}">
            <span class="header-action-icon">${theme === 'light' ? '🌙' : '☀️'}</span>
            <span class="header-action-label">${t('テーマ')}</span>
          </button>
          <div id="account-controls" data-authenticated="${currentUser ? 'true' : 'false'}">${accountControlsMarkup(!!currentUser)}</div>
        </div>
      </div>
    </header>

    <!-- メインコンテンツ -->
    <main id="page-content" class="page-content"></main>

  `;

  // Mount the fixed tab bar directly under body so no application container can
  // become its containing block through transform, filter, or overflow styles.
  document.body.insertAdjacentHTML('beforeend', `
    <nav id="bottom-nav" class="bottom-nav ${currentUser ? '' : 'hidden'}">
      <a href="#/feed" class="nav-item" data-page="feed" data-navigate>
        <span class="nav-icon">🏠</span>
        <span class="nav-label">${t('ホーム')}</span>
      </a>
      <a href="#/explore" class="nav-item" data-page="explore" data-navigate>
        <span class="nav-icon">🔍</span>
        <span class="nav-label">${t('探す')}</span>
      </a>
      <a href="#/notifications" class="nav-item" data-page="notifications" data-navigate aria-label="${t('通知')}">
        <span class="nav-icon" aria-hidden="true">🔔</span>
        <span class="nav-label">${t('通知')}</span>
        <span class="nav-badge hidden" id="nav-notif-badge" aria-label="${t('未読の通知')}">0</span>
      </a>
      <a href="#/profile" class="nav-item" data-page="profile" data-navigate>
        <span class="nav-icon">👤</span>
        <span class="nav-label">${t('プロフィール')}</span>
      </a>
    </nav>
  `);
  trackBottomNavigationInset();

  // 言語トグル
  // テーマトグル
  document.getElementById('theme-toggle-btn')?.addEventListener('click', toggleTheme);

  // アクティブなナビゲーションをハイライト
  updateActiveNav();
  updateNotificationBadges(getState('unreadNotifications'));
}

function updateActiveNav(): void {
  const currentPath = window.location.hash.replace(/^#/, '') || '/feed';
  document.querySelectorAll<HTMLElement>('.nav-item').forEach(item => {
    const page = item.dataset.page;
    item.classList.toggle('active', currentPath.startsWith('/' + page) ||
      (page === 'feed' && currentPath === '/') ||
      (page === 'profile' && currentPath.startsWith('/profile')));
  });
}

// ============================================================
// ルート登録
// ============================================================

// Vercel's active entry is legacy/index.html -> src/main.ts. The current
// startup session is shared with the feed renderer so one progress source
// observes both bootstrap work and the initial feed's real data work.
let activeInitialLoadProgress: InitialLoadProgress | null = null;
let activeInitialLoadSessionId = 0;

registerRoute('/login', async () => {
  document.getElementById('header')?.classList.add('hidden');
  document.getElementById('bottom-nav')?.classList.add('hidden');
  await renderLoginPage();
  updateActiveNav();
});

registerRoute('/forgot-password', async () => {
  document.getElementById('header')?.classList.add('hidden');
  document.getElementById('bottom-nav')?.classList.add('hidden');
  await renderForgotPasswordPage();
  updateActiveNav();
});

registerRoute('/reset-password', async () => {
  document.getElementById('header')?.classList.add('hidden');
  document.getElementById('bottom-nav')?.classList.add('hidden');
  await renderResetPasswordPage();
  updateActiveNav();
});

registerRoute('/register', async () => {
  window.location.hash = '#/login';
});

registerRoute('/feed', async (_params, context) => {
  const user = getState('user');
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderFeedPage({
    initialLoad: activeInitialLoadProgress || undefined,
    initialLoadSessionId: activeInitialLoadSessionId,
    signal: context?.signal,
  });
  updateActiveNav();
});

registerRoute('/profile/:uid', async (params) => {
  const user = getState('user');
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderProfilePage(params);
  updateActiveNav();
});

registerRoute('/profile', async () => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  window.location.hash = `#/profile/${user.uid}`;
});

registerRoute('/u/:username', async (params) => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderUserMentionRedirectPage(params);
  updateActiveNav();
});

registerRoute('/friends', async () => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderFriendsPage();
  updateActiveNav();
});
registerRoute('/notifications', async () => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderNotificationsPage();
  updateActiveNav();
});

registerRoute('/settings', async () => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderSettingsPage();
  updateActiveNav();
});

registerRoute('/drafts', async () => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderDraftsPage();
  updateActiveNav();
});

registerRoute('/bookmarks', async () => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderBookmarksPage();
  updateActiveNav();
});
registerRoute('/post/:id', async (params) => {
  const user = getState('user');
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderPostDetailPage(params);
  updateActiveNav();
});

registerRoute('/explore', async () => {
  const user = getState('user');
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderExplorePage();
  updateActiveNav();
});

registerRoute('/explore/:tag', async (params) => {
  const tag = typeof params.tag === 'string' ? params.tag.replace(/^[#＃]/u, '') : '';
  window.location.hash = `#/explore?query=${encodeURIComponent(`#${tag}`)}&tab=posts`;
});

registerRoute('/admin/moderation', async () => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  let isAdmin = false;
  try {
    const currentUser = auth.currentUser;
    if (currentUser?.uid === user.uid) {
      const token = await currentUser.getIdTokenResult(true);
      isAdmin = token.claims.role === 'admin';
    }
  } catch { /* A failed role check keeps the route closed. */ }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  if (!isAdmin) {
    const page = document.getElementById('page-content');
    if (page) page.innerHTML = '<section class="empty-state" role="alert"><h1>管理者専用ページです</h1><p>投稿モデレーションを利用できるアカウントではありません。</p><a class="btn btn-primary" href="#/feed" data-navigate>フィードへ戻る</a></section>';
    updateActiveNav();
    return;
  }
  await renderAdminModerationPage();
  updateActiveNav();
});

registerRoute('/moderation-appeal/:postId', async (params) => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderModerationAppealPage(params);
  updateActiveNav();
});

registerRoute('/profile/:uid/followers', async (params) => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderFollowersPage(params);
  updateActiveNav();
});

registerRoute('/profile/:uid/following', async (params) => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderFollowingPage(params);
  updateActiveNav();
});

registerRoute('/profile/:uid/friends', async (params) => {
  const user = getState('user');
  if (!user) { navigateTo('/login'); return; }
  document.getElementById('header')?.classList.remove('hidden');
  document.getElementById('bottom-nav')?.classList.remove('hidden');
  await renderFriendsListPage(params);
  updateActiveNav();
});


async function renderRetiredDmRoute(): Promise<void> {
  // Keep old bookmarks deterministic without redirecting into another feature.
  // The page is intentionally static and never reads a conversation, message,
  // attachment, or notification payload.
  document.getElementById('header')?.classList.add('hidden');
  document.getElementById('bottom-nav')?.classList.add('hidden');
  const page = document.getElementById('page-content');
  if (!page) return;
  page.innerHTML = `
    <section class="empty-state retired-feature-page" role="status" aria-live="polite">
      <div class="empty-emoji" aria-hidden="true">💬</div>
      <h1>DM機能は提供終了しました</h1>
      <p>現在、Connectではダイレクトメッセージを提供していません。</p>
      <a class="btn btn-primary" href="#/feed" data-navigate>フィードへ戻る</a>
    </section>
  `;
}

// Keep already-issued bookmarks on an explicit retirement page. No active UI
// link or notification navigates to these compatibility-only routes.
registerRoute('/dm', renderRetiredDmRoute);
registerRoute('/dm/new', renderRetiredDmRoute);
registerRoute('/dm/:id', renderRetiredDmRoute);

// デフォルトルート
registerRoute('/?', async () => {
  navigateTo('/feed');
});

// 404
registerRoute('*', async () => {
  navigateTo('/feed');
});

// ============================================================
// アプリ初期化
// ============================================================

async function initApp() {
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof Error && event.reason.name === 'AbortError') {
      event.preventDefault();
      return;
    }
    const info = classifyStartupError(event.reason);
    console.error('Unhandled initial/client promise rejection', { errorType: info.kind, httpStatus: info.httpStatus });
  });

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get('mode') === 'resetPassword' && searchParams.get('oobCode')) {
    window.location.hash = `#/reset-password?oobCode=${encodeURIComponent(searchParams.get('oobCode'))}`;
  }

  document.title = getLocale() === 'ja' ? 'Connect - 友達とつながる新しいSNS' : 'Connect - A New Way to Connect';
  document.documentElement.setAttribute('lang', getLocale() === 'ja' ? 'ja' : 'en');

  // The static gate in legacy/index.html is already paintable. The shell does
  // not touch it because it lives outside #app.
  renderAppShell();
  const initialLoad = new InitialLoadProgress(INITIAL_LOAD_PLAN, {
    debug: initialLoadDebugEnabled,
  });
  activeInitialLoadProgress = initialLoad;
  const gate = mountInitialLoadGate(initialLoad);
  type InitialAuthReady = Promise<unknown> & { unsubscribe?: () => void };
  type InitialLoadRun = {
    generation: number;
    sessionId: number;
    controller: AbortController;
    authReady: InitialAuthReady | null;
    trace: StartupTraceSession;
    profileUid: string;
    profilePromise: Promise<void> | null;
    notificationUid: string;
    authVersion: number;
  };
  let generation = 0;
  let activeRun: InitialLoadRun | null = null;
  let closed = false;
  let backgroundServicesStarted = false;

  const isCurrentRun = (run: InitialLoadRun): boolean => activeRun === run
    && !run.controller.signal.aborted
    && initialLoad.getSessionId() === run.sessionId;
  const isCurrent = (run: InitialLoadRun): boolean => isCurrentRun(run)
    && initialLoad.getSnapshot().status === 'loading';

  const cleanupRun = (run: InitialLoadRun | null, emitCancellation = true): void => {
    run?.controller.abort();
    run?.authReady?.unsubscribe?.();
    if (emitCancellation) run?.trace.event('startup', 'cancelled', { endpointCategory: 'app-startup' });
    if (unsubscribeNotifications) unsubscribeNotifications();
    unsubscribeNotifications = null;
  };

  const setupNotifications = (firebaseUser: { uid: string }, run: InitialLoadRun): void => {
    if (!isCurrentRun(run)) return;
    if (run.notificationUid === firebaseUser.uid) return;
    run.notificationUid = firebaseUser.uid;
    if (unsubscribeNotifications) unsubscribeNotifications();
    const finish = run.trace.begin('notifications', { endpointCategory: 'firestore-notifications' });
    try {
      const notifQ = query(
        collection(db, 'notifications'),
        where('userId', '==', firebaseUser.uid),
        where('read', '==', false),
        where('type', 'in', [...ACTIVE_NOTIFICATION_TYPES]),
        limit(100),
      );
      unsubscribeNotifications = onSnapshot(notifQ, (snap) => {
        if (activeRun !== run) return;
        const count = snap.size;
        const prevCount = getState('unreadNotifications');
        setState('unreadNotifications', count);
        const toastShown = !!document.querySelector('.notif-toast');
        if (count > prevCount && !toastShown) {
          if (!document.querySelector('.notif-toast')) {
            const toast = document.createElement('div');
            toast.className = 'notif-toast';
            toast.textContent = t('新しい通知が届きました');
            toast.addEventListener('click', () => { window.location.hash = '#/notifications'; toast.remove(); });
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 4000);
          }
        }
      }, (error) => {
        const info = classifyStartupError(error);
        run.trace.event('notifications', 'error', { endpointCategory: 'firestore-notifications', errorType: info.kind, httpStatus: info.httpStatus });
      });
      finish?.('success');
    } catch (error) {
      const info = classifyStartupError(error);
      finish?.('error', { errorType: info.kind, httpStatus: info.httpStatus });
      console.error('Notification listener setup failed', { errorType: info.kind, httpStatus: info.httpStatus });
    }
  };

  const hydrateProfile = (firebaseUser: { uid: string; displayName?: string | null; email?: string | null; photoURL?: string | null }, run: InitialLoadRun, authVersion: number): void => {
    if (!isCurrentRun(run) || run.profileUid === firebaseUser.uid && run.profilePromise) return;
    if (getState('userProfile')?.uid && getState('userProfile')?.uid !== firebaseUser.uid) {
      setState('userProfile', null);
    }
    run.profileUid = firebaseUser.uid;
    const finish = run.trace.begin('profile-hydration', { endpointCategory: 'firestore-profile' });
    run.profilePromise = (async () => {
      const isCurrentUser = (): boolean => isCurrentRun(run) && run.authVersion === authVersion && getState('user')?.uid === firebaseUser.uid;
      try {
        await waitForInitialLoadDebugStep();
        let profile = await getDisplayUserProfile(firebaseUser.uid);
        if (!profile) {
          profile = await createUserProfile(firebaseUser.uid, {
            displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
            email: firebaseUser.email || '',
            photoURL: firebaseUser.photoURL || '',
          });
        }
        if (!isCurrentUser()) {
          finish?.('cancelled');
          return;
        }
        setState('userProfile', toStateUserProfile(profile));
        window.setTimeout(() => {
          if (isCurrentUser()) syncExistingPushSubscription().catch((): void => {});
        }, 0);
        finish?.('success');
      } catch (error) {
        const info = classifyStartupError(error);
        finish?.(info.kind === 'abort' ? 'cancelled' : 'error', { errorType: info.kind, httpStatus: info.httpStatus });
        if (info.kind !== 'abort') console.error('Profile hydration failed', { errorType: info.kind, httpStatus: info.httpStatus });
      }
    })();
  };

  const startLoad = async (waitForPaint: boolean): Promise<void> => {
    cleanupRun(activeRun);
    renderAppShell();
    const sessionId = initialLoad.restart();
    activeInitialLoadSessionId = sessionId;
    const run: InitialLoadRun = {
      generation: ++generation,
      sessionId,
      controller: new AbortController(),
      authReady: null,
      trace: startStartupTraceSession({ enabled: startupTraceEnabled() }),
      profileUid: '',
      profilePromise: null,
      notificationUid: '',
      authVersion: 0,
    };
    activeRun = run;
    const finishStartup = run.trace.begin('startup', { endpointCategory: 'app-startup' });
    // This is the only frame scheduling in startup. It lets the real 0% state
    // paint before auth, Firestore, and route work starts.
    if (waitForPaint) await nextPaint();
    if (!isCurrent(run)) return;
    if (!backgroundServicesStarted) {
      backgroundServicesStarted = true;
      // PWA registration is deliberately outside the measured startup work.
      void registerConnectServiceWorker().catch((): void => {});
    }

    try {
      initialLoad.completeTask('bootstrap', sessionId);
      initialLoad.startTask('auth-listener', sessionId);
      run.trace.event('auth-listener', 'start', { endpointCategory: 'firebase-auth' });
      const authReady = initAuthListener((firebaseUser) => {
        const startupStatus = initialLoad.getSnapshot().status;
        if (!isCurrentRun(run) || (startupStatus !== 'loading' && startupStatus !== 'complete')) return;
        const authVersion = ++run.authVersion;
        run.trace.event('auth-state', 'start', { endpointCategory: 'firebase-auth' });
        const authenticated = !!firebaseUser && !window.__SEEDING_IN_PROGRESS;
        syncAccountControls(authenticated);
        if (authenticated) {
          initialLoad.skipTask('profile', sessionId);
          initialLoad.skipTask('notifications', sessionId);
          document.getElementById('header')?.classList.remove('hidden');
          document.getElementById('bottom-nav')?.classList.remove('hidden');
          setupNotifications(firebaseUser, run);
          hydrateProfile(firebaseUser, run, authVersion);
          const currentPath = getCurrentRoutePath();
          if (isAuthRoute(currentPath) || currentPath === '/' || currentPath === '') navigateTo('/feed');
        } else {
          initialLoad.skipTask('profile', sessionId);
          initialLoad.skipTask('notifications', sessionId);
          run.profileUid = '';
          run.profilePromise = null;
          run.notificationUid = '';
          setState('userProfile', null);
          if (unsubscribeNotifications) unsubscribeNotifications();
          unsubscribeNotifications = null;
          // Public routes remain usable after a session expires. Keep the
          // header visible there so the login action is reachable; protected
          // routes still hide the shell before redirecting to login.
          const authPath = getCurrentRoutePath();
          const publicRoute = isPublicRoute(authPath);
          document.getElementById('header')?.classList.toggle('hidden', !publicRoute);
          document.getElementById('bottom-nav')?.classList.add('hidden');
          if (!isPublicRoute(authPath) && !['/login', '/forgot-password', '/reset-password'].includes(authPath)) navigateTo('/login');
        }
        run.trace.event('auth-state', 'success', { endpointCategory: 'firebase-auth' });
      }) as InitialAuthReady;
      run.authReady = authReady;
      initialLoad.completeTask('auth-listener', sessionId);
      run.trace.event('auth-listener', 'success', { endpointCategory: 'firebase-auth' });
      await initialLoad.runTask(
        'auth-resolved',
        () => withTimeout(authReady, 10000, run.controller.signal),
        sessionId,
      );
      if (!isCurrent(run)) throw initialAbortError();

      initialLoad.startTask('route', sessionId);
      await abortable(initRouter({
        throwInitialRouteError: true,
        isActive: () => isCurrentRun(run),
        onRouteStart: (path) => {
          run.trace.event('route', 'start', { endpointCategory: 'router' });
          initialLoad.startTask('page-request', sessionId);
          if (path !== '/feed') initialLoad.startTask('page-data', sessionId);
        },
        onRouteResolved: () => {
          initialLoad.completeTask('route', sessionId);
          run.trace.event('route', 'success', { endpointCategory: 'router' });
        },
        onRouteComplete: (path) => {
          if (path !== '/feed') {
            initialLoad.completeTask('page-request', sessionId);
            initialLoad.completeTask('page-data', sessionId);
            initialLoad.completeTask('page-dom', sessionId);
          }
        },
        onRouteAbort: () => run.trace.event('route', 'cancelled', { endpointCategory: 'router' }),
      }), run.controller.signal);
      if (!isCurrent(run)) throw initialAbortError();
      if (!initialLoad.complete()) throw new Error('INITIAL_LOAD_INCOMPLETE');
      await unmountAfterCompletePaint(gate.unmount);
      if (activeRun === run) {
        closed = true;
        activeInitialLoadProgress = null;
        activeInitialLoadSessionId = 0;
        clearStartupTraceSession(run.trace);
        finishStartup?.('success');
        window.removeEventListener('pagehide', onPageHide);
      }
    } catch (error) {
      if (!isCurrent(run)) return;
      const code = classifyInitialLoadError(error);
      const info = classifyStartupError(error);
      if (code === 'ABORTED') {
        finishStartup?.('cancelled', { errorType: info.kind });
        return;
      }
      finishStartup?.('error', { errorType: info.kind, httpStatus: info.httpStatus });
      console.error('Initial load failed', { code, errorType: info.kind, httpStatus: info.httpStatus });
      initialLoad.fail(code);
      cleanupRun(run, false);
    }
  };

  const onPageHide = (): void => {
    if (closed) return;
    cleanupRun(activeRun);
    initialLoad.cancel();
  };
  window.addEventListener('pagehide', onPageHide);
  gate.setRetryHandler(() => {
    if (initialLoad.getSnapshot().status === 'error') void startLoad(true);
  });

  bindPushServiceWorkerMessages();
  bindLazyVideoLoader();

  // State subscriptions are installed once; retry creates only a new load
  // session and never duplicates these listeners.
  onStateChange('theme', (theme) => {
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) setTextIfPresent(btn.querySelector('.header-action-icon'), theme === 'light' ? '🌙' : '☀️');
  });
  onStateChange('userProfile', (profile) => updateCurrentUserComposerAvatars(profile));
  onStateChange('unreadNotifications', (count) => updateNotificationBadges(count));
  window.addEventListener('hashchange', () => updateActiveNav());
  void startLoad(true);
}

function updateNotificationBadges(count: number): void {
  const navBadge = document.getElementById('nav-notif-badge');
  if (navBadge) {
    navBadge.textContent = String(count);
    navBadge.classList.toggle('hidden', count === 0);
  }
}

// アプリ起動
document.addEventListener('DOMContentLoaded', initApp);









