import { Timestamp } from 'firebase-admin/firestore';
import { notificationId, notificationCopy, notificationUrl, freshnessFor, NOTIFICATION_SCHEMA_VERSION, NOTIFICATION_PIPELINE_VERSION, PUSH_PAYLOAD_VERSION } from './notification-domain.js';

// Firestore events are at-least-once. The API and trigger use the same identity.
export async function materializeCommentLikeNotification(db, like, likeId) {
  if (like?.type !== 'comment' || !like.commentId || !like.userId
    || likeId !== `comment_${like.commentId}_${like.userId}`) return false;
  const comment = await db.doc(`comments/${like.commentId}`).get();
  const source = comment.exists ? comment.data() : null;
  if (!source?.userId || !source.postId || source.userId === like.userId) return false;
  const actor = await db.doc(`users/${like.userId}`).get();
  const profile = actor.exists ? actor.data() : {};
  const id = notificationId({ type: 'like', actorId: like.userId, recipientId: source.userId, eventId: likeId });
  const ref = db.doc(`notifications/${id}`);
  const createdAt = like.createdAt || Timestamp.now();
  const notification = {
    type: 'like', userId: source.userId, fromUserId: like.userId,
    postId: source.postId, commentId: like.commentId, eventId: likeId,
    fromUserDisplayName: profile.displayName || '', fromUserUsername: profile.username || '',
    fromUserPhotoURL: profile.photoURL || '', fromUserAvatarColor: profile.avatarColor || '',
    ...freshnessFor('like', createdAt.toMillis()),
    schemaVersion: NOTIFICATION_SCHEMA_VERSION, pipelineVersion: NOTIFICATION_PIPELINE_VERSION,
    payloadVersion: PUSH_PAYLOAD_VERSION, pushEnabled: true, read: false, createdAt, updatedAt: createdAt,
  };
  Object.assign(notification, notificationCopy('like', notification), { deepLink: notificationUrl(notification) });
  return db.runTransaction(async transaction => {
    const [existing, currentLike, post] = await Promise.all([
      transaction.get(ref), transaction.get(db.doc(`likes/${likeId}`)), transaction.get(db.doc(`posts/${source.postId}`)),
    ]);
    if (existing.exists || !currentLike.exists || !post.exists || currentLike.data()?.eventId !== likeId) return false;
    transaction.create(ref, notification);
    return true;
  });
}
