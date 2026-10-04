import crypto from 'node:crypto';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../_firebase-admin.js';
import { setApiHeaders, verifyFirebaseUser } from '../_auth.js';
import {
  SEARCH_NORMALIZER_VERSION,
  SEARCH_SCHEMA_VERSION,
  chooseSearchAnchor,
  codePointLength,
  extractHashtagKeys,
  normalizeHashtagKey,
  normalizeSearchText,
  splitSearchTerms,
  utf8ByteLength,
} from '../../functions/lib/search-normalizer.js';
import { buildPostSearchIndex, isSearchablePublicPost } from '../../functions/lib/search-index.js';
import {
  FULL_SCAN_LIMIT,
  PREVIEW_SCAN_LIMIT,
  SEARCH_API_ENABLED,
  SEARCH_APPLICATION_DEADLINE_MS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_CODE_POINTS,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_TERMS,
  SEARCH_MAX_UTF8_BYTES,
  SEARCH_INDEX_READY,
} from '../_search-config.js';

function jsonError(res, status, error, extra = {}) {
  return res.status(status).json({ error, ...extra });
}

function queryHash(normalizedQuery, mode) {
  return crypto.createHash('sha256')
    .update(`${SEARCH_SCHEMA_VERSION}:${SEARCH_NORMALIZER_VERSION}:${mode}:${normalizedQuery}`, 'utf8')
    .digest('hex');
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_cursor');
  const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!parsed || parsed.v !== 1 || typeof parsed.queryHash !== 'string'
    || typeof parsed.documentId !== 'string' || parsed.documentId.length > 150
    || !Number.isFinite(parsed.createdAtMs) || parsed.createdAtMs <= 0) {
    throw new Error('invalid_cursor');
  }
  return parsed;
}

function millis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return 0;
}

function deadlineGuard(deadline) {
  if (Date.now() > deadline) {
    const error = new Error('search_deadline_exceeded');
    error.code = 'SEARCH_TIMEOUT';
    throw error;
  }
}

async function withDeadline(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const error = new Error('search_deadline_exceeded');
    error.code = 'SEARCH_TIMEOUT';
    throw error;
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('search_deadline_exceeded');
          error.code = 'SEARCH_TIMEOUT';
          reject(error);
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serializeTimestamp(value) {
  const ms = millis(value);
  return ms > 0 ? ms : null;
}

function authorPresentation(author) {
  const data = author || {};
  const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
  return {
    authorDisplayName: firstText(data.displayName, data.name, data.username) || 'Connect user',
    authorUsername: firstText(data.username, data.handle).replace(/^@/, ''),
    authorPhotoURL: firstText(data.profilePhotoPreviewURL, data.photoURL, data.profileImage),
    authorAvatarColor: firstText(data.avatarColor),
  };
}

function publicPostDto(snapshot, author) {
  const data = snapshot.data() || {};
  const fields = [
    'userId', 'text', 'imageURLs', 'imageAlts', 'attachments', 'videoURL',
    'threadId', 'threadIndex', 'threadCount', 'quotedPostId', 'quotedPost',
    'hashtags', 'mentions', 'visibility', 'viewCount', 'profileClickCount',
    'likesCount', 'commentsCount', 'repostsCount', 'poll',
  ];
  const result = { id: snapshot.id };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) result[field] = data[field];
  }
  result.createdAt = serializeTimestamp(data.createdAt);
  result.editedAt = serializeTimestamp(data.editedAt);
  result.scheduledAt = serializeTimestamp(data.scheduledAt);
  result.updatedAt = serializeTimestamp(data.updatedAt);
  // The index and post can contain legacy author snapshots.  The just-fetched
  // profile is the only canonical display source for search results.
  Object.assign(result, authorPresentation(author));
  return result;
}

