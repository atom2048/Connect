import { hmacSha256 } from './fingerprint';
import { isProductionFixturePost, productionFixturePredicate, visibilityPredicate } from '../lib';
import { AI_LIMITS } from './config';
import type { AuthorAiPreferences, ConsentDecision, ContextSource, MediaManifestItem, MediaTarget, MediaUsageMode, PrivacyClass, VersionedContextManifest } from './types';

type SourceRow = {
  source_type: 'post' | 'comment'; relation_hint: ContextSource['relation'] | null;
  id: string; author_id: string; body: string; visibility: string; media_json: string | null;
  quoted_post_id: string | null; reply_to_post_id: string | null; thread_root_id: string | null; deleted_at: number | null;
  content_version: number; access_version: number; media_version: number; structure_version: number;
  accepted_policy_version: string | null; preference_version: number | null; text_analysis: string | null; media_analysis: string | null;
  post_ai_text_analysis: string | null; post_ai_media_analysis: string | null; post_ai_consent_version: number | null;
};

type PreferenceRow = Pick<SourceRow, 'accepted_policy_version' | 'preference_version' | 'text_analysis' | 'media_analysis'>;

type SessionLike = { prepare(query: string): D1PreparedStatement };

const normalizePreferences = (row: PreferenceRow): AuthorAiPreferences => ({
  acceptedPolicyVersion: row.accepted_policy_version,
  preferenceVersion: row.preference_version ?? 1,
  // Missing/legacy preference values are not an opt-out. The effective
  // policy is the existing ACL plus an explicit DISABLED value.
  textAnalysis: (row.text_analysis || 'PUBLIC_ONLY') as AuthorAiPreferences['textAnalysis'],
  mediaAnalysis: (row.media_analysis || 'PUBLIC_ONLY') as AuthorAiPreferences['mediaAnalysis'],
});

export function consentFor(preferences: AuthorAiPreferences, visibility: string, postConsent?: { textAnalysis?: string | null; mediaAnalysis?: string | null } | null): ConsentDecision {
  // sourceRows() has already enforced the viewer ACL.  Public content may be
  // analyzed unless the author opted out globally or for this post.  A
  // restricted post is default-off and becomes eligible only after its
  // author explicitly enables the per-post consent row.  The explicit
  // DISABLED value always wins, so a global opt-out cannot be overridden.
  const restricted = visibility !== 'public';
  const postText = postConsent?.textAnalysis || null;
  const postMedia = postConsent?.mediaAnalysis || null;
  return {
    allowText: preferences.textAnalysis !== 'DISABLED'
      && postText !== 'DISABLED'
      && (!restricted ? true : postText === 'AUTHORIZED_CONTEXT'),
    allowMedia: preferences.mediaAnalysis !== 'DISABLED'
      && postMedia !== 'DISABLED'
      && (!restricted ? true : postMedia === 'AUTHORIZED_CONTEXT'),
  };
}

export function inferMediaMimeType(url: string, explicit: unknown): string {
  const declared = typeof explicit === 'string' ? explicit.split(';', 1)[0].trim().toLowerCase() : '';
  // Legacy Firestore records often carry `image/*`, `image`, or a generic
  // attachment kind rather than the actual MIME.  Do not let that wildcard
  // hide an otherwise usable extension on an R2-backed media URL.
  if (declared && !['image', 'photo', 'media', 'image/*', 'video', 'video/*'].includes(declared)) return declared;
  const extension = url.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase() || '';
  return ({ avif: 'image/avif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[extension] || 'application/octet-stream';
}

function mediaObjectKey(url: string, item: Record<string, unknown>): string {
  try {
    const path = url.startsWith('/') ? url : new URL(url).pathname;
    if (path.startsWith('/media/')) return decodeURIComponent(path.slice('/media/'.length)).replace(/^\/+/, '');
  } catch { /* fall through to an explicit storage key */ }
  // A migration can retain the old Firebase storagePath while rewriting url
  // to the new R2-backed /media/ route. Prefer that rewritten URL above; use
  // an explicit key only when the URL itself is not an R2 route.
  const explicitKey = [item.objectKey, item.storagePath, item.storage_key, item.key]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!explicitKey) return '';
  try { return decodeURIComponent(explicitKey).replace(/^\/+/, ''); } catch { return ''; }
}

function mediaFrom(row: Pick<SourceRow, 'media_json' | 'media_version' | 'visibility'>, sourceRef: string, relation: ContextSource['relation']): MediaManifestItem[] {
  let items: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(row.media_json || '[]');
    if (Array.isArray(parsed)) {
      items = parsed.flatMap((value) => {
        if (typeof value === 'string') return [{ url: value }];
        return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
      });
    }
  } catch { items = []; }
  return items.map((item, index) => {
    const url = typeof item.url === 'string' ? item.url : '';
    const objectKey = mediaObjectKey(url, item);
    const mimeType = inferMediaMimeType(url, item.mimeType || item.type || item.sourceType);
    return {
      ref: `I${sourceRef.slice(1)}_${index}`,
      belongsTo: sourceRef,
      position: index + 1,
      objectKey,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
      mimeType,
      bytes: typeof item.bytes === 'number' ? item.bytes : null,
      animated: Boolean(item.animated) || mimeType === 'image/gif',
      sourceRelation: relation,
      sourceVisibility: row.visibility,
      mediaVersion: row.media_version,
      allowedByConsent: false,
    };
  });
}

