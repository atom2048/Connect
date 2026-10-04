import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('push service worker', () => {
  it('contains push delivery and existing-window deep-link navigation', async () => {
    const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain("addEventListener('notificationclick'");
    expect(source).toContain("addEventListener('install'");
    expect(source).toContain("addEventListener('activate'");
    expect(source).toContain("addEventListener('pushsubscriptionchange'");
    expect(source).toContain("type: 'window'");
    expect(source).toContain('client.navigate(targetUrl)');
    expect(source).toContain('clients.openWindow(targetUrl)');
    expect(source).toContain('self.location.origin');
    expect(source).toContain('payload.deepLink || payload.url');
    expect(source).toContain('self.clients.claim()');
  });

  it('shows a notification and focuses an existing Connect window on its deep link', async () => {
    const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
    const handlers = new Map();
    const shown = [];
    const navigated = [];
    const client = {
      navigate: async url => { navigated.push(url); },
      focus: async () => undefined,
    };
    const self = {
      location: { origin: 'https://connect.test' },
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: () => Promise.resolve(),
      clients: {
        claim: () => Promise.resolve(),
        matchAll: async () => [client],
        openWindow: async url => { navigated.push(`opened:${url}`); },
      },
      registration: {
        showNotification: async (title, options) => { shown.push({ title, options }); },
      },
    };
    vm.runInNewContext(source, { self, URL, Date });

    let pushPromise;
    handlers.get('push')({
      data: { json: () => ({ notificationId: 'notification-1', title: 'Connect', body: '山田さんがいいねしました', deepLink: '/#/post/post-1', type: 'like', targetId: 'post-1' }) },
      waitUntil: promise => { pushPromise = promise; },
    });
    await pushPromise;
    expect(shown[0].options.data.deepLink).toBe('https://connect.test/#/post/post-1');
    expect(shown[0].options.data.targetId).toBe('post-1');
    expect(shown[0].options.tag).toBe('connect-notification-notification-1');
    expect(shown[0].options.renotify).toBe(false);

    let clickPromise;
    handlers.get('notificationclick')({
      notification: {
        data: shown[0].options.data,
        close: () => undefined,
      },
      waitUntil: promise => { clickPromise = promise; },
    });
    await clickPromise;
    expect(navigated).toEqual(['https://connect.test/#/post/post-1']);
  });

  it('falls back safely for an unknown payload version', async () => {
    const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
    const handlers = new Map();
    const shown = [];
    const self = {
      location: { origin: 'https://connect.test' },
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve(), matchAll: async () => [], openWindow: async () => undefined },
      registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    };
    vm.runInNewContext(source, { self, URL, Date });
    let pushPromise;
    handlers.get('push')({
      data: { json: () => ({ payloadVersion: 99, title: '偽のタイトル', body: '偽の本文', deepLink: '/#/post/private' }) },
      waitUntil: promise => { pushPromise = promise; },
    });
    await pushPromise;
    expect(shown).toHaveLength(0);
  });

  it('logs showNotification failures with safe delivery context and no raw error detail', async () => {
    const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
    const handlers = new Map();
    const errors = [];
    const self = {
      location: { origin: 'https://connect.test' },
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve(), matchAll: async () => [], openWindow: async () => undefined },
      registration: { showNotification: async () => { throw new Error('sensitive provider response'); } },
    };
    const consoleMock = {
      info: () => undefined,
      warn: () => undefined,
      error: (...args) => errors.push(args),
    };
    vm.runInNewContext(source, { self, URL, Date, console: consoleMock });

    let pushPromise;
    handlers.get('push')({
      data: { json: () => ({ notificationId: 'notification-1', type: 'reply', recipientId: 'recipient-b', postId: 'post-1' }) },
      waitUntil: promise => { pushPromise = promise; },
    });
    await expect(pushPromise).rejects.toThrow('show_notification_failed');
    expect(errors[0][1]).toMatchObject({
      stage: 'show_notification',
      notificationType: 'reply',
      recipientId: 'recipient-b',
      subscriptionStatus: 'active',
      pushResponseStatus: null,
      failureReason: 'show_notification_failed',
    });
    expect(JSON.stringify(errors)).not.toContain('sensitive provider response');
  });
});
