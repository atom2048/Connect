import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock } = vi.hoisted(() => ({
  authMock: { currentUser: null as null | { getIdToken: ReturnType<typeof vi.fn> } },
}));

vi.mock('../src/firebase.ts', () => ({ auth: authMock }));

const { getPushStatus } = await import('../src/pushNotifications.ts');
const endpoint = 'https://push.example.test/subscription-token';
const vapidKey = Buffer.from([4, ...new Array<number>(64).fill(0)]).toString('base64url');

function makeSubscription(): PushSubscription {
  return {
    endpoint,
    expirationTime: null,
    options: { applicationServerKey: null },
  } as unknown as PushSubscription;
}

describe('getPushStatus', () => {
  let notification: { permission: NotificationPermission; requestPermission: ReturnType<typeof vi.fn> };
  let serviceWorker: { register: ReturnType<typeof vi.fn>; getRegistration: ReturnType<typeof vi.fn> };
  let fakeWindow: Record<string, unknown>;
  let fakeNavigator: Record<string, unknown>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let apiResponse: Response;

  beforeEach(() => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', vapidKey);
    authMock.currentUser = { getIdToken: vi.fn().mockResolvedValue('test-token') };
    notification = { permission: 'granted', requestPermission: vi.fn() };
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(makeSubscription()) } };
    serviceWorker = {
      register: vi.fn().mockResolvedValue(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
    };
    fakeWindow = {
      isSecureContext: true,
      matchMedia: () => ({ matches: false }),
      PushManager: {},
      Notification: notification,
      setTimeout: (callback: TimerHandler, delay?: number) => globalThis.setTimeout(callback, delay),
      clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    };
    fakeNavigator = {
      userAgent: 'Test browser',
      platform: 'Test',
      maxTouchPoints: 0,
      serviceWorker,
    };
    apiResponse = new Response(JSON.stringify({ count: 1, registered: true, subscriptionStatus: 'active' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    fetchMock = vi.fn().mockImplementation(async () => apiResponse);
    vi.stubGlobal('window', fakeWindow as unknown as Window);
    vi.stubGlobal('navigator', fakeNavigator as unknown as Navigator);
    vi.stubGlobal('Notification', notification as unknown as typeof Notification);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports this browser registered only when its endpoint is active on the account', async () => {
    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'subscribed', subscription: 'subscribed', deviceCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/push-subscriptions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'status', endpoint });
  });

  it('does not infer this browser is registered from another account device', async () => {
    const registration = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } };
    serviceWorker.register.mockResolvedValueOnce(registration);
    apiResponse = new Response(JSON.stringify({ count: 1 }), { status: 200 });

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'unsubscribed', subscription: 'unsubscribed', deviceCount: 1 });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBeUndefined();
  });

  it('keeps an unknown current-browser status unknown when a 200 response only has the account count', async () => {
    apiResponse = new Response(JSON.stringify({ count: 1 }), { status: 200 });

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'error', subscription: 'unknown', deviceCount: 1 });
  });

  it('distinguishes an unregistered local endpoint from an active endpoint on another device', async () => {
    apiResponse = new Response(JSON.stringify({
      count: 1,
      registered: false,
      subscriptionStatus: 'missing',
    }), { status: 200 });

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'subscription-expired', subscription: 'expired', deviceCount: 1 });
  });

  it('reports API failures as errors rather than treating a positive account count as success', async () => {
    apiResponse = new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 });

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'error', subscription: 'unknown' });
  });

  it('reports denied permission without querying or prompting again', async () => {
    notification.permission = 'denied';

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'denied', permission: 'denied' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });

  it('reports PushManager unsupported without querying the API', async () => {
    delete fakeWindow.PushManager;

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'unsupported', subscription: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports Service Worker unsupported without querying the API', async () => {
    delete fakeNavigator.serviceWorker;

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'unsupported', subscription: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a failed Service Worker registration in the error state', async () => {
    serviceWorker.register.mockRejectedValueOnce(new Error('registration failed'));

    const status = await getPushStatus();

    expect(status).toMatchObject({ code: 'error', subscription: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
