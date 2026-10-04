export type NotificationIdentity = {
  type: string;
  fromUserId?: string;
  userId?: string;
  eventId?: string;
};

// Canonical client-side allowlist. Persisted dm/story_reply values remain
// decodeable by legacy compatibility code but are never rendered, counted,
// marked read in bulk, or sent to a producer from the active client.
export const ACTIVE_NOTIFICATION_TYPES = [
  'like',
  'comment',
  'reply',
  'mention',
  'repost',
  'friend_request',
  'friend_accept',
  'friend_story',
  'story_reaction',
  'post_moderated',
] as const;

export type ActiveNotificationType = typeof ACTIVE_NOTIFICATION_TYPES[number];
// Retired notification types remain excluded from every active client query so
// historic documents never resurface in the notification UI.
export const LEGACY_NOTIFICATION_TYPES = [
  'dm',
  'story_reply',
  'space_start',
  'space_end',
  'space_speaker_request',
  'space_speaker_approved',
  'space_speaker_removed',
] as const;

export function isActiveNotificationType(type: unknown): type is ActiveNotificationType {
  return typeof type === 'string' && (ACTIVE_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

export function shouldCreateNotification(data: Pick<NotificationIdentity, 'fromUserId' | 'userId'>): boolean {
  return Boolean(data.userId && data.fromUserId && data.userId !== data.fromUserId);
}

export function stableNotificationDocumentId(data: NotificationIdentity): string {
  if (!data.eventId) return '';
  return `${data.type}_${data.fromUserId}_${data.userId}_${data.eventId}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 150);
}