async function sourceRows(session: SessionLike, viewerId: string, postId: string, excludeProductionFixtures = false): Promise<SourceRow[]> {
  const fixtureFilter = excludeProductionFixtures ? ` AND ${productionFixturePredicate('p')}` : '';
  const visibility = visibilityPredicate(viewerId, 'p');
  const current = await session.prepare(`SELECT p.*, 'post' source_type, 'current' relation_hint, pref.accepted_policy_version, pref.preference_version, pref.text_analysis, pref.media_analysis,
      consent.text_analysis AS post_ai_text_analysis, consent.media_analysis AS post_ai_media_analysis, consent.consent_version AS post_ai_consent_version
    FROM posts p LEFT JOIN ai_author_preferences pref ON pref.user_id=p.author_id
      LEFT JOIN post_ai_consents consent ON consent.post_id=p.id AND consent.author_id=p.author_id
    WHERE p.id=?${fixtureFilter} AND ${visibility.sql}`)
    .bind(postId, ...visibility.bindings).first<SourceRow>();
  if (!current) return [];
  const ids = [current.quoted_post_id, current.reply_to_post_id].filter((value): value is string => Boolean(value));
  const relatedRows: SourceRow[] = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const related = await session.prepare(`SELECT p.*, 'post' source_type,
      CASE WHEN p.id=? THEN 'quote' ELSE 'reply_parent' END relation_hint,
      pref.accepted_policy_version, pref.preference_version, pref.text_analysis, pref.media_analysis,
      consent.text_analysis AS post_ai_text_analysis, consent.media_analysis AS post_ai_media_analysis, consent.consent_version AS post_ai_consent_version
    FROM posts p LEFT JOIN ai_author_preferences pref ON pref.user_id=p.author_id
      LEFT JOIN post_ai_consents consent ON consent.post_id=p.id AND consent.author_id=p.author_id
    WHERE p.id IN (${placeholders})${fixtureFilter} AND ${visibility.sql}`)
    .bind(current.quoted_post_id || '', ...ids, ...visibility.bindings).all<SourceRow>();
    relatedRows.push(...(related.results || []));
  }
  const comments = await session.prepare(`SELECT c.id,c.author_id,c.body,p.visibility,NULL media_json,NULL quoted_post_id,NULL reply_to_post_id,NULL thread_root_id,c.deleted_at,
    c.content_version,c.access_version,c.media_version,c.structure_version,'comment' source_type,'reply' relation_hint,
    pref.accepted_policy_version,pref.preference_version,pref.text_analysis,pref.media_analysis,
    consent.text_analysis AS post_ai_text_analysis, consent.media_analysis AS post_ai_media_analysis, consent.consent_version AS post_ai_consent_version
    FROM comments c JOIN posts p ON p.id=c.post_id LEFT JOIN ai_author_preferences pref ON pref.user_id=c.author_id
      LEFT JOIN post_ai_consents consent ON consent.post_id=p.id AND consent.author_id=p.author_id
    WHERE c.post_id=? AND c.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=c.author_id) OR (b.blocker_id=c.author_id AND b.blocked_id=?))
    ORDER BY CASE WHEN c.author_id=? THEN 0 ELSE 1 END,c.created_at ASC,c.id ASC LIMIT 20`)
    .bind(current.id, viewerId, viewerId, current.author_id).all<SourceRow>();
  return [current, ...relatedRows, ...(comments.results || [])];
}

