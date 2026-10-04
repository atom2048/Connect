import { buildPostSearchIndex } from './search-index.js';

function millis(value) {
  return value?.toMillis ? value.toMillis() : (typeof value === 'number' ? value : 0);
}

function indexMatchesProjection(existing, next) {
  return existing?.postId === next.postId
    && existing?.authorId === next.authorId
    && millis(existing?.createdAt) === millis(next.createdAt)
    && existing?.sourceVersion === next.sourceVersion
    && existing?.schemaVersion === next.schemaVersion
    && existing?.normalizerVersion === next.normalizerVersion
    && existing?.normalizedText === next.normalizedText
    && JSON.stringify(existing?.searchTokens || []) === JSON.stringify(next.searchTokens || [])
    && Boolean(existing?.indexedAt);
}

export async function syncPostSearchIndex(db, postId) {
  if (!postId) return { status: 'skipped', reason: 'missing_post_id' };
  const postRef = db.doc(`posts/${postId}`);
  const indexRef = db.doc(`postSearchIndex/${postId}`);
  return db.runTransaction(async transaction => {
    const postSnapshot = await transaction.get(postRef);
    const indexSnapshot = await transaction.get(indexRef);
    if (!postSnapshot.exists) {
      if (indexSnapshot.exists) transaction.delete(indexRef);
      return { status: 'deleted', reason: 'source_missing' };
    }
    let indexDocument;
    try {
      indexDocument = buildPostSearchIndex(postSnapshot.data(), postSnapshot.id);
    } catch (error) {
      if (indexSnapshot.exists) transaction.delete(indexRef);
      return { status: 'deleted', reason: error?.code || 'malformed_source' };
    }
    if (!indexDocument) {
      if (indexSnapshot.exists) transaction.delete(indexRef);
      return { status: 'deleted', reason: 'not_searchable' };
    }
    if (indexSnapshot.exists && indexMatchesProjection(indexSnapshot.data(), indexDocument)) {
      return { status: 'already_current', sourceVersion: indexDocument.sourceVersion };
    }
    transaction.set(indexRef, indexDocument, { merge: false });
    return { status: 'written', sourceVersion: indexDocument.sourceVersion };
  });
}
