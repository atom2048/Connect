import crypto from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import {
  SEARCH_NORMALIZER_VERSION,
  SEARCH_SCHEMA_VERSION,
  generateSearchTokens,
  normalizeHashtagKey,
  normalizeSearchText,
} from './search-normalizer.js';

export { SEARCH_NORMALIZER_VERSION, SEARCH_SCHEMA_VERSION };

const MODERATION_BLOCK_STATES = new Set(['hidden', 'blocked', 'removed', 'rejected', 'deleted']);

function millis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function timestamp(value) {
  if (value?.toMillis) return value;
  const valueMs = millis(value);
  return valueMs > 0 ? Timestamp.fromMillis(valueMs) : null;
}

function canonicalize(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((result, key) => {
    const next = canonicalize(value[key]);
    if (next !== undefined) result[key] = next;
    return result;
  }, {});
}

export function stableCanonicalSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

export function sourceProjectionForPost(post, postId) {
  return {
    postId: String(postId || ''),
    authorId: String(post?.userId || post?.authorId || ''),
    createdAtMs: millis(post?.createdAt),
    text: typeof post?.text === 'string' ? post.text : '',
    hashtags: Array.isArray(post?.hashtags)
      ? [...new Set(post.hashtags.map(normalizeHashtagKey).filter(Boolean))].sort()
      : [],
    visibility: post?.visibility === undefined ? 'public' : post.visibility,
    scheduledAtMs: millis(post?.scheduledAt),
    deletedAtMs: millis(post?.deletedAt),
    hidden: post?.hidden === true || post?.isHidden === true,
    published: post?.published,
    isPublished: post?.isPublished,
    moderationStatus: post?.moderationStatus || null,
  };
}

export function isSearchablePublicPost(post) {
  if (!post || typeof post !== 'object') return false;
  const authorId = String(post.userId || post.authorId || '');
  if (!authorId || !millis(post.createdAt)) return false;
  if (typeof post.text !== 'string') return false;
  if (!post.text.trim()) return false;
  if (post.visibility !== undefined && post.visibility !== 'public') return false;
  if (post.published === false || post.isPublished === false) return false;
  if (post.deletedAt || post.deleted === true || post.hidden === true || post.isHidden === true) return false;
  if (MODERATION_BLOCK_STATES.has(String(post.moderationStatus || '').toLowerCase())) return false;
  const scheduledAtMs = millis(post.scheduledAt);
  if (scheduledAtMs > Date.now()) return false;
  return true;
}

export function buildSearchProjection(post, postId) {
  if (!isSearchablePublicPost(post)) return null;
  const normalizedText = normalizeSearchText(post.text);
  const searchTokens = generateSearchTokens(post.text);
  const hashtagTokens = Array.isArray(post.hashtags)
    ? post.hashtags.map(normalizeHashtagKey).filter(Boolean).map(tag => `h:${tag}`)
    : [];
  const allTokens = [...new Set([...searchTokens, ...hashtagTokens])].sort();
  return {
    postId: String(postId),
    authorId: String(post.userId || post.authorId),
    createdAt: timestamp(post.createdAt),
    createdAtMs: millis(post.createdAt),
    normalizedText,
    searchTokens: allTokens,
    schemaVersion: SEARCH_SCHEMA_VERSION,
    normalizerVersion: SEARCH_NORMALIZER_VERSION,
  };
}

export function projectionSourceVersion(projection) {
  const comparable = {
    postId: projection.postId,
    authorId: projection.authorId,
    createdAtMs: projection.createdAtMs,
    normalizedText: projection.normalizedText,
    searchTokens: [...projection.searchTokens].sort(),
    schemaVersion: projection.schemaVersion,
    normalizerVersion: projection.normalizerVersion,
  };
  return crypto.createHash('sha256').update(stableCanonicalSerialize(comparable), 'utf8').digest('hex');
}

export function buildPostSearchIndex(post, postId, indexedAt = Timestamp.now()) {
  const projection = buildSearchProjection(post, postId);
  if (!projection) return null;
  const indexDocument = {
    postId: projection.postId,
    authorId: projection.authorId,
    createdAt: projection.createdAt,
    sourceVersion: projectionSourceVersion(projection),
    normalizedText: projection.normalizedText,
    searchTokens: projection.searchTokens,
    schemaVersion: projection.schemaVersion,
    normalizerVersion: projection.normalizerVersion,
    indexedAt,
  };
  const approximateBytes = Buffer.byteLength(stableCanonicalSerialize({ ...indexDocument, createdAt: projection.createdAtMs, indexedAt: millis(indexedAt) }), 'utf8');
  if (approximateBytes >= 900_000) {
    const error = new Error('search_index_document_too_large');
    error.code = 'SEARCH_INDEX_DOCUMENT_TOO_LARGE';
    throw error;
  }
  return indexDocument;
}

export function didSearchProjectionChange(before, after, postId = '') {
  if (!before || !after) return true;
  return stableCanonicalSerialize(sourceProjectionForPost(before, postId))
    !== stableCanonicalSerialize(sourceProjectionForPost(after, postId));
}