export async function buildContextManifest(db: D1Database, viewerId: string, postId: string, consentSecret: string, excludeProductionFixtures = false): Promise<VersionedContextManifest | null> {
  const session = db.withSession('first-primary');
  const rows = await sourceRows(session, viewerId, postId, excludeProductionFixtures);
  if (!rows.length) return null;
  const current = rows[0];
  if (excludeProductionFixtures && isProductionFixturePost(current.id, current.body)) return null;
  const sources: ContextSource[] = [];
  const media: MediaManifestItem[] = [];
  const authorPairs = new Set<string>();
  let postRef = 0;
  let commentRef = 0;
  for (const [index, row] of rows.entries()) {
    const relation: ContextSource['relation'] = index === 0 ? 'current' : row.relation_hint || (row.id === current.quoted_post_id ? 'quote' : 'reply_parent');
    const ref = row.source_type === 'comment' ? `C${commentRef++}` : `P${postRef++}`;
    const prefs = normalizePreferences(row);
    const consent = consentFor(prefs, row.visibility, { textAnalysis: row.post_ai_text_analysis, mediaAnalysis: row.post_ai_media_analysis });
    authorPairs.add(`${await hmacSha256(consentSecret, row.author_id)}:${prefs.preferenceVersion}:${row.post_ai_consent_version || 0}:${prefs.acceptedPolicyVersion || 'none'}`);
    sources.push({
      ref, actualId: row.id, type: row.source_type, relation, authorId: row.author_id, visibility: row.visibility,
      text: consent.allowText ? row.body : '', order: index, allowText: consent.allowText, allowMedia: consent.allowMedia,
      contentVersion: row.content_version, accessVersion: row.access_version, mediaVersion: row.media_version,
      structureVersion: row.structure_version, authorPreferenceVersion: prefs.preferenceVersion, postConsentVersion: row.post_ai_consent_version || 0, acceptedPolicyVersion: prefs.acceptedPolicyVersion,
    });
    media.push(...mediaFrom(row, ref, relation).map((item) => ({ ...item, allowedByConsent: consent.allowMedia })));
  }
  const eligibleSources = sources.filter((source, index) => index === 0 || source.allowText || source.allowMedia);
  const selectedSources: ContextSource[] = [];
  let estimatedTokens = 0;
  let contextTruncated = false;
  for (const source of eligibleSources) {
    const estimate = Math.ceil([...source.text].length * 1.3);
    const mandatory = ['current', 'reply_parent', 'quote'].includes(source.relation);
    if (!mandatory && estimatedTokens + estimate > AI_LIMITS.contextTargetTokens) { contextTruncated = true; continue; }
    selectedSources.push(source);
    estimatedTokens += estimate;
  }
  const selectedRefs = new Set(selectedSources.map((source) => source.ref));
  const privacyRank = (visibility: string) => visibility === 'private' ? 2 : visibility === 'public' ? 0 : 1;
  const maxPrivacy = Math.max(...selectedSources.map((source) => privacyRank(source.visibility)));
  const privacyClass: PrivacyClass = maxPrivacy === 2 ? 'PRIVATE_AI' : maxPrivacy === 1 ? 'LIMITED_AI' : 'PUBLIC_AI';
  return {
    subjectType: 'post',
    subjectId: current.id,
    currentPostId: current.id,
    currentAuthorId: current.author_id,
    sources: selectedSources,
    media: media.filter((item) => selectedRefs.has(item.belongsTo)),
    privacyClass,
    contextTruncated,
    authorConsentVector: await crypto.subtle.digest('SHA-256', new TextEncoder().encode([...authorPairs].sort().join('|'))).then((digest) => [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')),
  };
}

type ProfileContextRow = {
  id: string;
  display_name: string | null;
  username: string | null;
  bio: string | null;
  updated_at: number | null;
};

type ProfileContentRow = {
  id: string;
  author_id: string;
  body: string;
  visibility: string;
  deleted_at: number | null;
  created_at: number;
  quoted_post_id: string | null;
  reply_to_post_id: string | null;
  thread_root_id: string | null;
  content_version: number;
  access_version: number;
  media_version: number;
  structure_version: number;
  media_json: string | null;
  accepted_policy_version: string | null;
  preference_version: number | null;
  text_analysis: string | null;
  media_analysis: string | null;
  post_ai_text_analysis: string | null;
  post_ai_media_analysis: string | null;
  post_ai_consent_version: number | null;
};

function profileSourceText(row: ProfileContextRow): string {
  const name = (row.display_name || '').trim();
  const username = (row.username || '').trim();
  const bio = (row.bio || '').trim();
  return [`表示名: ${name || '未設定'}`, username ? `ユーザー名: @${username}` : '', bio ? `自己紹介: ${bio}` : '']
    .filter(Boolean)
    .join('\n');
}

function profileMediaCount(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Builds a profile-scoped, public-only manifest from post IDs verified against
 * Firestore during this request. Comments are excluded because their legacy
 * D1 copies have no equivalent per-request deletion/version revalidation.
 */
export async function buildProfileContextManifest(db: D1Database, viewerId: string, profileId: string, consentSecret: string, excludeProductionFixtures = false, verifiedPostIds: string[] = []): Promise<VersionedContextManifest | null> {
  const session = db.withSession('first-primary');
  const verifiedIds = [...new Set(verifiedPostIds.filter((postId) => /^[A-Za-z0-9_-]{1,160}$/.test(postId)))].slice(0, 12);
  const postIdPlaceholders = verifiedIds.length ? verifiedIds.map(() => '?').join(',') : '?';
  const postIdBindings = verifiedIds.length ? verifiedIds : ['__no_verified_profile_posts__'];
  const [profile, blocked] = await Promise.all([
    session.prepare(`SELECT id,display_name,username,bio,updated_at FROM profiles WHERE id=?`).bind(profileId).first<ProfileContextRow>(),
    viewerId
      ? session.prepare(`SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?) LIMIT 1`).bind(viewerId, profileId, profileId, viewerId).first<Record<string, number>>()
      : Promise.resolve(null),
  ]);
  if (!profile) return null;
  if (blocked) return null;
  const [profilePreference, posts] = await Promise.all([
    session.prepare(`SELECT accepted_policy_version,preference_version,text_analysis,media_analysis FROM ai_author_preferences WHERE user_id=?`).bind(profileId).first<Pick<ProfileContentRow, 'accepted_policy_version' | 'preference_version' | 'text_analysis' | 'media_analysis'>>(),
    session.prepare(`SELECT p.id,p.author_id,p.body,p.visibility,p.deleted_at,p.media_json,p.created_at,p.quoted_post_id,p.reply_to_post_id,p.thread_root_id,
        p.content_version,p.access_version,p.media_version,p.structure_version,
        pref.accepted_policy_version,pref.preference_version,pref.text_analysis,pref.media_analysis,
        consent.text_analysis AS post_ai_text_analysis, consent.media_analysis AS post_ai_media_analysis, consent.consent_version AS post_ai_consent_version
      FROM posts p LEFT JOIN ai_author_preferences pref ON pref.user_id=p.author_id
        LEFT JOIN post_ai_consents consent ON consent.post_id=p.id AND consent.author_id=p.author_id
      WHERE p.author_id=? AND p.visibility='public' AND p.deleted_at IS NULL AND p.id IN (${postIdPlaceholders})
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=? AND b.blocked_id=p.author_id) OR (b.blocker_id=p.author_id AND b.blocked_id=?))${excludeProductionFixtures ? ` AND ${productionFixturePredicate('p')}` : ''}
      ORDER BY p.created_at DESC,p.id DESC LIMIT 80`).bind(profileId, ...postIdBindings, viewerId, viewerId).all<ProfileContentRow>(),
  ]);
  const profilePrefs: AuthorAiPreferences = profilePreference ? normalizePreferences({
    accepted_policy_version: profilePreference.accepted_policy_version,
    preference_version: profilePreference.preference_version,
    text_analysis: profilePreference.text_analysis,
    media_analysis: profilePreference.media_analysis,
  }) : { acceptedPolicyVersion: null, preferenceVersion: 1, textAnalysis: 'PUBLIC_ONLY', mediaAnalysis: 'PUBLIC_ONLY' };
  const profileConsent = consentFor(profilePrefs, 'public');
  if (!profileConsent.allowText) return null;
  const sources: ContextSource[] = [{
    ref: 'U0', actualId: profile.id, type: 'profile', relation: 'current', authorId: profile.id, visibility: 'public',
    text: profileSourceText(profile), order: 0, allowText: profileConsent.allowText, allowMedia: false,
    contentVersion: Math.max(1, Number(profile.updated_at || 1)), accessVersion: Math.max(1, Number(profile.updated_at || 1)),
    mediaVersion: 1, structureVersion: 1, authorPreferenceVersion: profilePrefs.preferenceVersion, postConsentVersion: 0, acceptedPolicyVersion: profilePrefs.acceptedPolicyVersion,
  }];
  const authorPairs = new Set<string>([`${await hmacSha256(consentSecret, profile.id)}:${profilePrefs.preferenceVersion}:${profilePrefs.acceptedPolicyVersion || 'none'}`]);

  // Profile Ask AI is intentionally public-only. A restricted post/reply is
  // never made eligible by a consent row, and the defensive filters below
  // keep that invariant even if a future repository adapter returns a stale
  // or over-broad row set.
  const verifiedPostIdSet = new Set(verifiedIds);
  const visiblePosts = (posts.results || []).filter((row) => verifiedPostIdSet.has(row.id) && row.visibility === 'public' && row.deleted_at === null);
  const chronologicalContentRows: Array<{ row: ProfileContentRow; relation: ContextSource['relation'] }> = [
    ...visiblePosts.map((row) => ({ row, relation: row.reply_to_post_id ? 'reply' as const : row.quoted_post_id ? 'quote' as const : 'thread' as const })),
  ].sort((left, right) => Number(right.row.created_at || 0) - Number(left.row.created_at || 0));
  // Keep recency dominant, but let a longer, image-bearing recent row outrank
  // a very short row from the same time window. This improves profile signal
  // density without allowing an old essay to displace the recent feed.
  const contentRows = chronologicalContentRows
    .map((item, recencyRank) => ({
      ...item,
      recencyRank,
      informationScore: Math.max(0, 200 - recencyRank) * 20
        + Math.min([...item.row.body].length, 1_800)
        + profileMediaCount(item.row.media_json) * 500,
    }))
    .sort((left, right) => right.informationScore - left.informationScore
      || Number(right.row.created_at || 0) - Number(left.row.created_at || 0)
      || left.recencyRank - right.recencyRank);
  const media: MediaManifestItem[] = [];
  let estimatedTokens = Math.ceil([...sources[0].text].length * 1.3);
  let contextChars = [...sources[0].text].length;
  let contextTruncated = false;
  for (const [index, item] of contentRows.entries()) {
    const row = item.row;
    const prefs = normalizePreferences({
      accepted_policy_version: row.accepted_policy_version,
      preference_version: row.preference_version, text_analysis: row.text_analysis, media_analysis: row.media_analysis,
    });
    const consent = consentFor(prefs, 'public', { textAnalysis: row.post_ai_text_analysis, mediaAnalysis: row.post_ai_media_analysis });
    authorPairs.add(`${await hmacSha256(consentSecret, row.author_id)}:${prefs.preferenceVersion}:${row.post_ai_consent_version || 0}:${prefs.acceptedPolicyVersion || 'none'}`);
    const text = consent.allowText ? row.body : '';
    const ref = `P${index}`;
    const rowMedia = mediaFrom(row, ref, item.relation).map((mediaItem) => ({ ...mediaItem, allowedByConsent: consent.allowMedia }));
    const remainingTokenChars = Math.max(0, Math.floor((AI_LIMITS.profileContextTargetTokens - estimatedTokens) / 1.3));
    const remainingChars = Math.max(0, Math.min(AI_LIMITS.profileContextMaxChars - contextChars, remainingTokenChars));
    const includedText = text ? [...text].slice(0, remainingChars).join('') : '';
    const includeText = Boolean(includedText);
    const includeMedia = rowMedia.some((mediaItem) => mediaItem.allowedByConsent && mediaItem.objectKey);
    // Keep a media-only source when its text was truncated or opted out. This
    // is what allows a profile question to analyze a recent image without
    // re-introducing text that the author did not authorize.
    if (includedText.length < [...text].length) contextTruncated = true;
    if (!includeText && !includeMedia) continue;
    sources.push({
      ref, actualId: row.id, type: 'post', relation: item.relation,
      authorId: row.author_id, visibility: row.visibility, text: includeText ? includedText : '', order: item.recencyRank + 1, allowText: consent.allowText, allowMedia: consent.allowMedia,
      contentVersion: row.content_version, accessVersion: row.access_version, mediaVersion: row.media_version, structureVersion: row.structure_version,
      authorPreferenceVersion: prefs.preferenceVersion, postConsentVersion: row.post_ai_consent_version || 0, acceptedPolicyVersion: prefs.acceptedPolicyVersion,
    });
    if (includeText) {
      estimatedTokens += Math.ceil([...includedText].length * 1.3);
      contextChars += [...includedText].length;
    }
    media.push(...rowMedia);
  }
  const maxPrivacy = Math.max(...sources.map((source) => source.visibility === 'private' ? 2 : source.visibility === 'public' ? 0 : 1));
  return {
    subjectType: 'profile', subjectId: profileId, currentPostId: profileId, currentAuthorId: profileId,
    sources, media, privacyClass: maxPrivacy === 2 ? 'PRIVATE_AI' : maxPrivacy === 1 ? 'LIMITED_AI' : 'PUBLIC_AI',
    contextTruncated, authorConsentVector: await crypto.subtle.digest('SHA-256', new TextEncoder().encode([...authorPairs].sort().join('|'))).then((digest) => [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('')),
  };
}

export function selectMedia(manifest: VersionedContextManifest, mode: MediaUsageMode, target: MediaTarget): MediaManifestItem[] {
  if (mode === 'TEXT_ONLY') return [];
  const supported = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const priority: Record<ContextSource['relation'], number> = { current: 0, quote: 1, reply_parent: 2, thread: 3, reply: 4 };
  return manifest.media
    // Older migrated media records intentionally contain only the R2 object
    // URL. The MIME is inferred above and the media worker derives a stable
    // cache identity when sha256 was not persisted, so valid R2 images remain
    // Vision-eligible without trusting client-supplied metadata.
    .filter((item) => item.allowedByConsent && item.objectKey && supported.has(item.mimeType))
    .filter((item) => target === 'ALL_RELEVANT' || item.sourceRelation === 'current')
    .sort((left, right) => priority[left.sourceRelation] - priority[right.sourceRelation] || left.position - right.position)
    .slice(0, AI_LIMITS.maxImages);
}

export function scopeManifestForRequest(manifest: VersionedContextManifest, mode: MediaUsageMode, selectedMedia: MediaManifestItem[]): VersionedContextManifest {
  const mediaSourceRefs = new Set(selectedMedia.map((item) => item.belongsTo));
  const sources = manifest.sources.filter((source) => (source.allowText && Boolean(source.text)) || (mode !== 'TEXT_ONLY' && mediaSourceRefs.has(source.ref)));
  const rank = (visibility: string) => visibility === 'private' ? 2 : visibility === 'public' ? 0 : 1;
  const maximum = sources.length ? Math.max(...sources.map((source) => rank(source.visibility))) : 0;
  return {
    ...manifest,
    sources,
    media: mode === 'TEXT_ONLY' ? [] : manifest.media.filter((item) => mediaSourceRefs.has(item.belongsTo)),
    privacyClass: maximum === 2 ? 'PRIVATE_AI' : maximum === 1 ? 'LIMITED_AI' : 'PUBLIC_AI',
  };
}

export function serializeContext(manifest: VersionedContextManifest): string {
  return JSON.stringify({ posts: manifest.sources.filter((source) => source.allowText && source.text).map((source) => ({
    ref: source.ref,
    type: source.relation,
    // A profile manifest contains multiple posts by the same profile owner.
    // Keep that identity stable in the prompt so the model does not mistake
    // each post for a separate user's opinion.
    author: source.relation === 'current' || (manifest.subjectType === 'profile' && source.authorId === manifest.currentAuthorId)
      ? 'CurrentAuthor'
      : `Author${source.order}`,
    text: source.text,
  })) });
}

export async function revalidateManifest(db: D1Database, viewerId: string, expected: VersionedContextManifest, ignoreMediaVersion = false, excludeProductionFixtures = false): Promise<boolean> {
  const fresh = expected.subjectType === 'profile' && expected.subjectId
    ? await buildProfileContextManifest(db, viewerId, expected.subjectId, 'revalidation-only', excludeProductionFixtures, expected.sources.filter((source) => source.type === 'post').map((source) => source.actualId))
    : await buildContextManifest(db, viewerId, expected.currentPostId, 'revalidation-only', excludeProductionFixtures);
  if (!fresh) return false;
  const current = new Map(fresh.sources.map((source) => [source.actualId, source]));
  return expected.sources.every((source) => {
    const next = current.get(source.actualId);
    return Boolean(next && next.contentVersion === source.contentVersion && next.accessVersion === source.accessVersion && (ignoreMediaVersion || next.mediaVersion === source.mediaVersion) && next.structureVersion === source.structureVersion && next.authorPreferenceVersion === source.authorPreferenceVersion && next.postConsentVersion === source.postConsentVersion && next.acceptedPolicyVersion === source.acceptedPolicyVersion && next.allowText === source.allowText && next.allowMedia === source.allowMedia);
  });
}
