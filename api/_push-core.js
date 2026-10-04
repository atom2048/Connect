import {
  PUSH_ENABLED_TYPES,
  buildPushPayload as buildVersionedPushPayload,
  notificationCopy,
  notificationUrl,
} from '../functions/lib/notification-domain.js';

export const PUSHABLE_NOTIFICATION_TYPES = PUSH_ENABLED_TYPES;

export function isStalePushStatus(statusCode) {
  return statusCode === 404 || statusCode === 410;
}

export function buildPushPayload(notificationId, notification) {
  return buildVersionedPushPayload(notificationId, notification);
}

export { notificationCopy, notificationUrl };

export async function deliverToSubscriptions(subscriptions, send) {
  const results = await Promise.all(subscriptions.map(async subscription => {
    try {
      await send(subscription);
      return { id: subscription.id, status: 'sent' };
    } catch (error) {
      const statusCode = Number(error?.statusCode || error?.status || 0);
      return { id: subscription.id, status: isStalePushStatus(statusCode) ? 'stale' : 'failed', statusCode };
    }
  }));
  return {
    sentIds: results.filter(item => item.status === 'sent').map(item => item.id),
    staleIds: results.filter(item => item.status === 'stale').map(item => item.id),
    failedCount: results.filter(item => item.status === 'failed').length,
  };
}
