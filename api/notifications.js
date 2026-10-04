import { Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './_firebase-admin.js';
import { setApiHeaders, verifyFirebaseUser } from './_auth.js';
import { validateNotificationSource } from './_notification-validation.js';
import {
  NOTIFICATION_PIPELINE_VERSION,
  NOTIFICATION_SCHEMA_VERSION,
  ACTIVE_NOTIFICATION_TYPES,
  LEGACY_NOTIFICATION_TYPES,
  PUSH_ENABLED_TYPES,
  PUSH_PAYLOAD_VERSION,
  freshnessFor,
  notificationCopy,
  notificationId,
  notificationUrl,
  safeText,
} from '../functions/lib/notification-domain.js';

const CLIENT_NOTIFICATION_FIELDS = new Set([
  'type',
  'userId',
  'eventId',
  'postId',
  'commentId',
  'storyId',
  'conversationId',
  'messageId',
  'threadId',
  'context',
  'reactionType',
]);

function textField(value, maxLength = 200) {
  const text = safeText(value, maxLength);
  return text || '';
}

function normalizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  const result = {};
  for (const field of CLIENT_NOTIFICATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) result[field] = body[field];
  }
  return result;
}

function validId(value, maxLength = 180) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function logNotificationRecord(event, input, failureReason = null) {
  const write = failureReason ? console.error : console.info;
  const notificationType = typeof input?.type === 'string' && /^[a-z_]{1,64}$/.test(input.type)
    ? input.type
    : 'unknown';
  const recipientId = typeof input?.userId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(input.userId)
    ? input.userId
    : null;
  write(JSON.stringify({
    event,
    notificationType,
    recipientId,
    subscriptionStatus: 'not_checked',
    pushResponseStatus: null,
    failureReason,
  }));
}

function deriveEventId(input, actorId) {
  if (validId(input.eventId)) return input.eventId;
  if (input.type === 'friend_story' && validId(input.storyId)) return `${input.storyId}_${input.userId}`;
  if (input.type === 'story_reaction' && validId(input.storyId)) return `${input.storyId}_${actorId}_${textField(input.reactionType || input.context, 32) || '_'}`;
  return '';
}

function copyProfile(data, userId) {
  return {
    fromUserId: userId,
    fromUserDisplayName: textField(data?.displayName, 80),
    fromUserUsername: textField(data?.username, 80),
    fromUserPhotoURL: textField(data?.profilePhotoPreviewURL || data?.photoURL || data?.profileImage, 2048),
    fromUserAvatarColor: textField(data?.avatarColor, 32),
  };
}

async function friendshipExists(actorId, recipientId) {
  const id = [actorId, recipientId].sort().join('_');
  const snap = await adminDb.doc(`friendships/${id}`).get();
  return snap.exists && snap.data()?.status === 'accepted';
}

function validateInput(input) {
  if (!input || typeof input !== 'object') return 'invalid_body';
  if (!validId(input.type, 64) || !validId(input.userId, 160)) return 'invalid_type_or_recipient';
  if (input.type.length > 64) return 'invalid_type';
  for (const field of ['eventId', 'postId', 'commentId', 'storyId', 'conversationId', 'messageId']) {
    if (input[field] !== undefined && input[field] !== null && !validId(input[field])) return `invalid_${field}`;
  }
  return '';
}

export default async function handler(req, res) {
  setApiHeaders(res, 'POST');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let user;
  try {
    user = await verifyFirebaseUser(req);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const input = normalizeBody(req.body);
  const validationError = validateInput(input);
  if (validationError) {
    logNotificationRecord('notification_record_rejected', input, validationError);
    return res.status(400).json({ error: validationError });
  }
  if (input.userId === user.sub) return res.status(400).json({ error: 'Self notification is not allowed' });
  if (LEGACY_NOTIFICATION_TYPES.has(input.type)) {
    return res.status(410).json({ error: 'FEATURE_DISABLED', feature: 'retired_notification' });
  }
  if (!ACTIVE_NOTIFICATION_TYPES.has(input.type)) {
    return res.status(422).json({ error: 'INVALID_NOTIFICATION_TYPE' });
  }
  input.eventId = deriveEventId(input, user.sub);
  if (!input.eventId) return res.status(400).json({ error: 'eventId is required' });

  const sourceValidation = await validateNotificationSource(adminDb, user.sub, {
    ...input,
    fromUserId: user.sub,
  });
  if (!sourceValidation.valid) {
    logNotificationRecord('notification_record_rejected', input, sourceValidation.reason || 'invalid_source');
    return res.status(403).json({ error: 'Notification source is not valid', reason: sourceValidation.reason });
  }

  if (input.type === 'friend_story' && !(await friendshipExists(user.sub, input.userId))) {
    return res.status(403).json({ error: 'Recipient is not an accepted friend' });
  }

  const profileSnapshot = await adminDb.doc(`users/${user.sub}`).get();
  const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
  const now = Timestamp.now();
  const freshness = freshnessFor(input.type, now.toMillis());
  const id = notificationId({ type: input.type, actorId: user.sub, recipientId: input.userId, eventId: input.eventId });
  const ref = adminDb.collection('notifications').doc(id);
  const notificationBase = {
    ...copyProfile(profile, user.sub),
    userId: input.userId,
    type: input.type,
    eventId: input.eventId,
    postId: input.postId || null,
    commentId: input.commentId || null,
    storyId: input.storyId || null,
    conversationId: input.conversationId || null,
    messageId: input.messageId || null,
    threadId: input.threadId || null,
    reactionType: input.reactionType ? textField(input.reactionType, 32) : null,
    context: textField(input.context, 160),
    deepLink: notificationUrl({ ...input, fromUserId: user.sub }),
    ...freshness,
    pushEnabled: PUSH_ENABLED_TYPES.has(input.type),
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    pipelineVersion: NOTIFICATION_PIPELINE_VERSION,
    payloadVersion: PUSH_PAYLOAD_VERSION,
    read: false,
    createdAt: now,
    updatedAt: now,
  };
  const copy = notificationCopy(input.type, notificationBase);
  const notification = { ...notificationBase, title: copy.title, body: copy.body };

  let created;
  try {
    created = await adminDb.runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (existing.exists) return false;
      transaction.create(ref, notification);
      return true;
    });
  } catch {
    logNotificationRecord('notification_record_failed', input, 'firestore_write_failed');
    return res.status(500).json({ error: 'Notification could not be saved' });
  }
  logNotificationRecord(created ? 'notification_record_created' : 'notification_record_duplicate', input);
  return res.status(202).json({
    notificationId: id,
    created,
    deliveryStatus: created ? 'awaiting_firestore_trigger' : 'already_exists',
    pushEnabled: notification.pushEnabled,
  });
}
