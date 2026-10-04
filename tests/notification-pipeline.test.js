import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_SCHEMA_VERSION,
  LEGACY_NOTIFICATION_TYPES,
  PUSH_ENABLED_TYPES,
  PUSH_PAYLOAD_VERSION,
  buildPushPayload,
  freshnessFor,
  notificationCopy,
  notificationId,
  notificationUrl,
  requestHash,
} from '../functions/lib/notification-domain.js';
import { validateNotificationSource } from '../functions/lib/source-validation.js';
import {
  DELIVERY_TERMINAL_STATUSES,
  deliveryRecoveryEligible,
  flattenDeliveryQuerySnapshots,
  normalizeSecretValue,
  providerStatusCode,
  taskGenerationMatches,
} from '../functions/lib/delivery-state.js';

function fakeDb(records) {
  return {
    doc(path) {
      return {
        async get() {
          const value = records[path];
          return {
            exists: value !== undefined,
            id: path.split('/').at(-1),
            data: () => value,
          };
        },
      };
    },
  };
}

describe('production notification pipeline domain', () => {
  it('uses an explicit Push allowlist and retires historical room notifications', () => {
    expect(PUSH_ENABLED_TYPES.has('like')).toBe(true);
    expect(PUSH_ENABLED_TYPES.has('dm')).toBe(false);
    expect(PUSH_ENABLED_TYPES.has('space_start')).toBe(false);
    expect(LEGACY_NOTIFICATION_TYPES.has('space_start')).toBe(true);
  });

  it('creates stable operation and notification identities', () => {
    expect(requestHash({ b: ' x ', a: 'y' })).toBe(requestHash({ a: 'y', b: 'x' }));
    expect(notificationId({ type: 'repost', actorId: 'a', recipientId: 'h', eventId: 'attempt-1' }))
      .not.toBe(notificationId({ type: 'repost', actorId: 'a', recipientId: 'h', eventId: 'attempt-2' }));
  });

  it('limits provider TTL by remaining notification freshness', () => {
    const createdAt = 1_000_000;
    const policy = freshnessFor('repost', createdAt);
    expect(policy.webPushTtlSeconds).toBe(86_400);
    expect(policy.pushExpiresAtMs).toBe(createdAt + 86_400_000);
  });

  it('uses post routes and does not put private text in payloads', () => {
    expect(notificationUrl({ type: 'repost', postId: 'post/a' })).toBe('/#/post/post%2Fa');
    const payload = buildPushPayload('n1', {
      type: 'comment',
      fromUserDisplayName: '山田太郎',
      userId: 'recipient-1',
      postId: 'post-1',
      context: '秘密のコメント',
      schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    });
    expect(payload.payloadVersion).toBe(PUSH_PAYLOAD_VERSION);
    expect(payload.recipientId).toBe('recipient-1');
    expect(JSON.stringify(payload)).not.toContain('秘密のコメント');
    expect(payload).not.toHaveProperty('spaceId');
    expect(notificationCopy('repost', { fromUserDisplayName: '山田太郎' }).body).toContain('リポスト');
  });

  it('rejects a forged normal notification recipient', async () => {
    const db = fakeDb({
      'posts/post-1': { id: 'post-1', userId: 'real-owner' },
      'likes/post-1_actor': { id: 'post-1_actor', userId: 'actor', eventId: 'like-1' },
    });
    const result = await validateNotificationSource(db, 'actor', {
      type: 'like',
      fromUserId: 'actor',
      userId: 'forged-recipient',
      postId: 'post-1',
      eventId: 'like-1',
    }, { requirePushType: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_like_source');
  });

  it('accepts a reply only for the parent comment owner', async () => {
    const db = fakeDb({
      'posts/post-1': { id: 'post-1', userId: 'post-owner' },
      'comments/reply-1': { id: 'reply-1', userId: 'actor', postId: 'post-1', parentId: 'comment-1' },
      'comments/comment-1': { id: 'comment-1', userId: 'parent-owner', postId: 'post-1' },
    });
    const valid = await validateNotificationSource(db, 'actor', {
      type: 'reply', fromUserId: 'actor', userId: 'parent-owner', postId: 'post-1', commentId: 'reply-1', eventId: 'reply-1',
    }, { requirePushType: true });
    const invalid = await validateNotificationSource(db, 'actor', {
      type: 'reply', fromUserId: 'actor', userId: 'post-owner', postId: 'post-1', commentId: 'reply-1', eventId: 'reply-1',
    }, { requirePushType: true });
    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
  });

  it('keeps provider HTTP status and task generation separate from subscription generation', () => {
    expect(providerStatusCode({ statusCode: 201 })).toBe(201);
    expect(providerStatusCode({ code: 'ERR_INVALID' })).toBe(0);
    const delivery = { subscriptionGeneration: 7, taskGeneration: 2 };
    expect(taskGenerationMatches(delivery, 2)).toBe(true);
    expect(taskGenerationMatches(delivery, 1)).toBe(false);
    expect(delivery.subscriptionGeneration).toBe(7);
    expect(DELIVERY_TERMINAL_STATUSES.has('completed')).toBe(true);
  });

  it('recovers only bounded stale delivery records with usable timestamps', () => {
    const now = 1_000_000;
    const options = { graceMs: 300_000, leaseMarginMs: 120_000 };
    expect(deliveryRecoveryEligible({ status: 'processing', leaseUntil: 700_000 }, now, options)).toBe(true);
    expect(deliveryRecoveryEligible({ status: 'processing', leaseUntil: 950_000 }, now, options)).toBe(false);
    expect(deliveryRecoveryEligible({ status: 'pending', createdAt: 600_000 }, now, options)).toBe(true);
    expect(deliveryRecoveryEligible({ status: 'pending' }, now, options)).toBe(false);
  });

  it('flattens query snapshots to document snapshots before delivery recovery', () => {
    const first = { id: 'a', data: () => ({}) };
    const second = { id: 'b', data: () => ({}) };
    expect(flattenDeliveryQuerySnapshots([{ docs: [first] }, { docs: [second] }])).toEqual([first, second]);
  });

  it('trims Secret Manager formatting whitespace without changing key material', () => {
    expect(normalizeSecretValue('  existing-key\r\n')).toBe('existing-key');
    expect(normalizeSecretValue(null)).toBe('');
  });
});
