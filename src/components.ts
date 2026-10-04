import { escapeHtml, formatTime, formatRelativeTime, getInitials, generateAvatarColor, truncateText } from './utils.ts';
import { getState } from './state.ts';
import { getPostContentKind } from './contentKinds.ts';
import { t } from './i18n.ts';
import { attachmentDisplayURL, formatFileSize } from './attachments.ts';
import { resolveAvatarURL } from './avatar.ts';
import type { Attachment, Comment, Notification, Post, TimestampLike, UserProfile } from './types/domain.ts';

interface ExpandablePostTextOptions {
  expanded?: boolean;
  detailHref?: string;
  postId?: string;
}

interface TimestampWithSeconds {
  seconds: number;
}

interface PollOptionView {
  text?: string;
  votes?: string[];
}

interface PollView {
  question?: string;
  options?: PollOptionView[] | Record<string, PollOptionView>;
  totalVotes?: number;
  expiresAt?: TimestampLike | TimestampWithSeconds;
}

interface QuotedPostView extends Partial<Post> {
  authorDisplayName?: string;
  authorUsername?: string;
}

interface RenderPost extends Omit<Partial<Post>, 'poll' | 'quotedPost'> {
  id?: string;
  userId: string;
  imageURL?: string;
  imageURLs?: string[];
  imageAlts?: string[];
  attachments?: Attachment[];
  videoURL?: string;
  bookmarked?: boolean;
  editedAt?: TimestampLike;
  poll?: PollView | null;
  quotedPost?: QuotedPostView | null;
  repostsCount?: number;
  sharesCount?: number;
  threadCount?: number;
}

interface RenderPostOptions {
  detail?: boolean;
  fullText?: boolean;
}

interface RenderComment extends Partial<Comment> {
  id?: string;
  userId: string;
  authorDisplayName?: string;
  authorUsername?: string;
  authorPhotoURL?: string;
  authorAvatarColor?: string;
  imageURL?: string;
  fileURL?: string;
  fileName?: string;
}

interface RenderNotification extends Partial<Notification> {
  id?: string;
  context?: string;
  fromUser?: Partial<UserProfile>;
  fromUserId?: string;
  conversationId?: string;
  read?: boolean;
}

interface RenderUserListOptions {
  showFollowBtn?: boolean;
  friendshipStatus?: 'friends' | 'pending_sent' | 'pending_received' | 'none';
  onClick?: string;
}

interface AppStateUser {
  uid: string;
}

function hasTimestampSeconds(value: TimestampLike | TimestampWithSeconds): value is TimestampWithSeconds {
  return typeof value === 'object' && value !== null && 'seconds' in value && typeof value.seconds === 'number';
}

function pollOptionsArray(options: PollView['options']): PollOptionView[] {
  if (Array.isArray(options)) return options;
  return options ? Object.values(options) : [];
}


type AvatarHtmlOptions = {
  imageClassName?: string;
  fallbackClassName?: string;
  mediaClickable?: boolean;
  mediaLabel?: string;
};

export function createAvatarHTML(profile: Partial<UserProfile> | null | undefined, size = 40, options: AvatarHtmlOptions = {}): string {
  const name = profile?.displayName || 'User';
  const photoURL = resolveAvatarURL(profile);
  const color = profile?.avatarColor || generateAvatarColor(name);
  const initials = getInitials(name);
  const imageClassName = ['avatar-img', options.imageClassName || ''].filter(Boolean).join(' ');
  const fallbackClassName = ['avatar-fallback', 'avatar-initials-fallback', options.fallbackClassName || ''].filter(Boolean).join(' ');
  const mediaAttributes = options.mediaClickable && photoURL
    ? ` data-profile-media="${escapeHtml(photoURL)}" role="button" tabindex="0" aria-label="${escapeHtml(options.mediaLabel || t('プロフィール画像を拡大'))}"`
    : '';
  const fallback = `<div class="${fallbackClassName}" style="width:${size}px;height:${size}px;border-radius:50%;background:${color};display:none;align-items:center;justify-content:center;color:white;font-weight:600;font-size:${Math.floor(size * 0.42)}px;flex-shrink:0;" aria-hidden="true">${initials}</div>`;
  if (photoURL) {
    return `<img src="${escapeHtml(photoURL)}" alt="${escapeHtml(name)}" class="${escapeHtml(imageClassName)}${options.mediaClickable ? ' profile-media-clickable' : ''}"${mediaAttributes} width="${size}" height="${size}" loading="lazy" decoding="async" fetchpriority="low" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;background:var(--input-border);" onerror="if(!this.dataset.avatarErrorLogged){this.dataset.avatarErrorLogged='true';console.warn('[Connect] avatar image failed to load',{host:(()=>{try{return new URL(this.currentSrc).host}catch{return 'unknown'}})()})}this.onerror=null;this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex'">${fallback}`;
  }
  return `<div class="${fallbackClassName}" style="width:${size}px;height:${size}px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:white;font-weight:600;font-size:${Math.floor(size * 0.42)}px;flex-shrink:0;" aria-hidden="true">${initials}</div>`;
}

function renderComposerAvatarPlaceholder(size = 40, loading = false): string {
  const classes = `avatar-fallback avatar-image-placeholder${loading ? ' skeleton-avatar' : ''}`;
  return `<div class="${classes}" style="width:${size}px;height:${size}px;border-radius:50%;${loading ? '' : 'background:var(--input-border);'}display:flex;flex-shrink:0;" aria-hidden="true"></div>`;
}

