import { describe, expect, it, vi } from 'vitest';
import {
  buildPushPayload,
  deliverToSubscriptions,
  isStalePushStatus,
  notificationUrl,
} from '../api/_push-core.js';
import { subscriptionId, subscriptionOwnedByAnotherUser, subscriptionStatusFor, validSubscription } from '../api/push-subscriptions.js';

describe('Web Push domain', () => {
  it('builds privacy-safe deep links for supported notification targets', () => {
    expect(notificationUrl({ type: 'comment', postId: 'post / 1' })).toBe('/#/post/post%20%2F%201');
    expect(notificationUrl({ type: 'reply', postId: 'post-2' })).toBe('/#/post/post-2');
    expect(notificationUrl({ type: 'like', postId: 'post-2', commentId: 'comment-2' })).toBe('/#/post/post-2?commentId=comment-2');
    expect(notificationUrl({ type: 'dm', conversationId: 'dm/1' })).toBe('');
    expect(notificationUrl({ type: 'friend_request', fromUserId: 'user/1' })).toBe('/#/profile/user%2F1');

    const payload = buildPushPayload('notification-1', {
      type: 'comment',
      userId: 'recipient-1',
      fromUserDisplayName: '山田太郎',
      postId: 'post-1',
      context: 'private comment body',
      token: 'secret',
    });
    expect(payload).toMatchObject({
      title: 'Connect',
      body: '山田太郎さんがコメントしました',
      url: '/#/post/post-1',
      deepLink: '/#/post/post-1',
      tag: 'connect-notification-notification-1',
      notificationId: 'notification-1',
      recipientId: 'recipient-1',
      type: 'comment',
      targetId: 'post-1',
      icon: '/connect-icon-192.png',
      badge: '/connect-icon-192.png',
    });
    expect(payload.timestamp).toEqual(expect.any(Number));
    expect(JSON.stringify(payload)).not.toContain('private comment body');
    expect(JSON.stringify(payload)).not.toContain('secret');
    expect(() => buildPushPayload('notification-dm', { type: 'dm', conversationId: 'conversation-1' })).toThrow('notification_type_retired');
  });

  it('delivers independently to every registered device', async () => {
    const subscriptions = [{ id: 'iphone' }, { id: 'android' }, { id: 'pc' }];
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await deliverToSubscriptions(subscriptions, send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ sentIds: ['iphone', 'android', 'pc'], staleIds: [], failedCount: 0 });
  });

  it('separates stale subscriptions and isolated provider failures', async () => {
    const result = await deliverToSubscriptions(
      [{ id: 'ok' }, { id: 'gone' }, { id: 'missing' }, { id: 'temporary-failure' }],
      async subscription => {
        if (subscription.id === 'gone') throw { statusCode: 410 };
        if (subscription.id === 'missing') throw { status: 404 };
        if (subscription.id === 'temporary-failure') throw { statusCode: 503 };
      },
    );
    expect(result).toEqual({ sentIds: ['ok'], staleIds: ['gone', 'missing'], failedCount: 1 });
    expect(isStalePushStatus(404)).toBe(true);
    expect(isStalePushStatus(410)).toBe(true);
    expect(isStalePushStatus(500)).toBe(false);
  });

  it('uses endpoint identity for subscription upserts and validates browser keys', () => {
    const endpoint = 'https://push.example.test/device-1';
    expect(subscriptionId(endpoint)).toBe(subscriptionId(endpoint));
    expect(subscriptionId(endpoint)).not.toBe(subscriptionId('https://push.example.test/device-2'));
    expect(validSubscription({ endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } })).toBe(true);
    expect(validSubscription({ endpoint: 'http://insecure.test', keys: { p256dh: 'x', auth: 'y' } })).toBe(false);
    expect(validSubscription({ endpoint, keys: { p256dh: 'x' } })).toBe(false);
    expect(validSubscription({ endpoint, keys: { p256dh: '', auth: 'y' } })).toBe(false);
    expect(subscriptionOwnedByAnotherUser('user-a', 'user-b')).toBe(true);
    expect(subscriptionOwnedByAnotherUser('user-a', 'user-a')).toBe(false);
    expect(subscriptionOwnedByAnotherUser('', 'user-a')).toBe(false);
  });

  it('distinguishes active, stale, disabled, and missing subscription records by owner', () => {
    expect(subscriptionStatusFor(null, 'user-a')).toBe('missing');
    expect(subscriptionStatusFor({ userId: 'user-b', active: true }, 'user-a')).toBe('missing');
    expect(subscriptionStatusFor({ userId: 'user-a', active: true }, 'user-a')).toBe('active');
    expect(subscriptionStatusFor({ userId: 'user-a', staleAt: new Date(), active: false }, 'user-a')).toBe('stale');
    expect(subscriptionStatusFor({ userId: 'user-a', active: false }, 'user-a')).toBe('disabled');
  });
});
