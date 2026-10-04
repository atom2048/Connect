import crypto from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './_firebase-admin.js';
import { setApiHeaders, verifyFirebaseUser } from './_auth.js';

export function subscriptionId(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

export function subscriptionOwnedByAnotherUser(existingUserId, currentUserId) {
  return Boolean(existingUserId && currentUserId && existingUserId !== currentUserId);
}

export function subscriptionStatusFor(record, currentUserId) {
  if (!record || record.userId !== currentUserId) return 'missing';
  if (record.staleAt) return 'stale';
  if (record.active === false || record.subscriptionEnabled === false || record.userPushEnabled === false) return 'disabled';
  return 'active';
}

export function pushSubscriptionStatusResponse(records, currentUserId, endpointRecord) {
  const count = records.filter(record => subscriptionStatusFor(record, currentUserId) === 'active').length;
  if (endpointRecord === undefined) return { count };
  const subscriptionStatus = subscriptionStatusFor(endpointRecord, currentUserId);
  return { count, registered: subscriptionStatus === 'active', subscriptionStatus };
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) return false;
  try {
    return new URL(endpoint).protocol === 'https:';
  } catch {
    return false;
  }
}

const MAX_ACTIVE_SUBSCRIPTIONS_PER_USER = 8;
const REGISTRATION_LIMIT_PER_HOUR = 20;
const INACTIVE_SUBSCRIPTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function checkRegistrationRate(userId) {
  const ref = adminDb.collection('pushSubscriptionRateLimits').doc(userId);
  const nowMs = Date.now();
  let allowed = true;
  await adminDb.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    const data = existing.exists ? existing.data() : {};
    const windowStartMs = Number(data.windowStartMs || 0);
    const count = windowStartMs > 0 && nowMs - windowStartMs < 60 * 60 * 1000 ? Number(data.count || 0) : 0;
    if (count >= REGISTRATION_LIMIT_PER_HOUR) {
      allowed = false;
      return;
    }
    transaction.set(ref, {
      windowStartMs: count === 0 ? nowMs : windowStartMs || nowMs,
      count: count + 1,
      updatedAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(nowMs + 2 * 60 * 60 * 1000),
    }, { merge: true });
  });
  return allowed;
}

export function validSubscription(value) {
  if (!value || typeof value !== 'object') return false;
  if (!validEndpoint(value.endpoint)) return false;
  return typeof value.keys?.p256dh === 'string'
    && value.keys.p256dh.length > 0
    && value.keys.p256dh.length <= 256
    && typeof value.keys?.auth === 'string'
    && value.keys.auth.length > 0
    && value.keys.auth.length <= 256;
}

export default async function handler(req, res) {
  setApiHeaders(res, 'GET, POST, DELETE');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  let user;
  try {
    user = await verifyFirebaseUser(req);
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    // Keep status lookups working for already-open clients from before the POST status contract.
    const endpoint = typeof req.query?.endpoint === 'string' ? req.query.endpoint : '';
    if (endpoint && !validEndpoint(endpoint)) return res.status(400).json({ error: 'Invalid endpoint' });
    const collection = adminDb.collection('pushSubscriptions');
    const [snapshot, endpointSnapshot] = await Promise.all([
      collection.where('userId', '==', user.sub).get(),
      endpoint ? collection.doc(subscriptionId(endpoint)).get() : Promise.resolve(undefined),
    ]);
    const endpointRecord = endpointSnapshot === undefined
      ? undefined
      : endpointSnapshot.exists ? endpointSnapshot.data() : null;
    return res.status(200).json(pushSubscriptionStatusResponse(
      snapshot.docs.map(doc => doc.data()),
      user.sub,
      endpointRecord,
    ));
  }

  if (req.method === 'POST' && req.body?.action === 'status') {
    const endpoint = req.body?.endpoint;
    if (!validEndpoint(endpoint)) return res.status(400).json({ error: 'Invalid endpoint' });
    const [snapshot, endpointRecord] = await Promise.all([
      adminDb.collection('pushSubscriptions').where('userId', '==', user.sub).get(),
      adminDb.collection('pushSubscriptions').doc(subscriptionId(endpoint)).get(),
    ]);
    return res.status(200).json(pushSubscriptionStatusResponse(
      snapshot.docs.map(doc => doc.data()),
      user.sub,
      endpointRecord.exists ? endpointRecord.data() : null,
    ));
  }

  const subscription = req.body?.subscription || req.body;
  if (!validSubscription(subscription)) return res.status(400).json({ error: 'Invalid subscription' });
  const ref = adminDb.collection('pushSubscriptions').doc(subscriptionId(subscription.endpoint));

  if (req.method === 'DELETE') {
    await adminDb.runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (!existing.exists || existing.data()?.userId !== user.sub) return;
      transaction.update(ref, {
        endpoint: FieldValue.delete(),
        keys: FieldValue.delete(),
        userAgent: FieldValue.delete(),
        platform: FieldValue.delete(),
        active: false,
        subscriptionEnabled: false,
        disabledAt: Timestamp.now(),
        expiresAt: Timestamp.fromMillis(Date.now() + INACTIVE_SUBSCRIPTION_RETENTION_MS),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return res.status(204).end();
  }

  if (!(await checkRegistrationRate(user.sub))) return res.status(429).json({ error: 'Too many subscription registrations' });

  let limitExceeded = false;
  await adminDb.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    const ownershipChanged = existing.exists && subscriptionOwnedByAnotherUser(existing.data()?.userId, user.sub);
    if (!existing.exists || existing.data()?.active === false || ownershipChanged) {
      const activeSnapshot = await transaction.get(adminDb.collection('pushSubscriptions')
        .where('userId', '==', user.sub)
      );
      const activeCount = activeSnapshot.docs.filter(doc => subscriptionStatusFor(doc.data(), user.sub) === 'active').length;
      if (activeCount >= MAX_ACTIVE_SUBSCRIPTIONS_PER_USER) {
        limitExceeded = true;
        return;
      }
    }
    const now = FieldValue.serverTimestamp();
    const nextGeneration = existing.exists ? Math.max(1, Number(existing.data()?.subscriptionGeneration || 0) + ((existing.data()?.active === false || ownershipChanged) ? 1 : 0)) : 1;
    transaction.set(ref, {
      userId: user.sub,
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime || null,
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      userAgent: String(req.headers['user-agent'] || '').slice(0, 240),
      platform: String(req.headers['sec-ch-ua-platform'] || '').replace(/"/g, '').slice(0, 80),
      active: true,
      subscriptionEnabled: true,
      userPushEnabled: existing.exists ? existing.data()?.userPushEnabled !== false : true,
      subscriptionGeneration: nextGeneration,
      createdAt: existing.exists ? existing.data()?.createdAt || now : now,
      updatedAt: now,
      lastUsedAt: now,
      expiresAt: null,
      staleAt: FieldValue.delete(),
      disabledAt: FieldValue.delete(),
      ...(ownershipChanged ? { reboundAt: now } : {}),
    }, { merge: true });
  });
  if (limitExceeded) return res.status(409).json({ error: 'Subscription limit reached' });
  return res.status(200).json({ registered: true });
}
