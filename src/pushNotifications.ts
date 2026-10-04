import { auth } from './firebase.ts';

type TokenUser = { getIdToken(forceRefresh?: boolean): Promise<string> };

function authenticatedUser(): TokenUser | null {
  return (auth as unknown as { currentUser: TokenUser | null }).currentUser;
}

export type PushPermission = NotificationPermission | 'unsupported';
export type PushSubscriptionState = 'subscribed' | 'unsubscribed' | 'expired' | 'unknown';
export type PushStatusCode =
  | 'unsupported'
  | 'ios-install-required'
  | 'unconfigured'
  | 'authentication-required'
  | 'denied'
  | 'default'
  | 'subscribed'
  | 'unsubscribed'
  | 'subscription-expired'
  | 'error';
export type PushStatus = {
  code: PushStatusCode;
  permission: PushPermission;
  subscription: PushSubscriptionState;
  deviceCount?: number;
  message: string;
};

class PushPipelineError extends Error {
  readonly stage: string;
  readonly safeCode: string;

  constructor(stage: string, safeCode: string, message: string) {
    super(message);
    this.name = 'PushPipelineError';
    this.stage = stage;
    this.safeCode = safeCode;
  }
}

const PUSH_OPERATION_TIMEOUT_MS = 10_000;
const PUSH_PERMISSION_TIMEOUT_MS = 30_000;
const PUSH_SUBSCRIBE_TIMEOUT_MS = 15_000;

let enablePushRun: Promise<PushStatus> | null = null;