export function updateCurrentUserComposerAvatars(profile: Partial<UserProfile> | null): void {
  document.querySelectorAll<HTMLAnchorElement>('[data-current-user-avatar]').forEach((anchor) => {
    const size = Number(anchor.dataset.avatarSize) || 40;
    const uid = profile?.uid || '';
    anchor.dataset.avatarUserId = uid;
    if (uid) {
      anchor.href = `#/profile/${encodeURIComponent(uid)}`;
      anchor.innerHTML = createAvatarHTML(profile, size);
    } else {
      anchor.removeAttribute('href');
      anchor.innerHTML = renderComposerAvatarPlaceholder(size, true);
    }
  });
}

export function createAvatarElement(profile: Partial<UserProfile> | null | undefined, size = 40): Element | null {
  const div = document.createElement('div');
  div.innerHTML = createAvatarHTML(profile, size);
  return div.firstElementChild;
}

export function linkifyHashtags(text: string | number | null | undefined): string {
  if (!text) return '';
  const rawText = String(text);
  const urlAnchors: string[] = [];
  const protectedText = rawText.replace(/https?:\/\/[^\s<]+/g, (match: string) => {
    const trailing = (match.match(/[)、。.,!?！？]+$/) || [''])[0];
    const url = trailing ? match.slice(0, -trailing.length) : match;
    const token = `__CONNECT_URL_${urlAnchors.length}__`;
    const safeUrl = escapeHtml(url);
    urlAnchors.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="text-link" data-no-open>${safeUrl}</a>${escapeHtml(trailing)}`);
    return token;
  });
  let result = escapeHtml(protectedText);
  result = result.replace(/[#＃]([\w\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+)/g, (match: string, tag: string) => `<a href="#/explore?query=${encodeURIComponent(`#${tag}`)}&tab=posts" class="hashtag-link" data-navigate>${match}</a>`);
  result = result.replace(/(^|[\s>])@([A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff-]+)/g, (_match: string, prefix: string, name: string) => `${prefix}<a href="#/u/${encodeURIComponent(name)}" class="mention-link" data-navigate>@${name}</a>`);
  urlAnchors.forEach((anchor, index) => {
    result = result.replace(`__CONNECT_URL_${index}__`, anchor);
  });
  return result;
}

function isExpandablePostText(text = ''): boolean {
  const value = String(text || '');
  const lines = value.split(/\r\n|\r|\n/).length;
  return value.length > 100 || lines > 4 || /[.…]\s*$/.test(value);
}

export function renderExpandablePostText(text = '', options: ExpandablePostTextOptions = {}): string {
  const {
    expanded = false,
    detailHref = '',
    postId = '',
  } = options;
  const rawText = String(text || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  if (!rawText) return '';
  const expandable = !expanded && isExpandablePostText(rawText);
  const linkedText = linkifyHashtags(rawText);
  const classes = `post-text ${expandable ? 'post-text-clamped' : ''} ${expanded ? 'post-text-full' : ''}`.trim();
  const body = `<div class="${classes}" data-post-id="${escapeHtml(postId)}">${linkedText}</div>`;
  const more = expandable
    ? `<a href="${escapeHtml(detailHref || `#/post/${postId}`)}" class="post-text-more" data-action="post-text-more" data-post-id="${escapeHtml(postId)}" data-navigate data-no-open aria-label="${t('投稿全文を表示')}">${t('もっと見る')}</a>`
    : '';
  return body + more;
}

function timestampToMillis(value: TimestampLike | TimestampWithSeconds | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value) || 0;
  if (typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().getTime();
  }
  if (hasTimestampSeconds(value)) return value.seconds * 1000;
  return 0;
}

function pollExpiryMs(poll: PollView | null | undefined): number {
  return timestampToMillis(poll?.expiresAt);
}

export function renderPoll(poll: PollView | null | undefined, postId: string | undefined, userId: string | undefined): string {
  if (!poll || !poll.options) return '';
  const options = pollOptionsArray(poll.options)
    .map((option: PollOptionView) => ({
      text: option?.text || '',
      votes: Array.isArray(option?.votes) ? option.votes : [],
    }))
    .filter((option: { text: string; votes: string[] }) => option.text);
  if (!options.length) return '';
  const computedTotal = options.reduce((sum: number, option) => sum + option.votes.length, 0);
  const total = Math.max(poll.totalVotes || 0, computedTotal);
  const expiresAtMs = pollExpiryMs(poll);
  const expired = expiresAtMs > 0 && expiresAtMs <= Date.now();
  const userHasVoted = !!userId && options.some((option) => option.votes.includes(userId));
  const expiresLabel = expiresAtMs ? (expired ? t('投票は終了しました') : t('投票受付中')) : '';
  const questionId = `poll-question-${String(postId || 'post').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  let html = `<div class="poll-container ${expired ? 'poll-expired' : ''}" data-post-id="${escapeHtml(postId || '')}" data-poll-expired="${expired ? '1' : '0'}" role="group" aria-labelledby="${questionId}">`;
  html += `<h3 class="poll-question" id="${questionId}">${escapeHtml(poll.question || t('アンケート'))}</h3>`;
  options.forEach((option, idx) => {
    const votes = option.votes.length;
    const pct = total > 0 ? Math.round(votes / total * 100) : 0;
    const hasVoted = !!userId && option.votes.includes(userId);
    const optionLabel = `${option.text} ${pct}%${hasVoted ? ` · ${t('投票済み')}` : ''}`;
    html += `
      <button type="button" class="poll-option ${hasVoted ? 'poll-voted' : ''}" data-option="${idx}" aria-pressed="${hasVoted ? 'true' : 'false'}" aria-label="${escapeHtml(optionLabel)}" ${expired || userHasVoted ? 'disabled' : ''}>
        <div class="poll-bar-bg">
          <div class="poll-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="poll-option-content">
          <span class="poll-option-text">${escapeHtml(option.text)}${hasVoted ? `<span class="poll-option-selected" aria-hidden="true">✓</span>` : ''}</span>
          <span class="poll-option-pct">${total > 0 ? pct + '%' : '—'}</span>
        </span>
      </button>
    `;
  });
  html += `<div class="poll-total"><span class="poll-total-count">${total}${t('票')}</span>${expiresLabel ? `<span class="poll-status ${expired ? 'poll-status-ended' : ''}">${expiresLabel}</span>` : ''}</div></div>`;
  return html;
}

function renderQuotedPost(post: RenderPost): string {
  const quote = post.quotedPost;
  if (!quote || !post.quotedPostId) return '';
  const name = escapeHtml(quote.authorDisplayName || t('不明なユーザー'));
  const username = escapeHtml(quote.authorUsername || 'unknown');
  const text = truncateText(quote.text || '', 140);
  const image = (quote.imageURLs || [])[0];
  const missing = !quote.text && !image && !quote.videoURL;
  let html = '<a href="#/post/' + escapeHtml(post.quotedPostId) + '" class="quoted-post-card" data-navigate data-no-open>';
  html += '<div class="quoted-post-meta"><strong>' + name + '</strong><span>@' + username + '</span></div>';
  if (missing) {
    html += '<div class="quoted-post-missing">' + t('引用元の投稿を表示できません') + '</div>';
  } else {
    if (text) html += '<div class="quoted-post-text">' + linkifyHashtags(text) + '</div>';
    if (image) html += '<div class="quoted-post-thumb"><img src="' + escapeHtml(image) + '" alt="" loading="lazy" decoding="async" onerror="this.parentElement.remove()"></div>';
    if (quote.videoURL) html += '<div class="quoted-post-video">▶ ' + t('動画') + '</div>';
  }
  html += '</a>';
  return html;
}

export function renderPostCard(post: RenderPost, author: Partial<UserProfile> | null | undefined, liked = false, reposted = false, options: RenderPostOptions = {}): string {
  const currentUser = getState('user') as AppStateUser | null;
  const isOwner = currentUser && post.userId === currentUser.uid;
  const isDetail = options.detail === true || options.fullText === true;
  const displayName = escapeHtml(author?.displayName || t('不明なユーザー'));
  const username = escapeHtml(author?.username || 'unknown');
  const timeStr = post.createdAt ? formatRelativeTime(post.createdAt) : '';
  const fullDateStr = post.createdAt ? formatTime(post.createdAt) : '';
  const visibility = post.visibility || 'public';
  const visibilityLabel = visibility === 'friends' ? t('友達のみ') : (visibility === 'private' ? t('自分のみ') : t('全体公開'));
  const showVisibilityBadge = isDetail || visibility !== 'public';
  const scheduledMs = timestampToMillis(post.scheduledAt);
  const isScheduled = scheduledMs && scheduledMs > Date.now();
  const threadIndex = Number.isFinite(Number(post.threadIndex)) ? Number(post.threadIndex) : null;
  const threadCount = Number.isFinite(Number(post.threadCount)) ? Number(post.threadCount) : null;
  const isThreadPost = !!post.threadId && threadCount && threadCount > 1;
  const threadClasses = isThreadPost ? ` post-card-thread ${threadIndex === 0 ? 'post-card-thread-first' : ''} ${threadIndex === threadCount - 1 ? 'post-card-thread-last' : ''}` : '';
  const contentKind = getPostContentKind(post);
  const contentKindLabel = contentKind === 'unclassified'
    ? ''
    : contentKind === 'user'
      ? ''
      : contentKind === 'advertisement'
        ? t('広告 / PR')
        : contentKind === 'news'
          ? t('ニュース')
          : contentKind === 'system'
            ? t('システム画面')
            : '';

  return `
    <div class="post-card ${isDetail ? 'post-card-detail' : ''}${threadClasses}" data-post-id="${post.id || ''}" data-author-id="${escapeHtml(post.userId || '')}" data-visibility="${escapeHtml(visibility)}" data-action="open-post">
      ${isThreadPost ? `<div class="post-thread-rail" aria-hidden="true"></div>` : ''}
      <div class="post-header">
        <a href="#/profile/${post.userId}" class="post-author" data-navigate data-profile-hover-uid="${escapeHtml(post.userId || '')}">
          <span class="post-avatar">${createAvatarHTML(author, 40)}</span>
          <div class="post-author-info">
            <div class="post-author-name">${displayName}</div>
            <div class="post-meta">
              <span class="post-username">@${username}</span>
              <span class="post-time">· ${timeStr}</span>
            </div>
          </div>
        </a>
        <div class="post-card-menu">
          ${isOwner ? `<button type="button" class="post-menu-btn" data-action="edit-post" data-post-id="${post.id || ''}" title="${t('編集')}" aria-label="${t('投稿を編集')}">✏️</button>` : ''}
          ${isOwner ? `<button type="button" class="post-menu-btn" data-action="post-insights" data-post-id="${post.id || ''}" title="${t('インサイト')}" aria-label="${t('投稿インサイト')}">📊</button>` : ''}
          ${isOwner ? `<button type="button" class="post-delete-btn" data-action="delete-post" data-post-id="${post.id || ''}" title="${t('削除')}" aria-label="${t('投稿を削除')}">🗑️</button>` : ''}
          ${currentUser && !isOwner ? `<button type="button" class="post-menu-btn" data-action="report-post" data-post-id="${post.id || ''}" title="${t('報告')}" aria-label="${t('この投稿を報告')}">⚑</button>` : ''}
        </div>
      </div>

      <div class="post-body" data-action="open-post" data-post-id="${post.id || ''}">
        ${renderExpandablePostText(post.text || '', { expanded: isDetail, detailHref: `#/post/${post.id || ''}`, postId: post.id || '' })}
        ${renderPostImages(post)}
        ${post.videoURL ? `<div class="post-video post-video-lazy" data-post-id="${escapeHtml(post.id || '')}" data-no-open><button type="button" class="media-play-overlay" data-action="load-video" data-post-id="${escapeHtml(post.id || '')}" data-video-src="${escapeHtml(post.videoURL)}" aria-label="${t('動画を再生')}">▶</button><video data-post-id="${escapeHtml(post.id || '')}" data-src="${escapeHtml(post.videoURL)}" controls preload="none" playsinline loop aria-label="${t('投稿動画')}"></video></div>` : ''}
        ${post.poll ? renderPoll(post.poll, post.id, currentUser?.uid) : ''}
        ${renderQuotedPost(post)}
        ${contentKindLabel || showVisibilityBadge || isScheduled || post.editedAt || (post.hashtags || []).length ? `<div class="post-badges">
          ${contentKindLabel ? `<span class="post-badge content-kind-badge content-kind-${contentKind}">${contentKindLabel}</span>` : ''}
          ${showVisibilityBadge ? `<span class="post-badge visibility-badge">${visibilityLabel}</span>` : ''}
          ${isScheduled ? `<span class="post-badge scheduled-badge">${t('予約投稿')}</span>` : ''}
          ${post.editedAt ? `<span class="post-badge edited-badge">${t('編集済み')}</span>` : ''}
          ${(post.hashtags || []).slice(0, 3).map((tag: string) => `<a href="#/explore?query=${encodeURIComponent(`#${tag}`)}&tab=posts" class="post-badge hashtag-badge" data-navigate>#${escapeHtml(tag)}</a>`).join('')}
        </div>` : ''}
      </div>

      <div class="post-stats">
        <button class="post-stat post-stat-button" data-action="view-likes" data-post-id="${post.id || ''}" type="button"><span class="like-count">${post.likesCount || 0}</span> ${t('いいね')}</button>
        <span class="post-stat"><span class="comment-count">${post.commentsCount || 0}</span> ${t('コメント')}</span>
        <span class="post-stat"><span class="repost-count">${post.repostsCount || 0}</span> ${t('リポスト')}</span>
        <span class="post-stat post-stat-date">${fullDateStr}</span>
      </div>

      <div class="post-actions has-ask-ai has-share-menu">
        <button type="button" class="post-action-btn ${liked ? 'liked' : ''}" data-action="like" data-post-id="${post.id || ''}" aria-label="${liked ? t('いいね済み') : t('いいね')}" aria-pressed="${liked ? 'true' : 'false'}" aria-busy="false">
          <span class="action-icon" aria-hidden="true">${liked ? '❤️' : '🤍'}</span>
          <span class="like-sync-indicator" aria-hidden="true"></span>
          <span class="action-label">${liked ? t('いいね済み') : t('いいね')}</span>
        </button>
        <button class="post-action-btn" data-action="comment" data-post-id="${post.id || ''}" aria-label="${t('コメント')}">
          <span class="action-icon">💬</span>
          <span class="action-label">${t('コメント')}</span>
        </button>
        <button class="post-action-btn ${reposted ? 'reposted' : ''}" data-action="repost-menu" data-post-id="${post.id || ''}" aria-label="${reposted ? t('リポスト済み。メニューを開く') : t('リポストメニューを開く')}" aria-haspopup="menu" aria-expanded="false">
          <span class="action-icon">🔄</span>
          <span class="action-label">${reposted ? t('リポスト済み') : t('リポスト')}</span>
        </button>
        <button class="post-action-btn ${post.bookmarked ? 'bookmarked' : ''}" data-action="bookmark" data-post-id="${post.id || ''}" aria-label="${t('ブックマーク')}">
          <span class="action-icon">${post.bookmarked ? '🔖' : '📑'}</span>
          <span class="action-label">${post.bookmarked ? t('ブックマーク済み') : t('ブックマーク')}</span>
        </button>
        <button class="post-action-btn" data-action="share-menu" data-no-open data-post-id="${post.id || ''}" aria-label="${t('共有')}" aria-haspopup="menu" aria-expanded="false">
          <span class="action-icon" aria-hidden="true">↗</span>
          <span class="action-label">${t('共有')}</span>
        </button>
        <button class="post-action-btn ask-ai-post-action" data-action="ask-ai" data-no-open data-post-id="${post.id || ''}" data-author-id="${escapeHtml(post.userId || '')}" data-visibility="${escapeHtml(visibility)}" aria-label="Ask AI">
          <span class="action-icon" aria-hidden="true">✦</span>
          <span class="action-label">Ask AI</span>
        </button>
      </div>
    </div>
  `;
}

function renderPostImages(post: RenderPost): string {
  type RenderPostImage = { url: string; sourceUrl: string };
  const attachmentImages: RenderPostImage[] = (post.attachments || [])
    .filter((attachment: Attachment) => attachment.kind === 'image' && attachment.url)
    .map((attachment: Attachment) => ({ url: attachmentDisplayURL(attachment), sourceUrl: attachment.url }));
  const legacyUrls = post.imageURLs && post.imageURLs.length > 0 ? post.imageURLs : (post.imageURL ? [post.imageURL] : []);
  const legacyImage = (url: string): RenderPostImage => ({ url, sourceUrl: url });
  const images: RenderPostImage[] = attachmentImages.length > 0
    ? [...attachmentImages, ...legacyUrls.filter((url) => !attachmentImages.some((image) => image.sourceUrl === url)).map(legacyImage)]
    : legacyUrls.map(legacyImage);
  if (images.length === 0) return '';
  const alts = Array.isArray(post.imageAlts) ? post.imageAlts : [];
  const count = images.length;
  const postId = escapeHtml(post.id || '');
  const renderImage = (image: RenderPostImage, index: number): string => `
    <img src="${escapeHtml(image.url)}" alt="${escapeHtml(alts[index] || t('投稿画像'))}" loading="lazy" decoding="async"
      data-post-media-image="true" data-post-id="${postId}" data-media-kind="image" data-media-index="${index}" data-media-source="${escapeHtml(image.url)}">
    <span class="post-image-media-fallback" role="status" hidden>${t('画像を読み込めませんでした')}</span>
  `;
  if (count >= 5) {
    const items = images.map((image, i: number) => `
      <button class="post-image-carousel-item" data-action="open-image" data-no-open data-post-id="${postId}" data-media-kind="image" data-media-index="${i}" data-image-url="${escapeHtml(image.url)}" data-image-index="${i}" aria-label="${t('投稿画像を拡大')}">
        ${renderImage(image, i)}
        ${alts[i] ? `<span class="post-image-alt-trigger" data-action="image-alt" data-no-open data-alt-text="${escapeHtml(alts[i])}" role="button" tabindex="0" aria-label="${t('画像の説明を表示')}">ALT</span>` : ''}
        <span class="post-image-counter">${i + 1}/${count}</span>
      </button>
    `).join('');
    return `<div class="post-images-carousel" data-no-open>${items}</div>`;
  }
  let html = `<div class="post-images post-images-${Math.min(count, 4)}">`;
  images.slice(0, 4).forEach((image, i: number) => {
    html += `
      <button class="post-image" data-action="open-image" data-no-open data-post-id="${postId}" data-media-kind="image" data-media-index="${i}" data-image-url="${escapeHtml(image.url)}" data-image-index="${i}" aria-label="${t('投稿画像を拡大')}">
        ${renderImage(image, i)}
        ${alts[i] ? `<span class="post-image-alt-trigger" data-action="image-alt" data-no-open data-alt-text="${escapeHtml(alts[i])}" role="button" tabindex="0" aria-label="${t('画像の説明を表示')}">ALT</span>` : ''}
        ${i === 3 && count > 4 ? `<span class="post-image-more">+${count - 4}</span>` : ''}
      </button>
    `;
  });
  html += '</div>';
  return html;
}

export function renderComment(comment: RenderComment, author: Partial<UserProfile> | null | undefined, liked = false): string {
  const fallbackAuthor = author || {
    // Comment author snapshots are legacy creation-time data. Never render
    // them when the current profile lookup is unavailable.
    displayName: 'User',
    username: '',
    photoURL: '',
    avatarColor: '',
  };
  const displayName = escapeHtml(fallbackAuthor.displayName || 'User');
  const timeStr = comment.createdAt ? formatRelativeTime(comment.createdAt) : '';
  const text = linkifyHashtags(comment.text || '');
  const indent = comment.parentId ? 'comment-nested' : '';
  const currentUser = getState('user') as AppStateUser | null;
  const canManage = !!currentUser && currentUser.uid === comment.userId;
  const attachments = comment.attachments && comment.attachments.length > 0
    ? comment.attachments
    : [
        ...(comment.imageURL ? [{ id: `${comment.id || 'comment'}_image`, kind: 'image' as const, url: comment.imageURL, name: '画像', size: 0, mimeType: 'image/*' }] : []),
        ...((comment.imageURLs || []).map((url, index) => ({ id: `${comment.id || 'comment'}_image_${index}`, kind: 'image' as const, url, name: '画像', size: 0, mimeType: 'image/*' }))),
        ...(comment.videoURL ? [{ id: `${comment.id || 'comment'}_video`, kind: 'video' as const, url: comment.videoURL, name: '動画', size: 0, mimeType: 'video/*' }] : []),
        ...(comment.audioURL ? [{ id: `${comment.id || 'comment'}_audio`, kind: 'audio' as const, url: comment.audioURL, name: '音声', size: 0, mimeType: 'audio/*' }] : []),
        ...(comment.fileURL ? [{ id: `${comment.id || 'comment'}_file`, kind: 'file' as const, url: comment.fileURL, name: comment.fileName || 'ファイル', size: 0, mimeType: 'application/octet-stream' }] : []),
      ];
  const attachmentHtml = attachments.map((attachment) => {
    const url = escapeHtml(attachment.url);
    const previewUrl = escapeHtml(attachment.thumbnailUrl || attachment.previewUrl || attachment.url);
    const playableUrl = escapeHtml(attachment.previewUrl || attachment.url);
    const name = escapeHtml(attachment.name || 'ファイル');
    if (attachment.kind === 'image') return `<div class="comment-image"><img src="${previewUrl}" alt="${name}" loading="lazy" decoding="async" onerror="this.parentElement.style.display='none'"></div>`;
    if (attachment.kind === 'video') return `<div class="comment-video comment-video-lazy"><button type="button" class="media-play-overlay" data-action="load-video" data-video-src="${playableUrl}" aria-label="${t('動画を再生')}">▶</button><video data-src="${playableUrl}" controls preload="none" playsinline></video></div>`;
    if (attachment.kind === 'audio') return `<div class="comment-audio"><audio src="${url}" controls preload="none"></audio></div>`;
    const size = attachment.size ? ` <span class="comment-file-size">${escapeHtml(formatFileSize(attachment.size))}</span>` : '';
    return `<div class="comment-file"><a href="${url}" target="_blank" rel="noopener noreferrer" class="comment-file-link">＋ ${name}${size}</a></div>`;
  }).join('');
  const likeCount = comment.likesCount || 0;
  const likeBtnClass = liked ? 'comment-like-btn liked' : 'comment-like-btn';

  return `
    <div class="comment ${indent}" data-comment-id="${comment.id || ''}" data-comment-user-id="${escapeHtml(comment.userId || '')}" data-comment-text="${escapeHtml(comment.text || '')}">
      <a href="#/profile/${comment.userId}" class="comment-author" data-navigate data-profile-hover-uid="${escapeHtml(comment.userId || '')}">
        ${createAvatarHTML(fallbackAuthor, 32)}
      </a>
      <div class="comment-content">
        <div class="comment-header">
          <a href="#/profile/${comment.userId}" class="comment-name" data-navigate data-profile-hover-uid="${escapeHtml(comment.userId || '')}">${displayName}</a>
          <span class="comment-time">${timeStr}</span>
        </div>
        <div class="comment-text">${text}</div>
        ${attachmentHtml}
        <div class="comment-actions">
          <button class="${likeBtnClass}" data-action="like-comment" data-comment-id="${comment.id || ''}">
            <span class="comment-like-icon">♥</span>
            ${likeCount > 0 ? `<span class="comment-like-count">${likeCount}</span>` : ''}
          </button>
          <button class="comment-reply-btn" data-action="reply-comment" data-comment-id="${comment.id || ''}" data-post-id="${comment.postId}">${t('返信')}</button>
          ${canManage ? `<button type="button" class="comment-edit-btn" data-action="edit-comment" data-comment-id="${comment.id || ''}" data-post-id="${comment.postId}">${t('編集')}</button>` : ''}
          ${canManage ? `<button type="button" class="comment-delete-btn" data-action="delete-comment" data-comment-id="${comment.id || ''}" data-post-id="${comment.postId}">${t('削除')}</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

export function renderNotification(notif: RenderNotification): string {
  const from = notif.fromUser || {};
  const fromName = escapeHtml(from.displayName || '');
  const fromUsername = from.username || '';
  const timeStr = notif.createdAt ? formatTime(notif.createdAt) : '';
  let text = '';
  let subtext = notif.context ? escapeHtml(notif.context) : '';
  let href = `#/profile/${from.uid || notif.fromUserId || ''}`;
  let icon = '🔔';
  if (typeof notif.deepLink === 'string' && notif.deepLink.startsWith('/#')) href = notif.deepLink.slice(1);
  switch (notif.type) {
    case 'post_moderated':
      text = t('あなたの投稿がコミュニティガイドラインにより削除されました');
      subtext = notif.context ? escapeHtml(notif.context) : '';
      icon = '⚠️';
      break;
    case 'like':
      text = `${fromName} ${notif.commentId ? t('さんがあなたのコメントにいいねしました') : notif.context === 'photo' ? t('さんがあなたの写真にいいねしました') : t('さんがあなたの投稿にいいねしました')}`;
      if (notif.postId) href = `#/post/${encodeURIComponent(notif.postId)}${notif.commentId ? `?commentId=${encodeURIComponent(notif.commentId)}` : ''}`;
      icon = '♥';
      break;
    case 'comment':
    case 'reply':
      text = `${fromName} ${t('さんがあなたの投稿に返信しました')}`;
      if (notif.postId) href = `#/post/${notif.postId}`;
      icon = '💬';
      break;
    case 'thread_reply':
      text = t('あなたが参加したスレッドに新しい返信があります');
      if (notif.postId) href = `#/post/${notif.postId}`;
      icon = '🧵';
      break;
    case 'mention':
      text = `${fromName} ${t('さんがあなたをメンションしました')}`;
      if (notif.postId) href = `#/post/${notif.postId}`;
      icon = '@';
      break;
    case 'repost':
      text = `${fromName} ${t('さんがあなたの投稿をリポストしました')}`;
      if (notif.postId) href = `#/post/${notif.postId}`;
      icon = '🔄';
      break;
    case 'dm':
      // DM notifications are retained only for historical decoding and must
      // never create a visible notification or navigation path.
      return '';
    case 'friend_post':
      text = `${fromName} ${t('さんが新しい投稿をしました')}`;
      if (notif.postId) href = `#/post/${notif.postId}`;
      icon = '📝';
      break;
    case 'friend_story':
      text = `${fromName} ${t('さんが新しい近況を投稿しました')}`;
      icon = '◯';
      break;
    case 'story_reaction':
      text = `${fromName} ${t('さんがあなたのストーリーにリアクションしました')}`;
      subtext = notif.context ? escapeHtml(notif.context) : '';
      icon = '◯';
      break;
    case 'story_reply':
      text = t('この通知は利用できません');
      href = '#/notifications';
      icon = 'ℹ️';
      break;
    case 'friend_request': text = `${fromName} ${t('さんから友達リクエストが届きました')}`; icon = '👥'; break;
    case 'friend_accept': text = `${fromName} ${t('さんが友達リクエストを承認しました')}`; icon = '👥'; break;
    default: text = fromName ? `${fromName} ${t('さんからの通知')}` : t('通知');
  }
  return `
    <div class="notif-item ${notif.read ? '' : 'notif-unread'}" data-notif-id="${notif.id || ''}" data-type="${escapeHtml(notif.type || 'other')}">
      <a href="${href}" class="notif-author" data-navigate data-profile-hover-uid="${escapeHtml(from.uid || notif.fromUserId || '')}" aria-label="${t('通知の詳細へ移動')}">
        <span class="notif-type-icon">${icon}</span>
        ${createAvatarHTML(from, 40)}
      </a>
      <a href="${href}" class="notif-content" data-navigate data-profile-hover-uid="${escapeHtml(from.uid || notif.fromUserId || '')}">
        <div class="notif-text">${text} <span class="notif-time">${timeStr}</span></div>
        ${subtext && !['photo'].includes(subtext) ? `<div class="notif-subtext">${subtext}</div>` : ''}
      </a>
    </div>
  `;
}

export function renderUserListItem(user: Partial<UserProfile> & { uid: string; username?: string; displayName?: string }, currentUserId: string | null | undefined, options: RenderUserListOptions = {}): string {
  const { showFollowBtn = false, friendshipStatus = 'none', onClick } = options;
  const name = escapeHtml(user.displayName || 'User');
  const uname = escapeHtml(user.username || 'user');
  const isSelf = user.uid === currentUserId;
  let actionBtn = '';
  if (showFollowBtn && !isSelf) {
    if (friendshipStatus === 'friends') {
      actionBtn = `<button class="btn btn-sm btn-secondary" data-action="remove-friend" data-uid="${user.uid}">${t('友達解除')}</button>`;
    } else if (friendshipStatus === 'pending_sent') {
      actionBtn = `<button class="btn btn-sm btn-secondary" disabled>${t('リクエスト済み')}</button>`;
    } else if (friendshipStatus === 'pending_received') {
      actionBtn = `<button class="btn btn-sm btn-primary" data-action="accept-friend" data-uid="${user.uid}">${t('承認')}</button>`;
    } else {
      actionBtn = `<button class="btn btn-sm btn-primary" data-action="add-friend" data-uid="${user.uid}">${t('友達追加')}</button>`;
    }
  }
  return `
    <div class="user-list-item" data-uid="${user.uid}">
      <a href="#/profile/${user.uid}" class="user-list-link" data-navigate data-profile-hover-uid="${escapeHtml(user.uid)}">
        ${createAvatarHTML(user, 40)}
        <div class="user-list-info">
          <div class="user-list-name">${name}</div>
          <div class="user-list-username">@${uname}</div>
        </div>
      </a>
      <div class="user-list-action">${actionBtn}</div>
    </div>
  `;
}

export function renderLoadingSpinner() {
  return `
    <div class="skeleton-list" aria-label="読み込み中">
      <div class="skeleton-card">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-lines">
          <div class="skeleton-line skeleton-line-short"></div>
          <div class="skeleton-line"></div>
        </div>
      </div>
      <div class="skeleton-card">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-lines">
          <div class="skeleton-line skeleton-line-short"></div>
          <div class="skeleton-line"></div>
        </div>
      </div>
    </div>
  `;
}

export function renderEmptyState(message: string, emoji = '📭'): string {
  return `<div class="empty-state"><div class="empty-emoji">${emoji}</div><div class="empty-text">${escapeHtml(message)}</div></div>`;
}

export function renderCreatePostForm(user: Partial<UserProfile> | null | undefined, options: { avatarLoading?: boolean } = {}): string {
  const uid = user?.uid || '';
  const avatarContent = options.avatarLoading ? renderComposerAvatarPlaceholder(40, true) : createAvatarHTML(user, 40);
  const avatarHtml = `<a href="#/profile/${escapeHtml(uid)}" data-navigate data-current-user-avatar data-avatar-user-id="${escapeHtml(uid)}" data-avatar-size="40">${avatarContent}</a>`;
  return `
    <div class="create-post-card composer-source-card" aria-hidden="true">
      <div class="create-post-header">
        ${avatarHtml}
        <textarea class="create-post-textarea" id="create-post-textarea" placeholder="${t('今どうしてる？')}" rows="1" style="min-height:44px;height:44px" aria-label="${t('投稿内容')}"></textarea>
        <button class="create-post-expand-btn" id="create-post-expand" type="button" aria-label="${t('投稿欄を全画面表示')}">⛶</button>
      </div>
      <div class="create-post-body">
        <div class="create-post-toolbar">
          <div class="create-post-options">
            <input type="file" id="post-image-file" multiple style="display:none">
            <button class="create-post-option" id="btn-add-media" title="${t('メディア')}" aria-label="${t('メディアを添付')}">🖼️<span>${t('メディア')}</span><span id="image-count-badge" class="image-count-badge hidden">0</span></button>
            <input type="file" id="post-video-file" style="display:none">
            <a href="#/drafts" class="create-post-option" data-navigate>📝 <span>${t('下書き')}</span></a>
          </div>
          <span class="post-char-count">0/1000</span>
          <div class="create-post-actions">
            <button class="btn btn-primary" id="submit-post" style="padding:6px 14px;font-size:13px" disabled>${t('投稿する')}</button>
            <button class="btn btn-secondary" id="btn-add-to-thread" style="display:none;padding:6px 14px;font-size:13px">${t('＋ スレッドに追加')}</button>
          </div>
        </div>

        <div id="post-image-previews" class="post-image-previews"></div>
        <div id="post-video-preview" class="post-video-preview hidden">
          <video id="post-video-preview-video" controls preload="none" playsinline></video>
          <button class="preview-remove-btn" id="post-video-preview-remove">×</button>
        </div>
        <div class="post-advanced-options">
          <label>${t('公開範囲')}
            <select id="post-visibility" class="form-input form-input-sm">
              <option value="public">${t('全体公開')}</option>
              <option value="friends">${t('友達のみ')}</option>
              <option value="private">${t('自分のみ')}</option>
            </select>
          </label>
          <label>投稿の種類
            <select id="post-content-kind" class="form-input form-input-sm">
              <option value="user">ユーザー投稿</option><option value="news">ニュース</option><option value="advertisement">広告 / PR</option><option value="system">システム画面</option>
            </select>
          </label>
          <label>${t('予約')}
            <input type="datetime-local" id="post-scheduled-at" class="form-input form-input-sm">
          </label>
        </div>
        <div id="post-submit-status" class="post-submit-status hidden" role="status" aria-live="polite"></div>
        <div id="post-retry-box" class="post-retry-box hidden">
          <span id="post-retry-message"></span>
          <button class="btn btn-secondary btn-sm" id="post-retry-btn">${t('再投稿')}</button>
        </div>
      </div>
      <div class="composer-drop-hint" aria-hidden="true"><span>🖼️</span>${t('画像をドロップして添付')}</div>
    </div>
    <button class="composer-fab" id="composer-fab" type="button" aria-label="${t('新規ポスト')}"><svg class="composer-fab-icon" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M18 30.5V45c0 1.7 1.3 3 3 3h22c1.7 0 3-1.3 3-3V31"/><path d="M25.5 36.5l4.7-1.1c.6-.1 1.1-.4 1.5-.9l18-18c2-2 2-5.2 0-7.2s-5.2-2-7.2 0l-18 18c-.4.4-.7.9-.9 1.5l-1.1 4.7c-.4 1.8 1.2 3.4 3 3Z"/><path d="M38.8 13.1l12.1 12.1"/></svg></button>
    <div class="composer-fullscreen hidden" id="composer-fullscreen" role="dialog" aria-modal="true" aria-labelledby="composer-fullscreen-title">
      <div class="composer-fullscreen-backdrop" id="composer-fullscreen-backdrop"></div>
      <div class="composer-fullscreen-panel">
        <div class="composer-fullscreen-head">
          <button class="composer-fullscreen-close" id="composer-fullscreen-close" type="button" aria-label="${t('閉じる')}">×</button>
          <strong id="composer-fullscreen-title">${t('新規ポスト')}</strong>
          <button class="btn btn-primary composer-fullscreen-submit-top" id="composer-fullscreen-submit" type="button" disabled>${t('投稿する')}</button>
        </div>
        <div class="composer-fullscreen-body">
          <div class="composer-fullscreen-input-row">
            ${avatarHtml}
            <textarea class="composer-fullscreen-textarea" id="composer-fullscreen-textarea" maxlength="1000" placeholder="${t('今どうしてる？')}" aria-label="${t('投稿内容')}"></textarea>
          </div>
          <div class="post-advanced-options composer-fullscreen-options">
            <label>${t('公開範囲')}
              <select id="composer-fullscreen-visibility" class="form-input form-input-sm">
                <option value="public">${t('全体公開')}</option>
                <option value="friends">${t('友達のみ')}</option>
                <option value="private">${t('自分のみ')}</option>
              </select>
            </label>
            <label>投稿の種類
              <select id="composer-fullscreen-content-kind" class="form-input form-input-sm">
                <option value="user">ユーザー投稿</option><option value="news">ニュース</option><option value="advertisement">広告 / PR</option><option value="system">システム画面</option>
              </select>
            </label>
            <label>${t('予約')}
              <input type="datetime-local" id="composer-fullscreen-scheduled-at" class="form-input form-input-sm">
            </label>
          </div>
          <div class="composer-poll-box" id="composer-poll-box">
            <div class="composer-poll-fields hidden" id="composer-poll-fields">
              <input class="form-input" id="composer-poll-question" maxlength="100" placeholder="${t('質問')}">
              <input class="form-input composer-poll-option" maxlength="80" placeholder="${t('選択肢')} 1">
              <input class="form-input composer-poll-option" maxlength="80" placeholder="${t('選択肢')} 2">
              <input class="form-input composer-poll-option" maxlength="80" placeholder="${t('選択肢')} 3（${t('任意')}）">
              <input class="form-input composer-poll-option" maxlength="80" placeholder="${t('選択肢')} 4（${t('任意')}）">
              <label class="composer-poll-expiry">${t('期限')}
                <select id="composer-poll-expiry" class="form-input form-input-sm">
                  <option value="1">1${t('時間')}</option>
                  <option value="6">6${t('時間')}</option>
                  <option value="24" selected>24${t('時間')}</option>
                  <option value="72">3${t('日')}</option>
                  <option value="168">7${t('日')}</option>
                </select>
              </label>
            </div>
          </div>
          <div class="composer-thread-box" id="composer-thread-box">
            <div id="composer-thread-list" class="composer-thread-list"></div>
            
          </div>
          <div id="composer-fullscreen-image-previews" class="post-image-previews composer-fullscreen-previews"></div>
          <div id="composer-fullscreen-video-preview" class="post-video-preview composer-fullscreen-video-preview hidden">
            <video id="composer-fullscreen-video-preview-video" controls preload="none" playsinline></video>
            <button class="preview-remove-btn" id="composer-fullscreen-video-preview-remove">×</button>
          </div>
        </div>
        <div class="composer-fullscreen-foot">
          <span class="composer-fullscreen-count" id="composer-fullscreen-count">0/1000</span>
          <div class="composer-fullscreen-actions">
            <button class="create-post-option composer-fullscreen-media-btn" id="composer-fullscreen-add-media" type="button" aria-label="${t('メディアを添付')}">🖼️<span>${t('メディア')}</span></button>
            <a class="create-post-option composer-fullscreen-media-btn" href="#/drafts" data-navigate>📝 <span>${t('下書き')}</span></a>
            <button class="create-post-option composer-fullscreen-media-btn" id="composer-toggle-poll" type="button" aria-label="${t('投票')}">📊 <span>${t('投票')}</span></button>
            <button class="create-post-option composer-fullscreen-media-btn" id="composer-add-thread-item" type="button" aria-label="${t('追加')}">＋<span>${t('追加')}</span></button>
            <button class="btn btn-secondary" id="composer-fullscreen-cancel" type="button">${t('戻る')}</button>
          </div>
        </div>
        <div class="composer-drop-hint composer-fullscreen-drop-hint" aria-hidden="true"><span>🖼️</span>${t('画像をドロップして添付')}</div>
      </div>
    </div>
  `;
}

export function renderLoadMoreButton(onClick?: unknown): string {
  return '<div style="text-align:center;padding:16px;"><button class="btn btn-secondary" id="btn-load-more">読み込む</button></div>';
}

export function renderModal(title: string, content: string): string {
  return `
    <div class="modal-overlay" id="modal-overlay">
      <div class="modal-container">
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(title)}</h3>
          <button type="button" class="modal-close" id="modal-close" aria-label="${t('閉じる')}">&times;</button>
        </div>
        <div class="modal-body">${content}</div>
      </div>
    </div>
  `;
}















