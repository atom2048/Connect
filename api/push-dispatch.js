import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './_firebase-admin.js';
import { setApiHeaders, verifyFirebaseUser } from './_auth.js';
import { LEGACY_NOTIFICATION_TYPES, PUSH_ENABLED_TYPES, validateNotificationSource } from './_notification-validation.js';

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

  const notificationId = String(req.body?.notificationId || '');
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(notificationId)) return res.status(400).json({ error: 'Invalid notification' });
  const notificationSnapshot = await adminDb.doc(`notifications/${notificationId}`).get();
  const notification = notificationSnapshot.exists ? { id: notificationSnapshot.id, ...notificationSnapshot.data() } : null;
  if (notification && LEGACY_NOTIFICATION_TYPES.has(notification.type)) {
    return res.status(410).json({ error: 'FEATURE_DISABLED', feature: 'retired_notification' });
  }
  const validation = await validateNotificationSource(adminDb, user.sub, notification, { requirePushType: true });
  if (!validation.valid) return res.status(403).json({ error: 'Forbidden', reason: validation.reason });

  const dispatchRef = adminDb.collection('pushDispatches').doc(notificationId);
  const queued = await adminDb.runTransaction(async transaction => {
    const existing = await transaction.get(dispatchRef);
    if (existing.exists && existing.data()?.status === 'sent') return false;
    if (existing.exists && ['completed', 'processing', 'pending', 'not_applicable'].includes(existing.data()?.expansionStatus)) return false;
    const now = FieldValue.serverTimestamp();
    transaction.set(dispatchRef, {
      notificationId,
      userId: notification.userId,
      expansionStatus: PUSH_ENABLED_TYPES.has(notification.type) ? 'pending' : 'not_applicable',
      expansionAttempts: existing.exists ? existing.data()?.expansionAttempts || 0 : 0,
      expansionGeneration: existing.exists ? existing.data()?.expansionGeneration || 0 : 0,
      pipelineVersion: notification.pipelineVersion || 1,
      source: 'compatibility-api',
      createdAt: existing.exists ? existing.data()?.createdAt || now : now,
      updatedAt: now,
    }, { merge: true });
    return true;
  });
  return res.status(202).json({
    queued,
    duplicate: !queued,
    sender: process.env.PUSH_SENDER_MODE || 'gcp',
    providerAccepted: false,
  });
}
