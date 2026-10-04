import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock } = vi.hoisted(() => ({
  authMock: { currentUser: { getIdToken: vi.fn() } as { getIdToken: ReturnType<typeof vi.fn> } | null },
}));

vi.mock('../src/firebase.ts', () => ({ auth: authMock }));

const { enablePushNotifications, getPushStatus } = await import('../src/pushNotifications.ts');

const vapidKey = Buffer.from([4, ...new Array<number>(64).fill(0)]).toString('base64url');

describe('Push notification timeouts', () => {
  let notification: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
  let serviceWorker: { register: ReturnType<typeof vi.fn>; getRegistration: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', vapidKey);
    authMock.currentUser = { getIdToken: vi.fn().mockResolvedValue('test-token') };
    notification = { permission: 'granted', requestPermission: vi.fn() };
    serviceWorker = { register: vi.fn(), getRegistration: vi.fn() };
    const fakeWindow = {
      isSecureContext: true,
      matchMedia: () => ({ matches: false }),
      PushManager: {},
      Notification: notification,
      setTimeout: (callback: TimerHandler, delay?: number) => globalThis.setTimeout(callback, delay),
      clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    };
    const fakeNavigator = { userAgent: 'Test browser', platform: 'Test', maxTouchPoints: 0, serviceWorker };
    vi.stubGlobal('window', fakeWindow as unknown as Window);
    vi.stubGlobal('navigator', fakeNavigator as unknown as Navigator);
    vi.stubGlobal('Notification', notification as unknown as typeof Notification);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns an error status when service worker registration does not settle', async () => {
    serviceWorker.register.mockReturnValue(new Promise(() => {}));

    const pending = getPushStatus();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toMatchObject({ code: 'error', subscription: 'unknown' });
  });

  it('times out a notification permission prompt and lets the settings UI offer retry', async () => {
    notification.permission = 'default';
    notification.requestPermission.mockReturnValue(new Promise(() => {}));

    const pending = enablePushNotifications();
    const rejection = expect(pending).rejects.toMatchObject({ stage: 'permission-request', safeCode: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });
});
