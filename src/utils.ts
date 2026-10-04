type FirebaseLikeError = {
  code?: unknown;
  message?: unknown;
};

type TimestampLike = Date | string | number | { toDate: () => Date } | null | undefined;

function getErrorShape(error: unknown): FirebaseLikeError {
  return typeof error === 'object' && error !== null ? error as FirebaseLikeError : {};
}

export function escapeHtml(text: unknown): string {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

/** Hide the legacy button-label value that was mistakenly stored as a bio. */
export function normalizeProfileBio(value: unknown): string {
  const bio = typeof value === 'string' ? value.trim() : '';
  return bio === 'プロフィールを見る' ? '' : bio;
}

function hasToDate(value: unknown): value is { toDate: () => Date } {
  return typeof value === 'object' && value !== null && typeof (value as { toDate?: unknown }).toDate === 'function';
}

function normalizeDate(timestamp: TimestampLike): Date | null {
  if (!timestamp) return null;
  const raw = hasToDate(timestamp) ? timestamp.toDate() : timestamp;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(timestamp: TimestampLike): string {
  const date = normalizeDate(timestamp);
  if (!date) return '';
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}年${m}月${d}日 ${h}:${min}`;
}

export function formatRelativeTime(timestamp: TimestampLike): string {
  const date = normalizeDate(timestamp);
  if (!date) return 'たった今';
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  if (diffSec < 60) return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  if (diffHour < 24) return `${diffHour}時間前`;
  if (diffDay === 1) return '昨日';
  return `${diffDay}日前`;
}

export function truncateText(text: string | null | undefined, maxLen = 200): string {
  if (!text || text.length <= maxLen) return text || '';
  return `${text.slice(0, maxLen)}...`;
}

export function getInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]?.charAt(0).toUpperCase() || '?';
  return `${parts[0]?.charAt(0) || ''}${parts[parts.length - 1]?.charAt(0) || ''}`.toUpperCase() || '?';
}

export function generateAvatarColor(name: string | null | undefined): string {
  if (!name) return '#6366f1';
  const colors = [
    '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e', '#ef4444', '#f97316',
    '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
    '#3b82f6', '#2563eb', '#7c3aed', '#db2777',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length] || '#6366f1';
}

export function getFirebaseErrorMessage(error: unknown): string {
  const err = getErrorShape(error);
  const code = typeof err.code === 'string' ? err.code : '';
  const messages: Record<string, string> = {
    'auth/user-not-found': 'ユーザーが見つかりません',
    'auth/wrong-password': 'パスワードが間違っています',
    'auth/invalid-credential': 'メールアドレスまたはパスワードが正しくありません。パスワードを忘れた場合は、再設定してください。',
    'auth/invalid-login-credentials': 'メールアドレスまたはパスワードが正しくありません。パスワードを忘れた場合は、再設定してください。',
    'auth/email-already-in-use': 'このメールアドレスは既に使用されています',
    'auth/weak-password': 'パスワードは6文字以上にしてください',
    'auth/invalid-email': '有効なメールアドレスを入力してください',
    'auth/user-disabled': 'このアカウントは無効化されています',
    'auth/too-many-requests': 'ログイン試行回数が多すぎます。しばらく待ってから再試行してください',
    'auth/unauthorized-continue-uri': 'このサイトの再設定URLがFirebaseで許可されていません。Firebase公式の再設定メールに切り替えて送信します',
    'auth/expired-action-code': '再設定URLの有効期限が切れています。もう一度メールを送信してください',
    'auth/invalid-action-code': '再設定URLが無効です。メールのリンクを開き直すか、もう一度送信してください',
    'auth/operation-not-allowed': 'このログイン方法は現在利用できません',
    'auth/network-request-failed': '認証サービスに接続できません。通信状態を確認して、もう一度お試しください。',
    'auth/invalid-api-key': '認証設定を読み込めませんでした。しばらくしてから再読み込みしてください。',
    'auth/popup-closed-by-user': 'ログインがキャンセルされました',
    'auth/credential-already-in-use': 'この認証情報は既に使用されています',
    'auth/account-exists-with-different-credential': '同じメールアドレスで別のログイン方法が登録されています',
    'auth/configuration-not-found': '認証の設定が完了していません。Firebase Console → Authentication → Sign-in method で「メール/パスワード」と「Google」を有効にしてください。',
    'permission-denied': 'アクセス権限がありません',
    unavailable: 'ネットワークエラーが発生しました',
  };
  return messages[code] || (typeof err.message === 'string' ? err.message : 'エラーが発生しました');
}

export function getFirestoreIndexUrl(error: unknown): string | null {
  const err = getErrorShape(error);
  const msg = typeof err.message === 'string' ? err.message : '';
  const match = msg.match(/https:\/\/console\.firebase\.google\.com[^\s]*/);
  return match ? match[0] : null;
}

export function isIndexError(error: unknown): boolean {
  const err = getErrorShape(error);
  return (typeof err.message === 'string' ? err.message : '').includes('requires an index');
}