function timed<T>(stage: string, operation: () => Promise<T> | T, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new PushPipelineError(stage, 'TIMEOUT', `Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(value => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

function isStandalone(): boolean {
  const standaloneMedia = typeof window !== 'undefined'
    ? window.matchMedia?.('(display-mode: standalone)')
    : null;
  return typeof window !== 'undefined'
    && (Boolean(standaloneMedia?.matches)
      || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function supportsWebPush(): boolean {
  return typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && window.isSecureContext !== false
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

function permissionState(): PushPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

function applicationServerKey(): ArrayBuffer | null {
  const value = String(import.meta.env.VITE_VAPID_PUBLIC_KEY || '').trim();
  if (!value || typeof atob !== 'function') return null;
  try {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const decoded = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    // An application server key is an uncompressed P-256 public key.
    if (bytes.length !== 65 || bytes[0] !== 4) return null;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

function isSubscriptionExpired(subscription: PushSubscription): boolean {
  const expirationTime = subscription.expirationTime;
  return typeof expirationTime === 'number' && expirationTime > 0 && expirationTime <= Date.now();
}

function hasSameApplicationServerKey(subscription: PushSubscription, expected: ArrayBuffer): boolean {
  const actual = subscription.options?.applicationServerKey;
  // Some browsers do not expose the key on an existing subscription. Keep
  // that subscription and let the server/provider be the compatibility check.
  if (!actual) return true;
  const actualBytes = new Uint8Array(actual);
  const expectedBytes = new Uint8Array(expected);
  return actualBytes.length === expectedBytes.length && actualBytes.every((byte, index) => byte === expectedBytes[index]);
}

async function authHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const user = authenticatedUser();
  if (!user) throw new Error('Authentication required');
  return {
    Authorization: `Bearer ${await user.getIdToken(forceRefresh)}`,
    'Content-Type': 'application/json',
  };
}

async function pushApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const request = async (forceRefresh: boolean): Promise<Response> => fetch(path, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(await authHeaders(forceRefresh)),
    },
  });
  let response = await request(false);
  if (response.status === 401) response = await request(true);
  return response;
}

/** Registering the SW does not request notification permission. */
export async function registerConnectServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) throw new Error('Service Worker unsupported');
  return navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!supportsWebPush()) throw new Error('Web Push unsupported');
  return registerConnectServiceWorker();
}

async function sendSubscription(method: 'POST' | 'DELETE', subscription: PushSubscription): Promise<void> {
  const response = await pushApiFetch('/api/push-subscriptions', {
    method,
    body: JSON.stringify({ subscription: subscription.toJSON() }),
    cache: 'no-store',
    keepalive: method === 'DELETE',
  });
  if (!response.ok && response.status !== 204) {
    throw new PushPipelineError('subscription-api', `HTTP_${response.status}`, `Push subscription request failed (${response.status})`);
  }
}

type RegisteredSubscriptionStatus = 'missing' | 'active' | 'stale' | 'disabled';

async function registeredDeviceState(subscription?: PushSubscription): Promise<{
  count?: number;
  registered?: boolean;
  subscriptionStatus?: RegisteredSubscriptionStatus;
}> {
  try {
    const response = subscription
      ? await pushApiFetch('/api/push-subscriptions', {
        method: 'POST',
        body: JSON.stringify({ action: 'status', endpoint: subscription.endpoint }),
        cache: 'no-store',
      })
      : await pushApiFetch('/api/push-subscriptions', { cache: 'no-store' });
    if (!response.ok) return {};
    const data = await response.json();
    return {
      ...(typeof data.count === 'number' ? { count: data.count } : {}),
      ...(typeof data.registered === 'boolean' ? { registered: data.registered } : {}),
      ...(['missing', 'active', 'stale', 'disabled'].includes(data.subscriptionStatus)
        ? { subscriptionStatus: data.subscriptionStatus as RegisteredSubscriptionStatus }
        : {}),
    };
  } catch {
    return {};
  }
}

function makeStatus(
  code: PushStatusCode,
  permission: PushPermission,
  subscription: PushSubscriptionState,
  message: string,
  deviceCount?: number,
): PushStatus {
  return { code, permission, subscription, message, ...(typeof deviceCount === 'number' ? { deviceCount } : {}) };
}

export async function getPushStatus(): Promise<PushStatus> {
  const permission = permissionState();
  if (isIos() && !isStandalone()) {
    return makeStatus('ios-install-required', permission, 'unknown', 'iPhone/iPadではSafariの共有メニューからホーム画面に追加し、ホーム画面のConnectから通知を設定してください');
  }
  if (!supportsWebPush()) {
    return makeStatus('unsupported', permission, 'unknown', 'このブラウザはWeb Pushに対応していません');
  }
  if (!applicationServerKey()) {
    return makeStatus('unconfigured', permission, 'unknown', 'Push通知はまだ環境設定されていません');
  }
  if (!authenticatedUser()) {
    return makeStatus('authentication-required', permission, 'unknown', '通知を設定するにはログインしてください');
  }
  if (permission === 'denied') {
    return makeStatus('denied', permission, 'unknown', 'ブラウザの通知設定でConnectを許可してください');
  }
  if (permission === 'default') {
    return makeStatus('default', permission, 'unsubscribed', '「通知をONにする」を押したときだけ通知許可を確認します');
  }
  try {
    const registration = await timed('status-sw-register', () => registerPushServiceWorker(), PUSH_OPERATION_TIMEOUT_MS);
    const subscription = await timed('status-get-subscription', () => registration.pushManager.getSubscription(), PUSH_OPERATION_TIMEOUT_MS);
    const deviceState = await timed(
      'status-registration-check',
      () => registeredDeviceState(subscription || undefined),
      PUSH_OPERATION_TIMEOUT_MS,
    );
    if (!subscription) return makeStatus('unsubscribed', permission, 'unsubscribed', 'この端末のPush通知はOFFです', deviceState.count);
    if (isSubscriptionExpired(subscription)) return makeStatus('subscription-expired', permission, 'expired', 'この端末のPush登録が期限切れです。もう一度ONにしてください', deviceState.count);
    if (deviceState.subscriptionStatus === 'disabled') {
      return makeStatus('unsubscribed', permission, 'unsubscribed', 'この端末のPush通知はOFFです', deviceState.count);
    }
    if (deviceState.subscriptionStatus === 'stale' || deviceState.subscriptionStatus === 'missing' || deviceState.registered === false) {
      return makeStatus('subscription-expired', permission, 'expired', 'この端末のPush登録が見つかりません。もう一度ONにしてください', deviceState.count);
    }
    if (deviceState.registered !== true) return makeStatus('error', permission, 'unknown', 'Push登録状態を確認できませんでした', deviceState.count);
    return makeStatus('subscribed', permission, 'subscribed', 'この端末のPush通知はONです', deviceState.count);
  } catch {
    return makeStatus('error', permission, 'unknown', '通知状態を確認できませんでした');
  }
}

async function enablePushNotificationsInternal(): Promise<PushStatus> {
  const permission = permissionState();
  if (isIos() && !isStandalone()) {
    return makeStatus('ios-install-required', permission, 'unknown', 'iPhone/iPadではSafariの共有メニューからホーム画面に追加し、ホーム画面のConnectから通知を設定してください');
  }
  if (!supportsWebPush()) {
    return makeStatus('unsupported', permission, 'unknown', 'このブラウザはWeb Pushに対応していません');
  }
  const key = applicationServerKey();
  if (!key) return makeStatus('unconfigured', permission, 'unknown', 'Push通知はまだ環境設定されていません');
  if (!authenticatedUser()) {
    return makeStatus('authentication-required', permission, 'unknown', '通知を設定するにはログインしてください');
  }
  if (permission === 'denied') {
    return makeStatus('denied', permission, 'unknown', 'ブラウザの通知設定でConnectを許可してください');
  }

  const granted = permission === 'granted'
    ? 'granted'
    : await timed('permission-request', () => Notification.requestPermission(), PUSH_PERMISSION_TIMEOUT_MS);
  if (granted !== 'granted') return getPushStatus();

  let registration = await timed('sw-register', () => registerPushServiceWorker(), PUSH_OPERATION_TIMEOUT_MS);
  registration = await timed('sw-ready', () => navigator.serviceWorker.ready, PUSH_OPERATION_TIMEOUT_MS);
  if (!registration.pushManager) {
    throw new PushPipelineError('push-manager-registration', 'UNAVAILABLE', 'registration.pushManager unavailable');
  }
  let subscription = await timed('push-get-subscription', () => registration.pushManager.getSubscription(), PUSH_OPERATION_TIMEOUT_MS);
  const serverState = subscription
    ? await timed('subscription-status', () => registeredDeviceState(subscription!), PUSH_OPERATION_TIMEOUT_MS)
    : {};
  const staleOnServer = serverState.subscriptionStatus === 'stale' || serverState.subscriptionStatus === 'missing';
  if (subscription && (isSubscriptionExpired(subscription) || !hasSameApplicationServerKey(subscription, key) || staleOnServer)) {
    await timed('subscription-api-delete', () => sendSubscription('DELETE', subscription!), PUSH_OPERATION_TIMEOUT_MS).catch((): void => {});
    await subscription.unsubscribe().catch((): boolean => false);
    subscription = null;
  }
  if (!subscription) subscription = await timed('push-subscribe', () => registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), PUSH_SUBSCRIBE_TIMEOUT_MS);
  // Keep the browser subscription so a refreshed token or a later retry can
  // register the exact same endpoint; do not create a second subscription.
  await timed('subscription-api', () => sendSubscription('POST', subscription!), PUSH_OPERATION_TIMEOUT_MS);
  return getPushStatus();
}

export function enablePushNotifications(): Promise<PushStatus> {
  if (enablePushRun) return enablePushRun;
  enablePushRun = enablePushNotificationsInternal().finally(() => {
    enablePushRun = null;
  });
  return enablePushRun;
}

export async function disablePushNotifications(): Promise<PushStatus> {
  if (!supportsWebPush()) return getPushStatus();
  const registration = await timed('disable-sw-registration', () => navigator.serviceWorker.getRegistration('/'), PUSH_OPERATION_TIMEOUT_MS);
  const subscription = await timed('disable-get-subscription', () => registration?.pushManager.getSubscription(), PUSH_OPERATION_TIMEOUT_MS);
  if (subscription) {
    await timed('disable-subscription-api', () => sendSubscription('DELETE', subscription), PUSH_OPERATION_TIMEOUT_MS).catch((): void => {});
    await timed('disable-unsubscribe', () => subscription.unsubscribe(), PUSH_OPERATION_TIMEOUT_MS).catch((): boolean => false);
  }
  return getPushStatus();
}

export async function syncExistingPushSubscription(): Promise<void> {
  if (!supportsWebPush() || Notification.permission !== 'granted' || !authenticatedUser()) return;
  if (isIos() && !isStandalone()) return;
  const key = applicationServerKey();
  if (!key) return;
  const registration = await registerPushServiceWorker();
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  if (isSubscriptionExpired(subscription) || !hasSameApplicationServerKey(subscription, key)) {
    await sendSubscription('DELETE', subscription).catch((): void => {});
    await subscription.unsubscribe().catch((): boolean => false);
    subscription = null;
  } else {
    const serverState = await registeredDeviceState(subscription);
    if (serverState.subscriptionStatus === 'active') {
      await sendSubscription('POST', subscription);
      return;
    }
    if (serverState.subscriptionStatus === 'disabled' || serverState.subscriptionStatus === undefined) return;
    await sendSubscription('DELETE', subscription).catch((): void => {});
    await subscription.unsubscribe().catch((): boolean => false);
    subscription = null;
  }
  // Permission was already granted by the user. Repair a provider-expired or
  // deleted server registration without opening a new permission prompt.
  const replacement = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await sendSubscription('POST', replacement);
}

export async function removeCurrentPushSubscriptionForLogout(): Promise<void> {
  if (!supportsWebPush() || !authenticatedUser()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await sendSubscription('DELETE', subscription).catch((): void => {});
  await subscription.unsubscribe().catch((): boolean => false);
}

export function bindPushServiceWorkerMessages(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'connect-push-subscription-changed') {
      void syncExistingPushSubscription().catch((): void => {});
    }
  });
}

export async function dispatchPushForNotification(notificationId: string): Promise<void> {
  if (!notificationId || !authenticatedUser()) return;
  await fetch('/api/push-dispatch', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ notificationId }),
    cache: 'no-store',
    keepalive: true,
  }).catch((): void => {});
}
