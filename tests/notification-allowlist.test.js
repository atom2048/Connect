import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_NOTIFICATION_TYPES,
  LEGACY_NOTIFICATION_TYPES,
  notificationTypeClass,
} from '../functions/lib/notification-domain.js';

describe('notification allowlist parity', () => {
  it('keeps legacy values decodable but outside the active producer set', () => {
    expect([...LEGACY_NOTIFICATION_TYPES].sort()).toEqual([
      'dm',
      'space_end',
      'space_speaker_approved',
      'space_speaker_removed',
      'space_speaker_request',
      'space_start',
      'story_reply',
    ]);
    expect(notificationTypeClass('dm')).toBe('legacy');
    expect(notificationTypeClass('story_reply')).toBe('legacy');
    expect(notificationTypeClass('space_start')).toBe('legacy');
    expect(notificationTypeClass('unknown_future_type')).toBe('unknown');
    expect(ACTIVE_NOTIFICATION_TYPES.has('dm')).toBe(false);
    expect(ACTIVE_NOTIFICATION_TYPES.has('story_reply')).toBe(false);
    expect(ACTIVE_NOTIFICATION_TYPES.has('space_start')).toBe(false);
  });

  it('keeps the browser allowlist in parity with the server allowlist', async () => {
    const source = await readFile(new URL('../src/notificationDomain.ts', import.meta.url), 'utf8');
    for (const type of ACTIVE_NOTIFICATION_TYPES) expect(source).toContain(`'${type}'`);
    for (const type of LEGACY_NOTIFICATION_TYPES) expect(source).toContain(`'${type}'`);
  });

  it('rejects legacy and unknown notification producers at the API boundary', async () => {
    const source = await readFile(new URL('../api/notifications.js', import.meta.url), 'utf8');
    expect(source).toContain("error: 'FEATURE_DISABLED'");
    expect(source).toContain("error: 'INVALID_NOTIFICATION_TYPE'");
    expect(source).toContain('ACTIVE_NOTIFICATION_TYPES.has(input.type)');
  });

  it('makes queued legacy work terminal without retrying or sending', async () => {
    const source = await readFile(new URL('../functions/index.js', import.meta.url), 'utf8');
    expect(source).toContain("reason: 'feature_disabled'");
    expect(source).toContain("'feature_disabled', 'push_type_not_allowed', 'push_disabled_by_policy'");
    expect(source).toContain("return logSkipped('skipped', LEGACY_NOTIFICATION_TYPES.has(notification.type) ? 'feature_disabled'");
  });

  it('keeps subscription endpoint status checks out of URLs and offers stale repair only with granted permission', async () => {
    const client = await readFile(new URL('../src/pushNotifications.ts', import.meta.url), 'utf8');
    const api = await readFile(new URL('../api/push-subscriptions.js', import.meta.url), 'utf8');
    expect(client).toContain("body: JSON.stringify({ action: 'status', endpoint: subscription.endpoint })");
    expect(client).not.toContain('?endpoint=');
    expect(client).toContain("Notification.permission !== 'granted'");
    expect(client).toContain("serverState.subscriptionStatus === 'stale' || serverState.subscriptionStatus === 'missing'");
    expect(api).toContain("req.body?.action === 'status'");
    expect(api).not.toContain('req.query?.endpoint');
    expect(api).toContain("endpoint: FieldValue.delete()");
    expect(api).toContain("subscriptionStatusFor(doc.data(), user.sub) === 'active'");
    const functions = await readFile(new URL('../functions/index.js', import.meta.url), 'utf8');
    expect(functions).toContain("defineString('WORKER_SERVICE_ACCOUNT')");
    expect(functions).toContain('function workerServiceAccount()');
    expect(functions).not.toContain('const WORKER_SERVICE_ACCOUNT =');
    expect(functions).toContain("failureReason: details.normalizedErrorCode");
    expect(functions).toContain("endpoint: FieldValue.delete()");
  });
});
