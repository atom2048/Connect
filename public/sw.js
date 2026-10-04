const DEFAULT_URL = '/#/notifications';
const LEGACY_NOTIFICATION_TYPES = new Set([
  'dm', 'story_reply', 'space_start', 'space_end',
  'space_speaker_request', 'space_speaker_approved', 'space_speaker_removed',
]);
const ACTIVE_NOTIFICATION_TYPES = new Set([
  'like', 'comment', 'reply', 'mention', 'repost', 'friend_request',
  'friend_accept', 'friend_story', 'story_reaction',
]);

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

function safeNotificationUrl(value) {
  try {
    const url = new URL(value || DEFAULT_URL, self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL(DEFAULT_URL, self.location.origin).href;
  } catch {
    return new URL(DEFAULT_URL, self.location.origin).href;
  }
}

function logPushDiagnostic(level, payload, stage, failureReason = null, pushResponseStatus = null) {
  if (typeof console === 'undefined' || typeof console[level] !== 'function') return;
  const notificationType = typeof payload?.type === 'string' && payload.type.length <= 64 ? payload.type : 'unknown';
  const recipientId = typeof payload?.recipientId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(payload.recipientId)
    ? payload.recipientId
    : null;
  console[level]('[Connect push]', {
    stage,
    notificationType,
    recipientId,
    subscriptionStatus: stage === 'push_received' || stage === 'show_notification' ? 'active' : 'not_observed',
    pushResponseStatus: Number.isFinite(Number(pushResponseStatus)) && Number(pushResponseStatus) > 0
      ? Number(pushResponseStatus)
      : null,
    failureReason,
  });
}

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = {};
    logPushDiagnostic('error', payload, 'parse_payload', 'push_payload_parse_failed');
  }
  const payloadVersion = Number(payload.payloadVersion || 0);
  // Missing version is the legacy payload shape and remains readable during
  // the worker rollout. Explicit unknown versions fall back safely.
  const supportedPayload = payloadVersion === 0 || payloadVersion === 1;
  const payloadType = typeof payload.type === 'string' ? payload.type : '';
  // New legacy/unknown pushes are intentionally silent. This prevents an
  // already-deployed old worker from creating a fresh DM affordance after the
  // feature has been retired.
  if (LEGACY_NOTIFICATION_TYPES.has(payloadType) || !ACTIVE_NOTIFICATION_TYPES.has(payloadType)) {
    logPushDiagnostic('warn', payload, 'validate_payload', 'unsupported_notification_type');
    event.waitUntil(Promise.resolve());
    return;
  }
  const url = supportedPayload ? safeNotificationUrl(payload.deepLink || payload.url) : new URL(DEFAULT_URL, self.location.origin).href;
  const notificationId = typeof payload.notificationId === 'string' ? payload.notificationId : '';
  logPushDiagnostic('info', payload, 'push_received');
  const showNotification = Promise.resolve().then(() => self.registration.showNotification(supportedPayload ? (payload.title || 'Connect') : 'Connect', {
    body: supportedPayload ? (payload.body || '新しい通知があります') : '新しい通知があります',
    icon: payload.icon || '/connect-icon-192.png',
    badge: payload.badge || '/connect-icon-192.png',
    tag: notificationId ? `connect-notification-${notificationId}` : (payload.tag || 'connect-notification'),
    renotify: false,
    timestamp: Number(payload.timestamp) || Date.now(),
    data: {
      url,
      deepLink: url,
      payloadVersion,
      notificationId,
      type: payloadType,
      targetId: supportedPayload ? (payload.targetId || '') : '',
      recipientId: typeof payload.recipientId === 'string' ? payload.recipientId : '',
    },
  })).catch(() => {
    logPushDiagnostic('error', payload, 'show_notification', 'show_notification_failed');
    throw new Error('show_notification_failed');
  });
  event.waitUntil(showNotification);
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const notificationType = event.notification.data?.type || '';
  // A legacy DM/story-reply notification may still exist on a device from an
  // older service worker. Close it without opening any application route.
  if (LEGACY_NOTIFICATION_TYPES.has(notificationType)) {
    event.waitUntil(Promise.resolve());
    return;
  }
  const targetUrl = safeNotificationUrl(event.notification.data?.deepLink || event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      try {
        if ('navigate' in client) await client.navigate(targetUrl);
        return await client.focus();
      } catch {
        // Try another existing window before opening a new one.
      }
    }
    try {
      return await self.clients.openWindow(targetUrl);
    } catch {
      logPushDiagnostic('error', event.notification.data, 'notification_click', 'notification_navigation_failed');
      throw new Error('notification_navigation_failed');
    }
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    windows.forEach(client => client.postMessage({ type: 'connect-push-subscription-changed' }));
  }));
});