function validateQuery(body) {
  const raw = typeof body?.query === 'string' ? body.query : '';
  if (codePointLength(raw) > SEARCH_MAX_CODE_POINTS || utf8ByteLength(raw) > SEARCH_MAX_UTF8_BYTES) {
    return { error: 'SEARCH_QUERY_TOO_LONG' };
  }
  const normalized = normalizeSearchText(raw);
  if (codePointLength(normalized) > SEARCH_MAX_CODE_POINTS || utf8ByteLength(normalized) > SEARCH_MAX_UTF8_BYTES) {
    return { error: 'SEARCH_QUERY_TOO_LONG' };
  }
  const terms = [...new Set(splitSearchTerms(normalized))];
  if (terms.length > SEARCH_MAX_TERMS) return { error: 'SEARCH_TOO_MANY_TERMS' };
  const limit = body?.limit === undefined ? SEARCH_DEFAULT_LIMIT : body.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) return { error: 'SEARCH_INVALID_LIMIT' };
  const selected = chooseSearchAnchor(normalized);
  if (!normalized) return { normalized, terms, selected: null, limit };
  if (!selected) return { error: 'SEARCH_NO_ANCHOR' };
  return { normalized, terms, selected, limit };
}

function hasExactHashtag(post, hashtagKey) {
  const stored = Array.isArray(post.hashtags) ? post.hashtags.map(normalizeHashtagKey) : [];
  return stored.includes(hashtagKey) || extractHashtagKeys(post.text).includes(hashtagKey);
}

async function searchAuthorPosts(req, res, authorId) {
  const deadline = Date.now() + SEARCH_APPLICATION_DEADLINE_MS;
  const text = normalizeSearchText(req.body.query || '');
  const validation = validateQuery({ ...req.body, query: text || 'author' });
  // Author filtering needs no token anchor; one-character body filters are valid.
  if (validation.error && validation.error !== 'SEARCH_NO_ANCHOR') return jsonError(res, 400, validation.error);
  const pageLimit = validation.limit;
  const terms = splitSearchTerms(text);
  const currentHash = queryHash(`${authorId}\u0000${text}`, 'author');
  let cursor;
  try {
    cursor = decodeCursor(req.body.cursor);
    if (cursor && (cursor.queryHash !== currentHash || cursor.mode !== 'author'
      || cursor.schemaVersion !== SEARCH_SCHEMA_VERSION || cursor.normalizerVersion !== SEARCH_NORMALIZER_VERSION)) return jsonError(res, 400, 'INVALID_CURSOR');
  } catch { return jsonError(res, 400, 'INVALID_CURSOR'); }
  try {
    const author = await withDeadline(adminDb.doc(`users/${authorId}`).get(), deadline);
    if (!author.exists) return res.status(200).json({ items: [], nextCursor: null, hasMore: false, scanLimitReached: false, mode: 'author' });
    const profile = author.data() || {};
    if (profile.deletedAt || profile.suspended === true || profile.disabled === true) return res.status(200).json({ items: [], nextCursor: null, hasMore: false, scanLimitReached: false, mode: 'author' });
    let query = adminDb.collection('posts').where('userId', '==', authorId).orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (cursor) query = query.startAfter(Timestamp.fromMillis(cursor.createdAtMs), cursor.documentId);
    const scanLimit = pageLimit <= 5 ? PREVIEW_SCAN_LIMIT : FULL_SCAN_LIMIT;
    const snapshot = await withDeadline(query.limit(scanLimit + 1).get(), deadline);
    const items = [];
    const candidates = snapshot.docs.slice(0, scanLimit);
    let scanned = 0;
    for (const post of candidates) {
      deadlineGuard(deadline);
      scanned++;
      const data = post.data();
      if (isSearchablePublicPost(data) && terms.every(term => normalizeSearchText(data.text || '').includes(term))) items.push(publicPostDto(post, profile));
      if (items.length >= pageLimit) break;
    }
    const hasMore = scanned < snapshot.docs.length;
    const last = candidates[scanned - 1];
    const nextCursor = hasMore && last ? encodeCursor({ v: 1, queryHash: currentHash, mode: 'author', schemaVersion: SEARCH_SCHEMA_VERSION, normalizerVersion: SEARCH_NORMALIZER_VERSION, createdAtMs: millis(last.data().createdAt), documentId: last.id }) : null;
    return res.status(200).json({ items, nextCursor, hasMore, scanLimitReached: hasMore && items.length < pageLimit, mode: 'author' });
  } catch (error) {
    return jsonError(res, error?.code === 'SEARCH_TIMEOUT' ? 504 : 500, error?.code === 'SEARCH_TIMEOUT' ? 'SEARCH_TIMEOUT' : 'SEARCH_INTERNAL_ERROR');
  }
}

