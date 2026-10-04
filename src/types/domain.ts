export type Id = string;
export type Visibility = 'public' | 'friends' | 'private';
export type PostContentKind = 'user' | 'news' | 'advertisement' | 'system' | 'unclassified';
export type TimestampLike = Date | string | number | { toDate: () => Date } | null | undefined;

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

export interface Attachment {
  id: Id;
  kind: AttachmentKind;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  previewStoragePath?: string;
  duration?: number;
  width?: number;
  height?: number;
  storagePath?: string;
}

export interface AuthUser {
  uid: Id;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface UserProfile {
  uid: Id;
  email?: string;
  displayName: string;
  username: string;
  bio?: string;
  photoURL?: string;
  profileImage?: string;
  coverImage?: string;
  coverURL?: string;
  profilePhotoStoragePath?: string;
  profilePhotoPreviewStoragePath?: string;
  profilePhotoPreviewURL?: string;
  profilePhotoWidth?: number;
  profilePhotoHeight?: number;
  coverPhotoStoragePath?: string;
  coverPhotoPreviewStoragePath?: string;
  coverPhotoPreviewURL?: string;
  coverPhotoWidth?: number;
  coverPhotoHeight?: number;
  avatarColor?: string;
  friendsCount?: number;
  postsCount?: number;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

export type User = UserProfile;

export interface PollOption {
  text: string;
  votes?: number;
}

export interface Poll {
  question: string;
  options: PollOption[];
  expiresAt?: TimestampLike;
  votes?: Record<string, number>;
}

export interface Post {
  id: Id;
  userId: Id;
  authorId?: Id;
  text: string;
  contentType?: PostContentKind | string;
  contentKind?: string;
  isSponsored?: boolean;
  sponsored?: boolean;
  isAd?: boolean;
  imageURL?: string;
  imageURLs: string[];
  imageAlts?: string[];
  attachments?: Attachment[];
  videoURL?: string;
  gifURL?: string;
  deletedAt?: TimestampLike | null;
  deleteReason?: string;
  mediaAltTexts?: string[];
  hashtags: string[];
  mentions?: string[];
  visibility?: Visibility;
  likesCount: number;
  commentsCount: number;
  repostsCount: number;
  bookmarksCount?: number;
  viewCount?: number;
  profileClickCount?: number;
  poll?: Poll | null;
  quotedPostId?: Id;
  quotedPost?: Post | null;
  threadId?: Id;
  threadIndex?: number;
  pinned?: boolean;
  edited?: boolean;
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
  scheduledAt?: TimestampLike;
}

export interface Comment {
  id: Id;
  postId: Id;
  userId: Id;
  text: string;
  parentId?: Id | null;
  attachments?: Attachment[];
  imageURL?: string;
  imageURLs?: string[];
  videoURL?: string;
  audioURL?: string;
  fileURL?: string;
  fileName?: string;
  likesCount?: number;
  createdAt?: TimestampLike;
  editedAt?: TimestampLike;
}

export interface Like {
  id?: Id;
  postId?: Id;
  commentId?: Id;
  userId: Id;
  createdAt?: TimestampLike;
}

export interface Bookmark {
  id?: Id;
  postId: Id;
  userId: Id;
  createdAt?: TimestampLike;
}

export interface Follow {
  id?: Id;
  userId: Id;
  friendId: Id;
  status: 'pending' | 'accepted' | 'rejected' | 'blocked';
  createdAt?: TimestampLike;
  updatedAt?: TimestampLike;
}

export interface Notification {
  id: Id;
  userId: Id;
  actorId?: Id;
  fromUserId?: Id;
  type: string;
  text?: string;
  context?: string;
  postId?: Id;
  commentId?: Id;
  storyId?: Id;
  conversationId?: Id;
  messageId?: Id;
  deepLink?: string;
  eventId?: string;
  read: boolean;
  createdAt?: TimestampLike;
}

export interface Story {
  id: Id;
  authorId: Id;
  text?: string;
  mediaUrl?: string;
  mediaType: 'text' | 'image' | 'video';
  thumbnailUrl?: string;
  previewStoragePath?: string;
  mediaStoragePath?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  mediaDuration?: number;
  backgroundColor?: string;
  gradient?: string;
  visibility?: Visibility;
  poll?: Poll | null;
  viewCount?: number;
  reactionCount?: number;
  createdAt?: TimestampLike;
  expiresAt?: TimestampLike;
  deletedAt?: TimestampLike | null;
}

export interface SearchResult<T = UserProfile | Post> {
  type: 'user' | 'post' | 'hashtag' | 'news' | 'media';
  id: Id;
  item: T;
}

export interface AppState {
  user: AuthUser | null;
  userProfile: UserProfile | null;
  currentPage: string;
  theme: 'light' | 'dark';
  unreadNotifications: number;
  loading: boolean;
}






