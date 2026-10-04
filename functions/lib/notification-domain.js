import crypto from 'node:crypto';

export const NOTIFICATION_TYPES = new Set([
  'like',
  'comment',
  'reply',
  'mention',
  'repost',
  'friend_request',
  'friend_accept',
  'dm',
  'friend_story',
  'story_reaction',
  'post_moderated',
  'story_reply',
]);

// Legacy values remain decodable for persisted history, but they are not
// active product capabilities and must never enter a new producer or push.
export const LEGACY_NOTIFICATION_TYPES = new Set([
  'dm',
  'story_reply',
  'space_start',
  'space_end',
  'space_speaker_request',
  'space_speaker_approved',
  'space_speaker_removed',
]);
export const ACTIVE_NOTIFICATION_TYPES = new Set([...NOTIFICATION_TYPES].filter(type => !LEGACY_NOTIFICATION_TYPES.has(type)));

export const PUSH_ENABLED_TYPES = new Set([
  'like',
  'comment',
  'reply',
  'mention',
  'repost',
  'friend_request',
  'friend_accept',
]);

export const NOTIFICATION_SCHEMA_VERSION = 1;
export const NOTIFICATION_PIPELINE_VERSION = 1;
export const PUSH_PAYLOAD_VERSION = 1;

export const PUSH_POLICY = Object.freeze({
  like: Object.freeze({ freshnessMs: 24 * 60 * 60 * 1000, ttlSeconds: 86400, urgency: 'normal' }),
  comment: Object.freeze({ freshnessMs: 24 * 60 * 60 * 1000, ttlSeconds: 86400, urgency: 'normal' }),
  reply: Object.freeze({ freshnessMs: 24 * 60 * 60 * 1000, ttlSeconds: 86400, urgency: 'normal' }),
  mention: Object.freeze({ freshnessMs: 24 * 60 * 60 * 1000, ttlSeconds: 86400, urgency: 'normal' }),
  repost: Object.freeze({ freshnessMs: 24 * 60 * 60 * 1000, ttlSeconds: 86400, urgency: 'normal' }),
  friend_request: Object.freeze({ freshnessMs: 24 * 60 * 60 * 1000, ttlSeconds: 86400, urgency: 'normal' }),
  friend_accept: Object.freeze({ freshnessMs: 24 * 60 * 60 * 1000, ttlSeconds: 86400, urgency: 'normal' }),
});

export function notificationTypeClass(type) {
  if (ACTIVE_NOTIFICATION_TYPES.has(type)) return 'active';
  if (LEGACY_NOTIFICATION_TYPES.has(type)) return 'legacy';
  return 'unknown';
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function canonicalize(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return value.normalize('NFC').trim();
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((result, key) => {
    const next = canonicalize(value[key]);
    if (next !== undefined) result[key] = next;
    return result;
  }, {});
}

export function requestHash(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function safeText(value, maxLength = 80) {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(normalized);
  return characters.length > maxLength
    ? `${characters.slice(0, Math.max(1, maxLength - 1)).join('')}…`
    : normalized;
}

export function notificationId({ type, actorId, recipientId, eventId }) {
  const raw = `${type}:${actorId}:${recipientId}:${eventId}`;
  return `${type}_${sha256(raw).slice(0, 48)}`;
}

export function notificationUrl(notification) {
  const type = String(notification?.type || '');
  if (['like', 'comment', 'reply', 'mention', 'repost'].includes(type) && notification?.postId) {
    const commentTarget = type === 'like' && notification?.commentId
      ? `?commentId=${encodeURIComponent(notification.commentId)}`
      : '';
    return `/#/post/${encodeURIComponent(notification.postId)}${commentTarget}`;
  }
  // Retired notification types are retained only so persisted records can be
  // classified. They never receive a destination or a visible push.
  if (LEGACY_NOTIFICATION_TYPES.has(type)) return '';
  if (['friend_request', 'friend_accept'].includes(type) && notification?.fromUserId) {
    return `/#/profile/${encodeURIComponent(notification.fromUserId)}`;
  }
  return '/#/notifications';
}

function actorLabel(notification) {
  return safeText(notification?.fromUserDisplayName || notification?.fromUserUsername || '誰か', 40) || '誰か';
}

export function notificationCopy(type, notification = {}) {
  const actor = actorLabel(notification);
  switch (type) {
    case 'like': return { title: 'Connect', body: `${actor}さんがあなたの${notification.commentId ? 'コメント' : '投稿'}にいいねしました` };
    case 'comment': return { title: 'Connect', body: `${actor}さんがコメントしました` };
    case 'reply': return { title: 'Connect', body: `${actor}さんがコメントに返信しました` };
    case 'mention': return { title: 'Connect', body: `${actor}さんがあなたをメンションしました` };
    case 'repost': return { title: 'Connect', body: `${actor}さんがあなたの投稿をリポストしました` };
    case 'friend_request': return { title: 'Connect', body: `${actor}さんから友達申請が届きました` };
    case 'friend_accept': return { title: 'Connect', body: `${actor}さんが友達申請を承認しました` };
    case 'friend_story': return { title: 'Connect', body: `${actor}さんが新しい近況を投稿しました` };
    case 'story_reaction': return { title: 'Connect', body: `${actor}さんがあなたのストーリーにリアクションしました` };
    case 'post_moderated': return { title: 'Connect', body: '投稿がコミュニティガイドラインにより削除されました' };
    case 'story_reply': return { title: 'Connect', body: `${actor}さんがストーリーに返信しました` };
    default: return { title: 'Connect', body: '新しい通知があります' };
  }
}

export function freshnessFor(type, createdAtMs = Date.now()) {
  const policy = PUSH_POLICY[type] || PUSH_POLICY.like;
  return {
    pushExpiresAtMs: createdAtMs + policy.freshnessMs,
    deliveryDeadlineMs: createdAtMs + policy.freshnessMs,
    webPushTtlSeconds: policy.ttlSeconds,
    urgency: policy.urgency,
  };
}

export function isFresh(notification, nowMs = Date.now()) {
  const rawExpiresAt = notification?.pushExpiresAtMs || notification?.pushExpiresAt || 0;
  const expiresAt = typeof rawExpiresAt?.toMillis === 'function'
    ? rawExpiresAt.toMillis()
    : Number(rawExpiresAt);
  return !expiresAt || expiresAt > nowMs;
}

export function buildPushPayload(notificationIdValue, notification, nowMs = Date.now()) {
  if (LEGACY_NOTIFICATION_TYPES.has(notification?.type)) {
    throw new Error('notification_type_retired');
  }
  const deepLink = notificationUrl(notification);
  const copy = notificationCopy(notification?.type, notification);
  const targetId = notification?.postId
    || notification?.conversationId
    || notification?.fromUserId
    || notificationIdValue;
  return {
    payloadVersion: PUSH_PAYLOAD_VERSION,
    title: copy.title,
    body: copy.body,
    url: deepLink,
    deepLink,
    tag: `connect-notification-${notificationIdValue}`,
    notificationId: notificationIdValue,
    recipientId: typeof notification?.userId === 'string' ? notification.userId : '',
    timestamp: nowMs,
    type: notification?.type || 'notification',
    targetId,
    icon: '/connect-icon-192.png',
    badge: '/connect-icon-192.png',
  };
}
