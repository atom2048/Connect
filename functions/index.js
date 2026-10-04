import { FieldPath, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import { CloudTasksClient } from '@google-cloud/tasks';
import { logger } from 'firebase-functions';
import { onDocumentCreated, onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import webpush from 'web-push';
import { materializeCommentLikeNotification } from './lib/comment-like-notification.js';
import {
  NOTIFICATION_PIPELINE_VERSION,
  NOTIFICATION_SCHEMA_VERSION,
  ACTIVE_NOTIFICATION_TYPES,
  LEGACY_NOTIFICATION_TYPES,
  PUSH_ENABLED_TYPES,
  PUSH_PAYLOAD_VERSION,
  PUSH_POLICY,
  buildPushPayload,
  freshnessFor,
  notificationCopy,
  notificationUrl,
  safeText,
  sha256,
} from './lib/notification-domain.js';
import { didSearchProjectionChange } from './lib/search-index.js';
import { syncPostSearchIndex } from './lib/search-sync.js';
import { validateNotificationSource } from './lib/source-validation.js';
import {
  DELIVERY_TERMINAL_STATUSES,
  deliveryRecoveryEligible,
  flattenDeliveryQuerySnapshots,
  normalizeSecretValue,
  providerStatusCode,
  taskGenerationMatches,
} from './lib/delivery-state.js';

if (getApps().length === 0) initializeApp();
const db = getFirestore();
const tasks = new CloudTasksClient();
const VAPID_PUBLIC_KEY_SECRET = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY_SECRET = defineSecret('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT_SECRET = defineSecret('VAPID_SUBJECT');
const WORKER_SERVICE_ACCOUNT_PARAM = defineString('WORKER_SERVICE_ACCOUNT');

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || process.env.FIREBASE_PROJECT_ID || 'connect-b5e82';
const REGION = process.env.FIREBASE_FUNCTIONS_REGION || 'asia-northeast1';
const QUEUE_LOCATION = process.env.CLOUD_TASKS_LOCATION || REGION;
const PUSH_QUEUE = process.env.PUSH_DELIVERY_QUEUE || 'push-delivery';
const FUNCTIONS_BASE_URL = process.env.FUNCTIONS_BASE_URL || `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;
const PUSH_SENDER_MODE = ['gcp', 'legacy', 'disabled'].includes(process.env.PUSH_SENDER_MODE)
  ? process.env.PUSH_SENDER_MODE
  : 'gcp';
const TASK_GRACE_MS = 5 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const MAX_SUBSCRIPTION_PAGE = 50;
const MAX_DELIVERY_ATTEMPTS = 8;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DELIVERY_RECOVERY_SCAN_LIMIT = 100;
const DELIVERY_CLOCK_MARGIN_MS = 2 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function workerServiceAccount() {
  try {
    return (process.env.WORKER_SERVICE_ACCOUNT || WORKER_SERVICE_ACCOUNT_PARAM.value() || '').trim();
  } catch {
    return (process.env.WORKER_SERVICE_ACCOUNT || '').trim();
  }
}

function safeFailureReason(error, fallback = 'notification_pipeline_failed') {
  const providerStatus = providerStatusCode(error);
  if (providerStatus) return `provider_${providerStatus}`;
  if (error?.message === 'worker_identity_not_configured') return error.message;
  if (typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(error.code)) return error.code;
  if (typeof error?.code === 'number' && Number.isFinite(error.code)) return `${fallback}_code_${error.code}`;
  return fallback;
}

function safeLogId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
}

function safeLogType(value) {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'unknown';
}

function logNotificationFailure(message, notificationIdValue, notification, stage, failureReason) {
  logger.error(message, {
    stage,
    notificationType: safeLogType(notification?.type),
    recipientId: safeLogId(notification?.userId),
    subscriptionStatus: 'not_checked',
    pushResponseStatus: null,
    failureReason,
    correlationId: safeLogId(notification?.correlationId) || safeLogId(notificationIdValue),
  });
}

function timestampMs(value) {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return 0;
}

function secretValue(secret, environmentName) {
  try {
    const value = secret.value();
    if (value) return value;
  } catch {
    // Local emulator/imports may not have Secret Manager bindings.
  }
  return process.env[environmentName] || '';
}

function taskName(queue, logicalId, generation) {
  return tasks.taskPath(PROJECT_ID, QUEUE_LOCATION, queue, `${sha256(`${queue}:${logicalId}:${generation}`).slice(0, 48)}`);
}

function taskUrl(functionName) {
  return `${FUNCTIONS_BASE_URL}/${functionName}`;
}

async function enqueueTask(queue, logicalId, generation, functionName, payload) {
  const serviceAccountEmail = workerServiceAccount();
  if (!serviceAccountEmail) throw new Error('worker_identity_not_configured');
  const name = taskName(queue, logicalId, generation);
  const task = {
    name,
    httpRequest: {
      httpMethod: 'POST',
      url: taskUrl(functionName),
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)),
      ...(serviceAccountEmail ? {
        oidcToken: {
          serviceAccountEmail,
          audience: taskUrl(functionName),
        },
      } : {}),
    },
  };
  try {
    await tasks.createTask({ parent: tasks.queuePath(PROJECT_ID, QUEUE_LOCATION, queue), task });
    return { accepted: true, name };
  } catch (error) {
    const code = error?.code || error?.status;
    if (code === 6 || String(error?.message || '').includes('ALREADY_EXISTS')) {
      return { accepted: true, duplicate: true, name };
    }
    throw error;
  }
}

function schemaIsSupported(record) {
  return Number(record?.schemaVersion || 0) === NOTIFICATION_SCHEMA_VERSION
    && Number(record?.pipelineVersion || 0) <= NOTIFICATION_PIPELINE_VERSION;
}

function pushFreshness(notification) {
  const createdAt = timestampMs(notification.createdAt) || nowMs();
  const policy = PUSH_POLICY[notification.type] || PUSH_POLICY.like;
  const expires = timestampMs(notification.pushExpiresAt)
    || Number(notification.pushExpiresAtMs || 0)
    || (createdAt + policy.freshnessMs);
  const remainingMs = expires > 0 ? expires - nowMs() : Number.POSITIVE_INFINITY;
  if (remainingMs <= 0) return { fresh: false, remainingSeconds: 0 };
  return { fresh: true, remainingSeconds: Math.max(1, Math.min(policy.ttlSeconds, Math.ceil(remainingMs / 1000))) };
}

async function actorSnapshot(actorId) {
  const snapshot = await db.doc(`users/${actorId}`).get();
  const data = snapshot.exists ? snapshot.data() : {};
  return {
    fromUserId: actorId,
    fromUserDisplayName: safeText(data?.displayName, 80),
    fromUserUsername: safeText(data?.username, 80),
    fromUserPhotoURL: safeText(data?.profilePhotoPreviewURL || data?.photoURL || data?.profileImage, 2048),
    fromUserAvatarColor: safeText(data?.avatarColor, 32),
  };
}

async function markNotificationInvalid(notificationIdValue, reason, notification = null) {
  await db.collection('notifications').doc(notificationIdValue).set({
    pushPipelineStatus: 'permanent_failed',
    pushSkipReason: reason,
    pushValidatedAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  }, { merge: true });
  logNotificationFailure('notification rejected by push pipeline', notificationIdValue, notification, 'validate_notification', reason);
}

async function normalizeLegacyNotification(notification) {
  const hasSchema = Object.prototype.hasOwnProperty.call(notification, 'schemaVersion');
  const hasPipeline = Object.prototype.hasOwnProperty.call(notification, 'pipelineVersion');
  if (hasSchema || hasPipeline) return notification;
  if (!notification.fromUserId || !notification.type) return notification;
  const createdAt = notification.createdAt || Timestamp.now();
  const createdAtMs = timestampMs(createdAt) || nowMs();
  const freshness = freshnessFor(notification.type, createdAtMs);
  const actor = await actorSnapshot(notification.fromUserId);
  const normalized = {
    ...actor,
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    pipelineVersion: NOTIFICATION_PIPELINE_VERSION,
    payloadVersion: PUSH_PAYLOAD_VERSION,
    pushEnabled: notification.pushEnabled !== false && PUSH_ENABLED_TYPES.has(notification.type),
    pushEligible: notification.pushEligible !== false,
    pushExpiresAt: notification.pushExpiresAt || Timestamp.fromMillis(freshness.pushExpiresAtMs),
    deliveryDeadline: notification.deliveryDeadline || Timestamp.fromMillis(freshness.deliveryDeadlineMs),
    webPushTtlSeconds: freshness.webPushTtlSeconds,
    deepLink: notification.deepLink || notificationUrl({ ...notification, fromUserId: notification.fromUserId }),
    updatedAt: Timestamp.now(),
  };
  const copy = notificationCopy(notification.type, { ...notification, ...actor });
  normalized.title = copy.title;
  normalized.body = copy.body;
  await db.collection('notifications').doc(notification.id).update(normalized);
  return { ...notification, ...normalized };
}

async function enqueueExpansion(notificationIdValue, notification, source = 'trigger') {
  const dispatchRef = db.collection('pushDispatches').doc(notificationIdValue);
  let shouldEnqueue = false;
  let taskGeneration = 0;
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(dispatchRef);
    const data = existing.exists ? existing.data() : {};
    if (['completed', 'not_applicable', 'permanent_failed'].includes(data.expansionStatus)) return;
    const generation = Number(data.expansionGeneration || 0);
    taskGeneration = generation;
    transaction.set(dispatchRef, {
      notificationId: notificationIdValue,
      userId: notification.userId,
      expansionStatus: 'pending',
      expansionAttempts: Number(data.expansionAttempts || 0),
      expansionGeneration: generation,
      expansionCursorVersion: 1,
      expansionSource: source,
      schemaVersion: notification.schemaVersion || NOTIFICATION_SCHEMA_VERSION,
      pipelineVersion: notification.pipelineVersion || NOTIFICATION_PIPELINE_VERSION,
      createdAt: data.createdAt || Timestamp.now(),
      updatedAt: Timestamp.now(),
    }, { merge: true });
    shouldEnqueue = true;
  });
  if (shouldEnqueue) {
    try {
      await enqueueTask(PUSH_QUEUE, `expand:${notificationIdValue}`, taskGeneration, 'processPushDeliveryTask', {
        kind: 'expand',
        notificationId: notificationIdValue,
        taskGeneration,
        correlationId: safeLogId(notification.correlationId) || safeLogId(notificationIdValue),
      });
      logger.info('push expansion task enqueued', {
        stage: 'enqueue_expand',
        notificationType: safeLogType(notification.type),
        recipientId: safeLogId(notification.userId),
        subscriptionStatus: 'not_checked',
        pushResponseStatus: null,
        failureReason: null,
        correlationId: safeLogId(notification.correlationId) || safeLogId(notificationIdValue),
      });
    } catch (error) {
      const failureReason = safeFailureReason(error, 'task_enqueue_failed');
      await dispatchRef.set({
        expansionStatus: 'retryable_failed',
        expansionLeaseUntil: null,
        expansionLastErrorCode: failureReason,
        expansionLastErrorClass: 'retryable',
        updatedAt: Timestamp.now(),
      }, { merge: true });
      logNotificationFailure('push expansion task enqueue failed', notificationIdValue, notification, 'enqueue_expand', failureReason);
      throw new Error(failureReason);
    }
  }
}

async function validatePushNotification(notificationIdValue) {
  const ref = db.collection('notifications').doc(notificationIdValue);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { valid: false, notification: null, reason: 'missing_notification' };
  const notification = { id: snapshot.id, ...snapshot.data() };
  if (!schemaIsSupported(notification)) return { valid: false, notification, reason: 'permanent_unknown_schema' };
  if (notification.payloadVersion !== undefined && Number(notification.payloadVersion) !== PUSH_PAYLOAD_VERSION) {
    return { valid: false, notification, reason: 'permanent_unknown_payload' };
  }
  if (LEGACY_NOTIFICATION_TYPES.has(notification.type)) {
    return { valid: false, notification, reason: 'feature_disabled' };
  }
  if (!PUSH_ENABLED_TYPES.has(notification.type)) return { valid: false, notification, reason: 'push_type_not_allowed' };
  if (notification.pushEnabled === false || notification.pushEligible === false) return { valid: false, notification, reason: 'push_disabled_by_policy' };
  const validation = await validateNotificationSource(db, notification.fromUserId, notification, { requirePushType: true });
  return validation.valid ? { valid: true, notification, proof: validation } : { valid: false, notification, reason: validation.reason };
}

async function leaseExpansion(notificationIdValue) {
  const ref = db.collection('pushDispatches').doc(notificationIdValue);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data() || {};
    if (['completed', 'not_applicable', 'permanent_failed'].includes(data.expansionStatus)) return null;
    const leaseUntilMs = timestampMs(data.expansionLeaseUntil);
    if (data.expansionStatus === 'processing' && leaseUntilMs > nowMs()) return null;
    const attempts = Number(data.expansionAttempts || 0) + 1;
    transaction.update(ref, {
      expansionStatus: 'processing',
      expansionAttempts: attempts,
      expansionLeaseUntil: Timestamp.fromMillis(nowMs() + LEASE_MS),
      expansionLastAttemptAt: Timestamp.now(),
      expansionLastErrorCode: null,
      expansionLastErrorClass: null,
    });
    return { id: notificationIdValue, ...data, expansionAttempts: attempts };
  });
}

async function processExpansion(notificationIdValue) {
  const aggregate = await leaseExpansion(notificationIdValue);
  if (!aggregate) return;
  const validation = await validatePushNotification(notificationIdValue);
  if (!validation.valid) {
    await db.collection('pushDispatches').doc(notificationIdValue).update({
      expansionStatus: ['feature_disabled', 'push_type_not_allowed', 'push_disabled_by_policy'].includes(validation.reason) ? 'not_applicable' : 'permanent_failed',
      expansionLeaseUntil: null,
      expansionLastErrorCode: validation.reason,
      expansionLastErrorClass: 'permanent',
      updatedAt: Timestamp.now(),
    });
    if (!['feature_disabled', 'push_type_not_allowed', 'push_disabled_by_policy'].includes(validation.reason)) await markNotificationInvalid(notificationIdValue, validation.reason, validation.notification);
    return;
  }
  const notification = validation.notification;
  const freshness = pushFreshness(notification);
  if (!freshness.fresh) {
    await db.collection('pushDispatches').doc(notificationIdValue).update({ expansionStatus: 'completed', expansionLeaseUntil: null, expansionLastErrorCode: 'expired', updatedAt: Timestamp.now() });
    return;
  }
  let query = db.collection('pushSubscriptions').where('userId', '==', notification.userId).orderBy(FieldPath.documentId()).limit(MAX_SUBSCRIPTION_PAGE);
  const cursor = aggregate.expansionCursor?.lastSubscriptionId || '';
  if (cursor) query = query.startAfter(cursor);
  const subscriptions = await query.get();
  const active = subscriptions.docs.filter(doc => {
    const data = doc.data();
    return data.active !== false && data.subscriptionEnabled !== false;
  });
  if (!active.length) {
    logger.info('push expansion found no active subscription on page', {
      stage: 'expand_subscriptions',
      notificationType: safeLogType(notification.type),
      recipientId: safeLogId(notification.userId),
      subscriptionStatus: subscriptions.empty ? 'none' : 'disabled',
      pushResponseStatus: null,
      failureReason: 'no_active_subscriptions',
      correlationId: safeLogId(notification.correlationId) || safeLogId(notificationIdValue),
    });
  }
  for (const subscriptionDoc of active) {
    const subscription = subscriptionDoc.data();
    const generation = Number(subscription.subscriptionGeneration || 1);
    const logicalDeliveryId = sha256(`${notificationIdValue}:${subscriptionDoc.id}:${generation}`);
    const deliveryRef = db.collection('pushDeliveries').doc(logicalDeliveryId);
    const deliveryCreatedAt = Timestamp.now();
    await db.runTransaction(async transaction => {
      const current = await transaction.get(deliveryRef);
      if (current.exists) return;
      transaction.create(deliveryRef, {
        logicalDeliveryId,
        notificationId: notificationIdValue,
        subscriptionId: subscriptionDoc.id,
        subscriptionGeneration: generation,
        userId: notification.userId,
        status: 'pending',
        attempts: 0,
        taskGeneration: 0,
        pushExpiresAt: notification.pushExpiresAt || null,
        payloadVersion: PUSH_PAYLOAD_VERSION,
        schemaVersion: notification.schemaVersion,
        pipelineVersion: notification.pipelineVersion,
        correlationId: safeLogId(notification.correlationId) || safeLogId(notificationIdValue),
        createdAt: deliveryCreatedAt,
        updatedAt: deliveryCreatedAt,
        lastAttemptAt: null,
        leaseUntil: null,
        expiresAt: Timestamp.fromMillis(deliveryCreatedAt.toMillis() + EVENT_RETENTION_MS),
      });
    });
    try {
      await enqueueTask(PUSH_QUEUE, `send:${logicalDeliveryId}`, 0, 'processPushDeliveryTask', {
        kind: 'send',
        logicalDeliveryId,
        notificationId: notificationIdValue,
        correlationId: safeLogId(notification.correlationId) || safeLogId(notificationIdValue),
        taskGeneration: 0,
      });
      logger.info('push delivery task enqueued', {
        stage: 'enqueue_send',
        notificationType: safeLogType(notification.type),
        recipientId: safeLogId(notification.userId),
        subscriptionStatus: 'active',
        pushResponseStatus: null,
        failureReason: null,
        correlationId: safeLogId(notification.correlationId) || safeLogId(notificationIdValue),
      });
    } catch (error) {
      const failureReason = safeFailureReason(error, 'task_enqueue_failed');
      logger.error('push delivery task enqueue failed', {
        stage: 'enqueue_send',
        notificationType: safeLogType(notification.type),
        recipientId: safeLogId(notification.userId),
        subscriptionStatus: 'active',
        pushResponseStatus: null,
        failureReason,
        correlationId: safeLogId(notification.correlationId) || safeLogId(notificationIdValue),
      });
      throw new Error(failureReason);
    }
  }
  const lastSubscriptionId = subscriptions.docs.at(-1)?.id || cursor;
  const done = subscriptions.size < MAX_SUBSCRIPTION_PAGE;
  const nextGeneration = Number(aggregate.expansionGeneration || 0) + 1;
  if (!done) {
    try {
      await enqueueTask(PUSH_QUEUE, `expand:${notificationIdValue}`, nextGeneration, 'processPushDeliveryTask', {
        kind: 'expand',
        notificationId: notificationIdValue,
        taskGeneration: nextGeneration,
        correlationId: notification.correlationId || notificationIdValue,
      });
    } catch (error) {
      const failureReason = safeFailureReason(error, 'task_enqueue_failed');
      logNotificationFailure('push expansion continuation enqueue failed', notificationIdValue, notification, 'enqueue_expand_continuation', failureReason);
      throw new Error(failureReason);
    }
  }
  await db.collection('pushDispatches').doc(notificationIdValue).update({
    expansionStatus: done ? 'completed' : 'pending',
    expansionLeaseUntil: null,
    expansionCursor: { lastSubscriptionId },
    expansionCursorVersion: 1,
    expansionGeneration: nextGeneration,
    ...(done ? { expansionCompletedAt: Timestamp.now() } : {}),
    updatedAt: Timestamp.now(),
  });
}

function providerErrorCode(error) {
  return providerStatusCode(error);
}

function isStaleProviderError(error) {
  const code = providerErrorCode(error);
  return code === 404 || code === 410;
}

function isRetryableProviderError(error) {
  const code = providerErrorCode(error);
  return code === 408 || code === 425 || code === 429 || code >= 500 || code === 0;
}

async function writeDeliveryTerminal(ref, status, fields = {}, expectedTaskGeneration = null) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const current = snapshot.data() || {};
    if (expectedTaskGeneration !== null && Number(current.taskGeneration || 0) !== Number(expectedTaskGeneration)) return false;
    if (DELIVERY_TERMINAL_STATUSES.has(current.status)) return false;
    const now = Timestamp.now();
    transaction.update(ref, { status, leaseUntil: null, updatedAt: now, ...fields });
    return true;
  });
}

async function leaseDelivery(deliveryId, requestedTaskGeneration = null) {
  const ref = db.collection('pushDeliveries').doc(deliveryId);
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const data = snapshot.data() || {};
    if (DELIVERY_TERMINAL_STATUSES.has(data.status)) return null;
    const currentTaskGeneration = Number(data.taskGeneration || 0);
    if (!taskGenerationMatches(data, requestedTaskGeneration)) return null;
    const leaseUntilMs = timestampMs(data.leaseUntil);
    if (data.status === 'processing' && leaseUntilMs > nowMs()) return null;
    const attempts = Number(data.attempts || 0) + 1;
    const now = Timestamp.now();
    transaction.update(ref, {
      status: 'processing',
      attempts,
      leaseUntil: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
      lastAttemptAt: now,
      updatedAt: now,
    });
    return { id: deliveryId, ...data, attempts, taskGeneration: currentTaskGeneration };
  });
}

class DeliveryPipelineError extends Error {
  constructor(code, stage, { permanent = false, providerStatus = 0, providerResponseObserved = false, context = {} } = {}) {
    super(code);
    this.code = code;
    this.stage = stage;
    this.permanent = permanent;
    this.providerStatus = providerStatus;
    this.providerResponseObserved = providerResponseObserved;
    this.context = context;
  }
}

function deliveryErrorDetails(error, stage, providerStatus = 0) {
  const status = providerStatus || providerErrorCode(error);
  if (status) {
    return {
      normalizedErrorCode: `provider_${status}`,
      errorClass: status === 404 || status === 410 ? 'stale' : status >= 500 || status === 429 ? 'retryable' : 'provider',
      providerHttpStatus: status,
    };
  }
  const normalizedErrorCode = safeFailureReason(error, `${stage}_failed`);
  return {
    normalizedErrorCode,
    errorClass: error?.permanent ? 'permanent' : 'retryable',
    providerHttpStatus: null,
  };
}

function logDeliveryFailure(error, delivery, stage, providerStatus = 0, { notification = null, subscriptionStatus = 'not_checked' } = {}) {
  const details = deliveryErrorDetails(error, stage, providerStatus);
  logger.error('push delivery failure', {
    stage,
    notificationType: safeLogType(notification?.type),
    recipientId: safeLogId(notification?.userId || delivery?.userId),
    subscriptionStatus: isStaleProviderError(error) ? 'stale' : subscriptionStatus,
    pushResponseStatus: details.providerHttpStatus,
    failureReason: details.normalizedErrorCode,
    normalizedErrorCode: details.normalizedErrorCode,
    errorClass: details.errorClass,
    providerHttpStatus: details.providerHttpStatus,
    correlationId: safeLogId(delivery?.correlationId),
  });
  return details;
}

async function sendDelivery(deliveryId, requestedTaskGeneration = null) {
  const delivery = await leaseDelivery(deliveryId, requestedTaskGeneration);
  if (!delivery) return;
  const deliveryRef = db.collection('pushDeliveries').doc(deliveryId);
  const finish = (status, fields = {}) => writeDeliveryTerminal(deliveryRef, status, fields, delivery.taskGeneration);
  let stage = 'load_notification';
  let providerStatus = 0;
  let providerResponseObserved = false;
  let notification = null;
  let subscriptionRef = null;
  let subscription = null;
  let subscriptionStatus = 'not_checked';
  const logSkipped = (status, reason) => {
    logger.warn('push delivery skipped', {
      stage,
      notificationType: safeLogType(notification?.type),
      recipientId: safeLogId(notification?.userId || delivery.userId),
      subscriptionStatus,
      pushResponseStatus: null,
      failureReason: reason,
      correlationId: safeLogId(delivery.correlationId),
    });
    return finish(status, status === 'permanent_failed'
      ? { lastErrorCode: reason, lastErrorClass: 'permanent' }
      : { skipReason: reason });
  };
  try {
    if (PUSH_SENDER_MODE !== 'gcp') return logSkipped('skipped', `sender_mode_${PUSH_SENDER_MODE}`);
    const notificationSnapshot = await db.doc(`notifications/${delivery.notificationId}`).get();
    if (!notificationSnapshot.exists) return logSkipped('permanent_failed', 'missing_notification');
    notification = { id: notificationSnapshot.id, ...notificationSnapshot.data() };
    if (!ACTIVE_NOTIFICATION_TYPES.has(notification.type)) {
      return logSkipped('skipped', LEGACY_NOTIFICATION_TYPES.has(notification.type) ? 'feature_disabled' : 'unknown_notification_type');
    }
    stage = 'validate_source';
    const sourceValidation = await validateNotificationSource(db, notification.fromUserId, notification, { requirePushType: true });
    if (!sourceValidation.valid) {
      return logSkipped('permanent_failed', sourceValidation.reason || 'invalid_source');
    }
    const freshness = pushFreshness(notification);
    if (!freshness.fresh) return logSkipped('expired', 'expired');
    stage = 'validate_subscription';
    subscriptionRef = db.collection('pushSubscriptions').doc(delivery.subscriptionId);
    const subscriptionSnapshot = await subscriptionRef.get();
    if (!subscriptionSnapshot.exists) {
      subscriptionStatus = 'missing';
      return logSkipped('skipped', 'no_subscription');
    }
    subscription = subscriptionSnapshot.data() || {};
    if (subscription.userId !== notification.userId || Number(subscription.subscriptionGeneration || 1) !== Number(delivery.subscriptionGeneration || 1)) {
      subscriptionStatus = 'ownership_changed';
      return logSkipped('skipped', 'ownership_changed');
    }
    if (subscription.active === false || subscription.subscriptionEnabled === false || subscription.userPushEnabled === false) {
      subscriptionStatus = subscription.staleAt ? 'stale' : 'disabled';
      return logSkipped('skipped', 'disabled');
    }
    subscriptionStatus = 'active';
    const userSnapshot = await db.doc(`users/${notification.userId}`).get();
    if (userSnapshot.exists && userSnapshot.data()?.userPushEnabled === false) {
      subscriptionStatus = 'disabled';
      return logSkipped('skipped', 'user_push_disabled');
    }

    stage = 'load_secret';
    const publicKey = normalizeSecretValue(secretValue(VAPID_PUBLIC_KEY_SECRET, 'VAPID_PUBLIC_KEY'));
    const privateKey = normalizeSecretValue(secretValue(VAPID_PRIVATE_KEY_SECRET, 'VAPID_PRIVATE_KEY'));
    const subject = normalizeSecretValue(secretValue(VAPID_SUBJECT_SECRET, 'VAPID_SUBJECT'));
    if (!publicKey || !privateKey || !subject) throw new DeliveryPipelineError('secret_unavailable', stage, { permanent: true });

    stage = 'configure_vapid';
    try {
      webpush.setVapidDetails(subject, publicKey, privateKey);
    } catch {
      throw new DeliveryPipelineError('vapid_invalid', stage, { permanent: true });
    }

    stage = 'build_payload';
    let payload;
    try {
      payload = buildPushPayload(delivery.notificationId, notification);
    } catch {
      throw new DeliveryPipelineError('payload_build_failed', stage, { permanent: true });
    }

    stage = 'provider_send';
    const providerResponse = await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, JSON.stringify(payload), {
      TTL: freshness.remainingSeconds,
      urgency: PUSH_POLICY[notification.type]?.urgency || 'normal',
      topic: String(delivery.notificationId).slice(0, 32),
    });
    providerStatus = providerStatusCode(providerResponse);
    providerResponseObserved = true;

    stage = 'persist_result';
    const persisted = await finish('completed', {
      providerAcceptedAt: Timestamp.now(),
      providerStatus: Number.isFinite(providerStatus) && providerStatus > 0 ? providerStatus : null,
      lastErrorCode: null,
      lastErrorClass: null,
    });
    if (!persisted) throw new DeliveryPipelineError('provider_result_persist_conflict', stage, { providerStatus, providerResponseObserved: true });
    logger.info('push provider accepted delivery', {
      stage,
      notificationType: safeLogType(notification.type),
      recipientId: safeLogId(notification.userId || delivery.userId),
      subscriptionStatus: 'active',
      pushResponseStatus: Number.isFinite(providerStatus) && providerStatus > 0 ? providerStatus : null,
      failureReason: null,
      correlationId: safeLogId(delivery.correlationId) || safeLogId(notification.correlationId),
    });
  } catch (error) {
    if (isStaleProviderError(error)) subscriptionStatus = 'stale';
    const details = logDeliveryFailure(error, delivery, stage, providerStatus, { notification, subscriptionStatus });
    const errorCode = details.normalizedErrorCode;
    if (isStaleProviderError(error) && subscriptionRef) {
      await db.runTransaction(async transaction => {
        const currentDelivery = await transaction.get(deliveryRef);
        const currentSubscription = await transaction.get(subscriptionRef);
        if (!currentDelivery.exists || Number(currentDelivery.data()?.taskGeneration || 0) !== Number(delivery.taskGeneration || 0)) return;
        if (currentSubscription.exists && Number(currentSubscription.data()?.subscriptionGeneration || 1) === Number(delivery.subscriptionGeneration || 1)) {
          const staleAt = Timestamp.now();
          transaction.update(subscriptionRef, {
            endpoint: FieldValue.delete(),
            keys: FieldValue.delete(),
            userAgent: FieldValue.delete(),
            platform: FieldValue.delete(),
            active: false,
            subscriptionEnabled: false,
            staleAt,
            expiresAt: Timestamp.fromMillis(staleAt.toMillis() + EVENT_RETENTION_MS),
            updatedAt: staleAt,
          });
        }
        transaction.update(deliveryRef, { status: 'stale', skipReason: 'provider_stale', leaseUntil: null, updatedAt: Timestamp.now(), providerStatus: providerErrorCode(error) });
      });
      return;
    }
    const permanent = Boolean(error?.permanent) || stage === 'configure_vapid' || stage === 'build_payload' || stage === 'load_secret';
    const retryable = !permanent && (isRetryableProviderError(error) || stage === 'persist_result');
    if (!retryable || delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await db.collection('pushDeliveryDeadLetters').doc(`${deliveryId}:${errorCode}`).set({
        logicalDeliveryId: deliveryId,
        notificationId: delivery.notificationId,
        failureStage: stage,
        failureReason: errorCode,
        failureClass: permanent ? 'permanent' : 'retry_exhausted',
        providerResponseObserved,
        providerHttpStatus: providerStatus || null,
        attempts: delivery.attempts,
        failedAt: Timestamp.now(),
        expiresAt: Timestamp.fromMillis(nowMs() + EVENT_RETENTION_MS),
      }, { merge: true });
      await finish('permanent_failed', {
        lastErrorCode: errorCode,
        lastErrorClass: permanent ? 'permanent' : 'retry_exhausted',
        providerResponseObserved,
        providerStatus: providerStatus || null,
      });
      return;
    }
    const transitioned = await finish('retryable_failed', {
      lastErrorCode: errorCode,
      lastErrorClass: 'retryable',
      providerResponseObserved,
      providerStatus: providerStatus || null,
    });
    if (!transitioned) return;
    throw new DeliveryPipelineError(errorCode, stage, { providerStatus, providerResponseObserved, context: { correlationId: delivery.correlationId || delivery.notificationId, deliveryId } });
  }
}

class PermanentTaskError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.permanent = true;
  }
}

async function handleTask(req, handler) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
  const body = req.body || {};
  try {
    await handler(body);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    if (error?.permanent) {
      logger.error('notification worker terminal failure', {
        stage: error.stage || 'task',
        normalizedErrorCode: error.code || 'permanent_task_error',
        errorClass: 'permanent',
        correlationId: error.context?.correlationId || body.correlationId || null,
        deliveryId: error.context?.deliveryId || body.logicalDeliveryId || null,
      });
      return { status: 200, body: { ok: false, terminal: true, errorCode: error.code || 'permanent_task_error' } };
    }
    const details = deliveryErrorDetails(error, error?.stage || 'task', error?.providerStatus || 0);
    logger.error('notification worker retryable failure', {
      stage: error?.stage || 'task',
      normalizedErrorCode: details.normalizedErrorCode,
      errorClass: details.errorClass,
      providerHttpStatus: details.providerHttpStatus,
      correlationId: error?.context?.correlationId || body.correlationId || null,
      notificationId: body.notificationId || null,
      deliveryId: error?.context?.deliveryId || body.logicalDeliveryId || null,
    });
    return { status: 500, body: { ok: false, retryable: true } };
  }
}

export const notifyCommentLike = onDocumentCreated({ document: 'likes/{likeId}', retry: true, region: REGION }, async event => {
  await materializeCommentLikeNotification(db, event.data?.data(), event.params.likeId);
});

export const enqueueNotification = onDocumentCreated({ document: 'notifications/{notificationId}', retry: true, region: REGION }, async event => {
  const snapshot = event.data;
  if (!snapshot?.exists) return;
  const data = await normalizeLegacyNotification({ id: snapshot.id, ...snapshot.data() });
  if (LEGACY_NOTIFICATION_TYPES.has(data.type)) {
    await db.collection('pushDispatches').doc(snapshot.id).set({ notificationId: snapshot.id, expansionStatus: 'not_applicable', skipReason: 'feature_disabled', updatedAt: Timestamp.now(), createdAt: data.createdAt || Timestamp.now() }, { merge: true });
    return;
  }
  // Moderation notices are created by the role-checked Worker and shown in
  // the in-app notification list. They intentionally do not expose the
  // moderator's account or enter the social push-source validation path.
  if (data.type === 'post_moderated') {
    await db.collection('pushDispatches').doc(snapshot.id).set({ notificationId: snapshot.id, expansionStatus: 'not_applicable', skipReason: 'moderation_notice_in_app_only', updatedAt: Timestamp.now(), createdAt: data.createdAt || Timestamp.now() }, { merge: true });
    return;
  }
  if (!schemaIsSupported(data)) {
    await markNotificationInvalid(snapshot.id, 'permanent_unknown_schema', data);
    return;
  }
  const validation = await validateNotificationSource(db, data.fromUserId, data, { requirePushType: false });
  if (!validation.valid) {
    await markNotificationInvalid(snapshot.id, validation.reason, data);
    return;
  }
  if (!PUSH_ENABLED_TYPES.has(data.type)) {
    await db.collection('pushDispatches').doc(snapshot.id).set({ notificationId: snapshot.id, expansionStatus: 'not_applicable', updatedAt: Timestamp.now(), createdAt: data.createdAt || Timestamp.now() }, { merge: true });
    return;
  }
  if (PUSH_SENDER_MODE !== 'gcp') return;
  await enqueueExpansion(snapshot.id, data, 'notification-trigger');
});

// Firestore events are wake-up signals only. The transaction in
// syncPostSearchIndex reads the current canonical post, which makes retries,
// duplicate delivery, and out-of-order events safe.
export const syncPostSearchProjection = onDocumentWritten({ document: 'posts/{postId}', retry: true, region: REGION }, async event => {
  const beforeSnapshot = event.data?.before;
  const afterSnapshot = event.data?.after;
  const postId = event.params?.postId || afterSnapshot?.id || beforeSnapshot?.id || '';
  const before = beforeSnapshot?.exists ? beforeSnapshot.data() : null;
  const after = afterSnapshot?.exists ? afterSnapshot.data() : null;
  if (!didSearchProjectionChange(before, after, postId)) return;
  await syncPostSearchIndex(db, postId);
});

export const processPushDeliveryTask = onRequest({ region: REGION, timeoutSeconds: 45, memory: '256MiB', concurrency: 10, maxInstances: 8, invoker: 'private', secrets: [VAPID_PUBLIC_KEY_SECRET, VAPID_PRIVATE_KEY_SECRET, VAPID_SUBJECT_SECRET] }, async (req, res) => {
  const result = await handleTask(req, async body => {
    if (body.kind === 'expand' && typeof body.notificationId === 'string') return processExpansion(body.notificationId);
    if (body.kind === 'send' && typeof body.logicalDeliveryId === 'string') {
      const taskGeneration = Number.isFinite(Number(body.taskGeneration)) ? Number(body.taskGeneration) : null;
      return sendDelivery(body.logicalDeliveryId, taskGeneration);
    }
    throw new PermanentTaskError('invalid_push_task_payload');
  });
  return res.status(result.status).json(result.body);
});

async function repairAggregate(snapshot) {
  const data = snapshot.data() || {};
  const lease = timestampMs(data.expansionLeaseUntil);
  const eligible = (['pending', 'retryable_failed'].includes(data.expansionStatus) && timestampMs(data.updatedAt || data.createdAt) < nowMs() - TASK_GRACE_MS)
    || (data.expansionStatus === 'processing' && lease < nowMs() - LEASE_MS);
  if (!eligible) return;
  const generation = Number(data.expansionGeneration || 0) + 1;
  const claimed = await db.runTransaction(async transaction => {
    const current = await transaction.get(snapshot.ref);
    const value = current.data() || {};
    const valueLease = timestampMs(value.expansionLeaseUntil);
    const canRepair = (['pending', 'retryable_failed'].includes(value.expansionStatus) && timestampMs(value.updatedAt || value.createdAt) < nowMs() - TASK_GRACE_MS)
      || (value.expansionStatus === 'processing' && valueLease < nowMs() - LEASE_MS);
    if (!canRepair) return false;
    transaction.update(snapshot.ref, { expansionStatus: 'pending', expansionGeneration: generation, expansionRepairGeneration: generation, updatedAt: Timestamp.now() });
    return true;
  });
  if (claimed) await enqueueTask(PUSH_QUEUE, `expand:${snapshot.id}`, generation, 'processPushDeliveryTask', { kind: 'expand', notificationId: snapshot.id, taskGeneration: generation, correlationId: data.correlationId || snapshot.id });
}

async function repairDelivery(snapshot) {
  const data = snapshot.data() || {};
  const lease = timestampMs(data.leaseUntil);
  const eligible = deliveryRecoveryEligible(data, nowMs(), { graceMs: TASK_GRACE_MS, leaseMarginMs: DELIVERY_CLOCK_MARGIN_MS })
    || (data.status === 'processing' && lease < nowMs() - LEASE_MS);
  if (!eligible) return;
  const claimedGeneration = await db.runTransaction(async transaction => {
    const current = await transaction.get(snapshot.ref);
    const value = current.data() || {};
    const valueLease = timestampMs(value.leaseUntil);
    const canRepair = deliveryRecoveryEligible(value, nowMs(), { graceMs: TASK_GRACE_MS, leaseMarginMs: DELIVERY_CLOCK_MARGIN_MS })
      || (value.status === 'processing' && valueLease < nowMs() - LEASE_MS);
    if (!canRepair) return false;
    const generation = Number(value.taskGeneration || 0) + 1;
    transaction.update(snapshot.ref, { status: 'pending', taskGeneration: generation, repairGeneration: generation, updatedAt: Timestamp.now() });
    return generation;
  });
  if (claimedGeneration !== false) await enqueueTask(PUSH_QUEUE, `send:${snapshot.id}`, claimedGeneration, 'processPushDeliveryTask', { kind: 'send', logicalDeliveryId: snapshot.id, taskGeneration: claimedGeneration, notificationId: data.notificationId, correlationId: data.correlationId || data.notificationId });
}

export const reconcileNotificationPipeline = onSchedule({ schedule: 'every 10 minutes', region: REGION, timeZone: 'UTC', retryConfig: { maxRetryAttempts: 3 } }, async () => {
  const now = Timestamp.fromMillis(nowMs());
  const staleAt = Timestamp.fromMillis(nowMs() - TASK_GRACE_MS);
  const leaseCutoff = Timestamp.fromMillis(nowMs() - DELIVERY_CLOCK_MARGIN_MS);
  const [aggregates, deliveryCandidates] = await Promise.all([
    db.collection('pushDispatches').where('expansionStatus', 'in', ['pending', 'processing', 'retryable_failed']).where('updatedAt', '<', now).limit(50).get(),
    Promise.all([
      db.collection('pushDeliveries').where('status', '==', 'processing').where('leaseUntil', '<', leaseCutoff).limit(DELIVERY_RECOVERY_SCAN_LIMIT).get(),
      db.collection('pushDeliveries').where('status', 'in', ['pending', 'retryable_failed']).where('lastAttemptAt', '<', staleAt).limit(DELIVERY_RECOVERY_SCAN_LIMIT).get(),
      db.collection('pushDeliveries').where('status', 'in', ['pending', 'processing', 'retryable_failed']).where('updatedAt', '<', staleAt).limit(DELIVERY_RECOVERY_SCAN_LIMIT).get(),
      db.collection('pushDeliveries').where('status', 'in', ['pending', 'retryable_failed']).where('createdAt', '<', staleAt).limit(DELIVERY_RECOVERY_SCAN_LIMIT).get(),
    ]),
  ]);
  const deliveryMap = new Map();
  flattenDeliveryQuerySnapshots(deliveryCandidates).forEach(snapshot => deliveryMap.set(snapshot.id, snapshot));
  const deliveries = [...deliveryMap.values()];
  await Promise.all([
    ...aggregates.docs.map(repairAggregate),
    ...deliveries.map(repairDelivery),
  ]);
});

export const notificationPipelineHealth = onRequest({ region: REGION, timeoutSeconds: 30, memory: '128MiB', maxInstances: 1, invoker: 'private' }, async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  return res.status(200).json({ ok: true, projectId: PROJECT_ID, region: REGION, pipelineVersion: NOTIFICATION_PIPELINE_VERSION, payloadVersion: PUSH_PAYLOAD_VERSION, sender: PUSH_SENDER_MODE });
});
