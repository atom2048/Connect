import type { Attachment, AttachmentKind, Comment, Notification, Poll, Post, Story, TimestampLike, UserProfile } from './domain';
import { resolveAvatarURL } from '../avatar.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}


function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}


function attachmentKindValue(value: unknown): AttachmentKind {
  return value === 'image' || value === 'video' || value === 'audio' || value === 'file' ? value : 'file';
}

function toAttachment(value: unknown): Attachment | null {
  if (!isRecord(value)) return null;
  const url = stringValue(value.url);
  if (!url) return null;
  return {
    id: stringValue(value.id, `attachment_${Date.now()}_${Math.random().toString(36).slice(2)}`),
    kind: attachmentKindValue(value.kind),
    url,
    name: stringValue(value.name, 'ファイル'),
    size: numberValue(value.size),
    mimeType: stringValue(value.mimeType, 'application/octet-stream'),
    thumbnailUrl: stringValue(value.thumbnailUrl),
    previewUrl: stringValue(value.previewUrl),
    previewStoragePath: stringValue(value.previewStoragePath),
    duration: optionalNumberValue(value.duration),
    width: optionalNumberValue(value.width),
    height: optionalNumberValue(value.height),
    storagePath: stringValue(value.storagePath),
  };
}

function attachmentArray(value: unknown): Attachment[] {
  return Array.isArray(value) ? value.map(toAttachment).filter((item): item is Attachment => item !== null) : [];
}
function timestampValue(value: unknown): TimestampLike {
  if (value == null) return null;
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number') return value;
  if (isRecord(value) && typeof value.toDate === 'function') return value as { toDate: () => Date };
  return null;
}
function toPoll(value: unknown): Poll | null {
  if (!isRecord(value)) return null;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .filter(isRecord)
    .map(option => ({
      text: stringValue(option.text),
      votes: numberValue(option.votes),
    }))
    .filter(option => option.text.length > 0);

  const question = stringValue(value.question);
  if (!question && options.length === 0) return null;

  return {
    question,
    options,
    expiresAt: timestampValue(value.expiresAt),
    votes: isRecord(value.votes)
      ? Object.fromEntries(Object.entries(value.votes).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
      : undefined,
  };
}
export function toUserProfile(raw: unknown, uid: string): UserProfile {
  const data = isRecord(raw) ? raw : {};
  return {
    uid,
    email: stringValue(data.email),
    displayName: stringValue(data.displayName, stringValue(data.name, '不明')),
    username: stringValue(data.username, uid),
    bio: stringValue(data.bio),
    photoURL: resolveAvatarURL(data),
    profilePhotoStoragePath: stringValue(data.profilePhotoStoragePath),
    profilePhotoPreviewStoragePath: stringValue(data.profilePhotoPreviewStoragePath),
    profilePhotoPreviewURL: stringValue(data.profilePhotoPreviewURL),
    profilePhotoWidth: optionalNumberValue(data.profilePhotoWidth),
    profilePhotoHeight: optionalNumberValue(data.profilePhotoHeight),
    profileImage: stringValue(data.profileImage),
    coverImage: stringValue(data.coverImage),
    coverURL: stringValue(data.coverURL) || stringValue(data.coverUrl) || stringValue(data.coverImage),
    coverPhotoStoragePath: stringValue(data.coverPhotoStoragePath),
    coverPhotoPreviewStoragePath: stringValue(data.coverPhotoPreviewStoragePath),
    coverPhotoPreviewURL: stringValue(data.coverPhotoPreviewURL),
    coverPhotoWidth: optionalNumberValue(data.coverPhotoWidth),
    coverPhotoHeight: optionalNumberValue(data.coverPhotoHeight),
    friendsCount: numberValue(data.friendsCount),
    postsCount: numberValue(data.postsCount),
    createdAt: timestampValue(data.createdAt),
    updatedAt: timestampValue(data.updatedAt),
  };
}

export function toPost(raw: unknown, id: string): Post {
  const data = isRecord(raw) ? raw : {};
  const attachments = attachmentArray(data.attachments);
  const legacyImageURL = stringValue(data.imageURL);
  const storedImageURLs = stringArray(data.imageURLs);
  const imageURLs = storedImageURLs.length > 0
    ? storedImageURLs
    : stringArray(data.images).length > 0
      ? stringArray(data.images)
      : legacyImageURL
        ? [legacyImageURL]
        : attachments.filter(item => item.kind === 'image').map(item => item.url);
  return {
    id,
    userId: stringValue(data.userId, stringValue(data.authorId)),
    authorId: stringValue(data.authorId),
    text: stringValue(data.text),
    imageURL: legacyImageURL || undefined,
    imageURLs,
    imageAlts: stringArray(data.imageAlts),
    attachments,
    videoURL: stringValue(data.videoURL) || attachments.find(item => item.kind === 'video')?.url || '',
    gifURL: stringValue(data.gifURL),
    mediaAltTexts: stringArray(data.mediaAltTexts),
    hashtags: stringArray(data.hashtags),
    mentions: stringArray(data.mentions),
    visibility: data.visibility === 'friends' || data.visibility === 'private' ? data.visibility : 'public',
    likesCount: numberValue(data.likesCount),
    commentsCount: numberValue(data.commentsCount),
    repostsCount: numberValue(data.repostsCount),
    bookmarksCount: numberValue(data.bookmarksCount),
    viewCount: numberValue(data.viewCount),
    profileClickCount: numberValue(data.profileClickCount),
    poll: toPoll(data.poll),
    quotedPostId: stringValue(data.quotedPostId),
    threadId: stringValue(data.threadId),
    threadIndex: numberValue(data.threadIndex),
    pinned: booleanValue(data.pinned),
    edited: booleanValue(data.edited),
    createdAt: timestampValue(data.createdAt),
    updatedAt: timestampValue(data.updatedAt),
    scheduledAt: timestampValue(data.scheduledAt),
  };
}

export function toComment(raw: unknown, id: string): Comment {
  const data = isRecord(raw) ? raw : {};
  const storedAttachments = attachmentArray(data.attachments);
  const legacyImageURL = stringValue(data.imageURL);
  const legacyImageURLs = stringArray(data.imageURLs);
  const legacyVideoURL = stringValue(data.videoURL);
  const legacyAudioURL = stringValue(data.audioURL);
  const legacyFileURL = stringValue(data.fileURL);
  const legacyFileName = stringValue(data.fileName, 'ファイル');
  const attachments = storedAttachments.length > 0 ? storedAttachments : [
    ...(legacyImageURL ? [{ id: `${id}_image`, kind: 'image' as const, url: legacyImageURL, name: '画像', size: 0, mimeType: 'image/*' }] : []),
    ...legacyImageURLs.map((url, index) => ({ id: `${id}_image_${index}`, kind: 'image' as const, url, name: '画像', size: 0, mimeType: 'image/*' })),
    ...(legacyVideoURL ? [{ id: `${id}_video`, kind: 'video' as const, url: legacyVideoURL, name: '動画', size: 0, mimeType: 'video/*' }] : []),
    ...(legacyAudioURL ? [{ id: `${id}_audio`, kind: 'audio' as const, url: legacyAudioURL, name: '音声', size: 0, mimeType: 'audio/*' }] : []),
    ...(legacyFileURL ? [{ id: `${id}_file`, kind: 'file' as const, url: legacyFileURL, name: legacyFileName, size: 0, mimeType: 'application/octet-stream' }] : []),
  ];
  return {
    id,
    postId: stringValue(data.postId),
    userId: stringValue(data.userId),
    text: stringValue(data.text),
    parentId: typeof data.parentId === 'string' ? data.parentId : null,
    attachments,
    imageURL: legacyImageURL,
    imageURLs: legacyImageURLs,
    videoURL: legacyVideoURL,
    audioURL: legacyAudioURL,
    fileURL: legacyFileURL,
    fileName: legacyFileName,
    likesCount: numberValue(data.likesCount),
    createdAt: timestampValue(data.createdAt),
  };
}

export function toNotification(raw: unknown, id: string): Notification {
  const data = isRecord(raw) ? raw : {};
  return {
    id,
    userId: stringValue(data.userId),
    actorId: stringValue(data.actorId),
    type: stringValue(data.type),
    text: stringValue(data.text),
    postId: stringValue(data.postId),
    commentId: stringValue(data.commentId),
    conversationId: stringValue(data.conversationId),
    read: booleanValue(data.read),
    createdAt: timestampValue(data.createdAt),
  };
}

export function toStory(raw: unknown, id: string): Story {
  const data = isRecord(raw) ? raw : {};
  const mediaType = data.mediaType === 'image' || data.mediaType === 'video' ? data.mediaType : 'text';
  return {
    id,
    authorId: stringValue(data.authorId),
    text: stringValue(data.text),
    mediaUrl: stringValue(data.mediaUrl),
    mediaType,
    thumbnailUrl: stringValue(data.thumbnailUrl),
    previewStoragePath: stringValue(data.previewStoragePath),
    mediaStoragePath: stringValue(data.mediaStoragePath),
    mediaWidth: optionalNumberValue(data.mediaWidth),
    mediaHeight: optionalNumberValue(data.mediaHeight),
    mediaDuration: optionalNumberValue(data.mediaDuration),
    backgroundColor: stringValue(data.backgroundColor),
    gradient: stringValue(data.gradient),
    visibility: data.visibility === 'friends' || data.visibility === 'private' ? data.visibility : 'public',
    poll: toPoll(data.poll),
    viewCount: numberValue(data.viewCount),
    reactionCount: numberValue(data.reactionCount),
    createdAt: timestampValue(data.createdAt),
    expiresAt: timestampValue(data.expiresAt),
    deletedAt: timestampValue(data.deletedAt),
  };
}