export default async function handler(req, res) {
  setApiHeaders(res, 'POST');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return jsonError(res, 405, 'METHOD_NOT_ALLOWED');
  try {
    await verifyFirebaseUser(req);
  } catch {
    return jsonError(res, 401, 'UNAUTHORIZED');
  }
  if (!SEARCH_API_ENABLED) {
    return jsonError(res, 503, 'SEARCH_NOT_READY', { category: 'posts' });
  }

  if (typeof req.body?.query !== 'string') return jsonError(res, 400, 'SEARCH_INVALID_QUERY');
  if (codePointLength(req.body.query) > SEARCH_MAX_CODE_POINTS || utf8ByteLength(req.body.query) > SEARCH_MAX_UTF8_BYTES) return jsonError(res, 400, 'SEARCH_QUERY_TOO_LONG');
  if (Object.prototype.hasOwnProperty.call(req.body, 'authorId')) {
    if (typeof req.body.authorId !== 'string' || !req.body.authorId.trim() || req.body.authorId.length > 160) return jsonError(res, 400, 'SEARCH_INVALID_AUTHOR');
    return searchAuthorPosts(req, res, req.body.authorId.trim());
  }
  if (!SEARCH_INDEX_READY) return jsonError(res, 503, 'SEARCH_NOT_READY', { category: 'posts' });
  const validation = validateQuery(req.body || {});
  if (validation.error) {
    const status = validation.error === 'SEARCH_NO_ANCHOR' ? 422 : 400;
    return jsonError(res, status, validation.error);
  }
  if (!validation.normalized) {
    return res.status(200).json({ items: [], nextCursor: null, hasMore: false, scanLimitReached: false, mode: 'text' });
  }

  const deadline = Date.now() + SEARCH_APPLICATION_DEADLINE_MS;
  const selected = validation.selected;
  const mode = selected.mode;
  const currentHash = queryHash(validation.normalized, mode);
  let cursor;
  try {
    cursor = decodeCursor(req.body?.cursor);
    if (cursor && (cursor.queryHash !== currentHash || cursor.schemaVersion !== SEARCH_SCHEMA_VERSION
      || cursor.normalizerVersion !== SEARCH_NORMALIZER_VERSION || cursor.mode !== mode)) {
      return jsonError(res, 400, 'INVALID_CURSOR');
    }
  } catch {
    return jsonError(res, 400, 'INVALID_CURSOR');
  }

  const scanLimit = validation.limit <= 5 ? PREVIEW_SCAN_LIMIT : FULL_SCAN_LIMIT;
  try {
    deadlineGuard(deadline);
    let postsQuery = adminDb.collection('postSearchIndex')
      .where('schemaVersion', '==', SEARCH_SCHEMA_VERSION)
      .where('normalizerVersion', '==', SEARCH_NORMALIZER_VERSION)
      .where('searchTokens', 'array-contains', selected.anchor)
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc');
    if (cursor) postsQuery = postsQuery.startAfter(Timestamp.fromMillis(cursor.createdAtMs), cursor.documentId);
    const candidateSnapshot = await withDeadline(postsQuery.limit(scanLimit + 1).get(), deadline);
    deadlineGuard(deadline);
    const candidateDocs = candidateSnapshot.docs.slice(0, scanLimit);
    const hasLookahead = candidateSnapshot.docs.length > scanLimit;
    const matchedCandidates = [];
    let scannedCount = 0;
    for (const candidate of candidateDocs) {
      deadlineGuard(deadline);
      scannedCount += 1;
      const index = candidate.data() || {};
      const normalizedText = typeof index.normalizedText === 'string' ? index.normalizedText : '';
      const matches = mode === 'hashtag'
        ? Array.isArray(index.searchTokens) && index.searchTokens.includes(selected.anchor)
        : validation.terms.every(term => normalizedText.includes(term));
      if (matches) matchedCandidates.push({ candidate, index });
      if (matchedCandidates.length >= validation.limit) break;
    }

    deadlineGuard(deadline);
    const canonicalSnapshots = matchedCandidates.length
      ? await withDeadline(adminDb.getAll(...matchedCandidates.map(item => adminDb.doc(`posts/${item.candidate.id}`))), deadline)
      : [];
    const authorIds = [...new Set(canonicalSnapshots.filter(snapshot => snapshot.exists).map(snapshot => String(snapshot.data()?.userId || snapshot.data()?.authorId || '')).filter(Boolean))];
    const authorSnapshots = authorIds.length
      ? await withDeadline(adminDb.getAll(...authorIds.map(authorId => adminDb.doc(`users/${authorId}`))), deadline)
      : [];
    const authors = new Map(authorSnapshots.map(snapshot => [snapshot.id, snapshot.exists ? snapshot.data() || {} : null]));
    const canonicalById = new Map(canonicalSnapshots.map(snapshot => [snapshot.id, snapshot]));
    const items = [];
    for (const { candidate, index } of matchedCandidates) {
      deadlineGuard(deadline);
      const postSnapshot = canonicalById.get(candidate.id);
      if (!postSnapshot?.exists) continue;
      const post = postSnapshot.data() || {};
      if (!isSearchablePublicPost(post)) continue;
      if (mode === 'hashtag' && !hasExactHashtag(post, selected.hashtagKey)) continue;
      const authorId = String(post.userId || post.authorId || '');
      const author = authors.get(authorId);
      if (!author || author.deletedAt || author.suspended === true || author.disabled === true) continue;
      let canonicalIndex;
      try {
        canonicalIndex = buildPostSearchIndex(post, postSnapshot.id, index.indexedAt || undefined);
      } catch {
        console.warn('search_index_malformed_candidate');
        continue;
      }
      if (!canonicalIndex
        || canonicalIndex.postId !== index.postId
        || canonicalIndex.authorId !== index.authorId
        || millis(canonicalIndex.createdAt) !== millis(index.createdAt)
        || canonicalIndex.sourceVersion !== index.sourceVersion) {
        console.warn('search_index_stale_candidate', { postId: candidate.id });
        continue;
      }
      items.push(publicPostDto(postSnapshot, author));
    }
    deadlineGuard(deadline);
    const scannedCandidate = candidateDocs[Math.min(scannedCount, candidateDocs.length) - 1];
    const hasMore = Boolean(hasLookahead || (scannedCount < candidateDocs.length && matchedCandidates.length >= validation.limit));
    const scanLimitReached = matchedCandidates.length < validation.limit && scannedCount >= scanLimit;
    const nextCursor = scannedCandidate ? encodeCursor({
      v: 1,
      queryHash: currentHash,
      mode,
      schemaVersion: SEARCH_SCHEMA_VERSION,
      normalizerVersion: SEARCH_NORMALIZER_VERSION,
      createdAtMs: millis(scannedCandidate.data()?.createdAt),
      documentId: scannedCandidate.id,
    }) : null;
    return res.status(200).json({ items, nextCursor: hasMore ? nextCursor : null, hasMore, scanLimitReached, mode });
  } catch (error) {
    if (error?.code === 'SEARCH_TIMEOUT' || Date.now() > deadline) {
      return jsonError(res, 504, 'SEARCH_TIMEOUT', { category: 'posts' });
    }
    console.error('search_posts_failed', { code: error?.code || 'internal_error' });
    return jsonError(res, 500, 'SEARCH_INTERNAL_ERROR');
  }
}
