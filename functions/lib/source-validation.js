import { NOTIFICATION_TYPES, PUSH_ENABLED_TYPES } from './notification-domain.js';

async function documentData(adminDb, path) {
  if (!path || path.endsWith('/_')) return null;
  const snapshot = await adminDb.doc(path).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

function eventMatches(notification, eventId) {
  return typeof notification?.eventId === 'string'
    && notification.eventId.length > 0
    && notification.eventId === eventId;
}

async function sourceContainsRecipientMention(adminDb, source, recipientId) {
  if (Array.isArray(source?.mentionedUserIds) && source.mentionedUserIds.includes(recipientId)) return true;
  const recipient = await documentData(adminDb, `users/${recipientId}`);
  const aliases = [recipient?.username, recipient?.displayName]
    .filter(Boolean)
    .map(value => String(value).replace(/^@/, '').normalize('NFC').trim().toLowerCase());
  const mentions = Array.isArray(source?.mentions)
    ? source.mentions.map(value => String(value).replace(/^@/, '').normalize('NFC').trim().toLowerCase())
    : [];
  return aliases.some(alias => alias && mentions.includes(alias));
}

export async function validateNotificationSource(adminDb, actorId, notification, { requirePushType = false } = {}) {
  if (!notification || !actorId) return { valid: false, reason: 'invalid_notification' };
  if (notification.fromUserId !== actorId || notification.userId === actorId) return { valid: false, reason: 'actor_recipient_mismatch' };
  if (!NOTIFICATION_TYPES.has(notification.type)) return { valid: false, reason: 'unknown_type' };
  if (requirePushType && !PUSH_ENABLED_TYPES.has(notification.type)) return { valid: false, reason: 'push_type_not_allowed' };
  if (typeof notification.eventId !== 'string' || notification.eventId.length === 0) return { valid: false, reason: 'missing_event_id' };

  if (notification.type === 'like' && notification.commentId) {
    const [comment, like, post] = await Promise.all([
      documentData(adminDb, `comments/${notification.commentId}`),
      documentData(adminDb, `likes/comment_${notification.commentId}_${actorId}`),
      documentData(adminDb, `posts/${notification.postId || '_'}`),
    ]);
    return comment && like && post && comment.userId === notification.userId
      && comment.postId === notification.postId && like.type === 'comment'
      && like.commentId === notification.commentId && like.userId === actorId
      && eventMatches(notification, `comment_${notification.commentId}_${actorId}`)
      && eventMatches(notification, like.eventId)
      ? { valid: true } : { valid: false, reason: 'invalid_comment_like_source' };
  }

  if (notification.type === 'like') {
    const [post, like] = await Promise.all([
      documentData(adminDb, `posts/${notification.postId || '_'}`),
      documentData(adminDb, `likes/${notification.postId || '_'}_${actorId}`),
    ]);
    return post && like && post.userId === notification.userId && like.userId === actorId && eventMatches(notification, like.eventId)
      ? { valid: true } : { valid: false, reason: 'invalid_like_source' };
  }

  if (['comment', 'reply', 'mention'].includes(notification.type)) {
    const comment = notification.commentId ? await documentData(adminDb, `comments/${notification.commentId}`) : null;
    const post = await documentData(adminDb, `posts/${notification.postId || '_'}`);
    if (!post) return { valid: false, reason: 'missing_post_source' };
    if (!comment && notification.type === 'mention') {
      const valid = post.userId === actorId && eventMatches(notification, `${post.id}_${notification.userId}`)
        && await sourceContainsRecipientMention(adminDb, post, notification.userId);
      return valid ? { valid: true } : { valid: false, reason: 'invalid_post_mention_source' };
    }
    if (!comment || comment.userId !== actorId || comment.postId !== notification.postId) return { valid: false, reason: 'invalid_comment_source' };
    if (notification.type !== 'mention' && !eventMatches(notification, comment.id)) return { valid: false, reason: 'comment_event_mismatch' };
    if (notification.type === 'mention' && (!eventMatches(notification, `${comment.id}_${notification.userId}`)
      || !(await sourceContainsRecipientMention(adminDb, comment, notification.userId)))) {
      return { valid: false, reason: 'invalid_comment_mention_source' };
    }
    if (notification.type === 'reply' && comment.parentId) {
      const parent = await documentData(adminDb, `comments/${comment.parentId}`);
      return parent?.userId === notification.userId ? { valid: true } : { valid: false, reason: 'invalid_reply_target' };
    }
    if (notification.type === 'reply') return { valid: false, reason: 'missing_reply_parent' };
    return post.userId === notification.userId || notification.type === 'mention'
      ? { valid: true } : { valid: false, reason: 'invalid_comment_recipient' };
  }

  if (notification.type === 'repost') {
    const [post, repost] = await Promise.all([
      documentData(adminDb, `posts/${notification.postId || '_'}`),
      documentData(adminDb, `reposts/${actorId}_${notification.postId || '_'}`),
    ]);
    if (!post || !repost || post.userId !== notification.userId || repost.userId !== actorId) return { valid: false, reason: 'invalid_repost_source' };
    if (String(notification.eventId).startsWith('quote-repost:')) {
      const quotePostId = String(notification.eventId).slice('quote-repost:'.length);
      const quotePost = await documentData(adminDb, `posts/${quotePostId}`);
      return quotePost?.userId === actorId && quotePost.quotedPostId === notification.postId
        && repost.quotePostId === quotePostId && repost.eventId === notification.eventId
        ? { valid: true } : { valid: false, reason: 'invalid_quote_repost_source' };
    }
    return repost.eventId === notification.eventId ? { valid: true } : { valid: false, reason: 'repost_event_mismatch' };
  }

  if (notification.type === 'dm') {
    const conversation = await documentData(adminDb, `conversations/${notification.conversationId || '_'}`);
    const message = notification.messageId
      ? await documentData(adminDb, `conversations/${notification.conversationId || '_'}/messages/${notification.messageId}`)
      : null;
    return conversation?.participants?.includes?.(actorId)
      && conversation.participants.includes(notification.userId)
      && message?.senderId === actorId
      && eventMatches(notification, message.id)
      ? { valid: true } : { valid: false, reason: 'invalid_dm_source' };
  }

  if (notification.type === 'friend_story' || notification.type === 'story_reaction' || notification.type === 'story_reply') {
    const story = await documentData(adminDb, `stories/${notification.storyId || '_'}`);
    if (!story) return { valid: false, reason: 'invalid_story_source' };
    if (notification.type === 'friend_story') {
      return story.authorId === actorId ? { valid: true } : { valid: false, reason: 'invalid_story_source' };
    }
    if (story.authorId !== notification.userId || story.authorId === actorId) {
      return { valid: false, reason: 'invalid_story_recipient' };
    }
    if (notification.type === 'story_reaction') {
      const reactionKey = notification.reactionType || notification.context || '_';
      const reaction = await documentData(adminDb, `storyReactions/${notification.storyId}_${actorId}_${reactionKey}`);
      const expectedEventId = `${notification.storyId}_${actorId}_${reactionKey}`;
      return reaction?.senderId === actorId && eventMatches(notification, expectedEventId)
        ? { valid: true } : { valid: false, reason: 'invalid_story_reaction_source' };
    }
    if (notification.type === 'story_reply') {
      const message = notification.messageId
        ? await documentData(adminDb, `conversations/${notification.conversationId || '_'}/messages/${notification.messageId}`)
        : null;
      return message?.senderId === actorId && message.replyTo?.storyId === notification.storyId
        && eventMatches(notification, message.id)
        ? { valid: true } : { valid: false, reason: 'invalid_story_reply_source' };
    }
    return { valid: true };
  }

  if (['friend_request', 'friend_accept'].includes(notification.type)) {
    const friendshipId = [actorId, notification.userId].sort().join('_');
    const friendship = await documentData(adminDb, `friendships/${friendshipId}`);
    if (!friendship) return { valid: false, reason: 'missing_friendship' };
    if (notification.type === 'friend_request') {
      return friendship.status === 'pending'
        && friendship.requester === actorId
        && friendship.friendId === notification.userId
        && eventMatches(notification, friendship.requestEventId)
        ? { valid: true } : { valid: false, reason: 'invalid_friend_request_source' };
    }
    return friendship.status === 'accepted'
      && [friendship.requester, friendship.friendId].includes(actorId)
      && [friendship.requester, friendship.friendId].includes(notification.userId)
      && actorId !== notification.userId
      && eventMatches(notification, friendship.acceptEventId)
      ? { valid: true } : { valid: false, reason: 'invalid_friend_accept_source' };
  }

  return { valid: false, reason: 'unsupported_source' };
}
