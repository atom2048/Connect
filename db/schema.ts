import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const authUser = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({ emailIndex: uniqueIndex('user_email_unique').on(table.email) }));

export const authSession = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
}, (table) => ({ tokenIndex: uniqueIndex('session_token_unique').on(table.token), userIndex: index('session_user_idx').on(table.userId) }));

export const authAccount = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUser.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({ accountUserIndex: index('account_user_idx').on(table.userId) }));

export const authVerification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at'),
  updatedAt: timestamp('updated_at'),
}, (table) => ({ identifierIndex: index('verification_identifier_idx').on(table.identifier) }));

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  username: text('username').notNull(),
  email: text('email'),
  bio: text('bio'),
  avatarUrl: text('avatar_url'),
  coverUrl: text('cover_url'),
  avatarColor: text('avatar_color').notNull().default('#4f46e5'),
  countsJson: text('counts_json'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({ usernameUnique: uniqueIndex('profiles_username_unique').on(table.username), usernameSearch: index('profiles_username_idx').on(table.username) }));

export const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull().references(() => profiles.id),
  body: text('body').notNull().default(''),
  visibility: text('visibility').notNull().default('public'),
  mediaJson: text('media_json'),
  hashtagsJson: text('hashtags_json'),
  mentionsJson: text('mentions_json'),
  quotedPostId: text('quoted_post_id'),
  replyToPostId: text('reply_to_post_id'),
  threadRootId: text('thread_root_id'),
  pollJson: text('poll_json'),
  countsJson: text('counts_json'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  deletedAt: timestamp('deleted_at'),
  deleteReason: text('delete_reason'),
  deletedBy: text('deleted_by'),
  contentVersion: integer('content_version').notNull().default(1),
  accessVersion: integer('access_version').notNull().default(1),
  mediaVersion: integer('media_version').notNull().default(1),
  structureVersion: integer('structure_version').notNull().default(1),
  firestoreUpdateTime: text('firestore_update_time'),
}, (table) => ({
  feedIndex: index('posts_feed_idx').on(table.createdAt, table.id),
  authorFeedIndex: index('posts_author_feed_idx').on(table.authorId, table.createdAt, table.id),
  visibilityIndex: index('posts_visibility_idx').on(table.visibility, table.createdAt, table.id),
  replyIndex: index('idx_posts_reply_created').on(table.replyToPostId, table.createdAt),
  threadIndex: index('idx_posts_thread_created').on(table.threadRootId, table.createdAt),
}));

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => profiles.id),
  body: text('body').notNull().default(''),
  parentCommentId: text('parent_comment_id'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
  deletedAt: timestamp('deleted_at'),
  contentVersion: integer('content_version').notNull().default(1),
  accessVersion: integer('access_version').notNull().default(1),
  mediaVersion: integer('media_version').notNull().default(1),
  structureVersion: integer('structure_version').notNull().default(1),
}, (table) => ({ postIndex: index('comments_post_idx').on(table.postId, table.createdAt, table.id), parentIndex: index('idx_comments_parent_created').on(table.parentCommentId, table.createdAt) }));

export const aiAuthorPreferences = sqliteTable('ai_author_preferences', {
  userId: text('user_id').primaryKey().references(() => profiles.id, { onDelete: 'cascade' }),
  acceptedPolicyVersion: text('accepted_policy_version'),
  preferenceVersion: integer('preference_version').notNull().default(1),
  textAnalysis: text('text_analysis').notNull().default('DISABLED'),
  mediaAnalysis: text('media_analysis').notNull().default('DISABLED'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

/**
 * Per-post AI consent.  A missing row is intentionally interpreted as
 * enabled for public posts and disabled for restricted posts.  Restricted
 * content therefore requires an explicit author action before it can enter
 * an AI context, while the existing ACL remains the authoritative viewer
 * boundary.
 */
export const postAiConsents = sqliteTable('post_ai_consents', {
  postId: text('post_id').primaryKey().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  acceptedPolicyVersion: text('accepted_policy_version'),
  consentVersion: integer('consent_version').notNull().default(1),
  textAnalysis: text('text_analysis').notNull().default('DISABLED'),
  mediaAnalysis: text('media_analysis').notNull().default('DISABLED'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({ authorIndex: index('post_ai_consents_author_idx').on(table.authorId) }));

export const aiCache = sqliteTable('ai_cache', {
  cacheKey: text('cache_key').primaryKey(),
  semanticFingerprint: text('semantic_fingerprint').notNull(),
  generationId: text('generation_id').notNull(),
  generationPolicyVersion: text('generation_policy_version').notNull(),
  responseJson: text('response_json').notNull(),
  sourceVersionsJson: text('source_versions_json').notNull(),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (table) => ({ expiresIndex: index('idx_ai_cache_expires').on(table.expiresAt) }));

export const aiUserDailyQuota = sqliteTable('ai_user_daily_quota', {
  userId: text('user_id').notNull(),
  bucketStart: timestamp('bucket_start').notNull(),
  generationReserved: integer('generation_reserved').notNull().default(0),
  generationCommitted: integer('generation_committed').notNull().default(0),
  upstreamDispatched: integer('upstream_dispatched').notNull().default(0),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({ primary: uniqueIndex('ai_user_daily_quota_pk').on(table.userId, table.bucketStart) }));

export const aiEndpointSnapshots = sqliteTable('ai_endpoint_snapshots', {
  snapshotId: text('snapshot_id').primaryKey(),
  modelKey: text('model_key').notNull(),
  requestedModel: text('requested_model').notNull(),
  canonicalModel: text('canonical_model').notNull(),
  providerModel: text('provider_model').notNull(),
  providerBaseSlug: text('provider_base_slug').notNull(),
  providerEndpointSlug: text('provider_endpoint_slug').notNull(),
  policyState: text('policy_state').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  generationPolicyVersion: text('generation_policy_version').notNull(),
  verifiedAt: timestamp('verified_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  manuallyAcceptedAt: timestamp('manually_accepted_at'),
}, (table) => ({ lookup: index('idx_ai_endpoint_snapshots_lookup').on(table.modelKey, table.policyState, table.expiresAt) }));

export const aiGenerationDiagnostics = sqliteTable('ai_generation_diagnostics', {
  generationId: text('generation_id').primaryKey(),
  modelClass: text('model_class').notNull(),
  route: text('route').notNull(),
  modality: text('modality').notNull(),
  degraded: integer('degraded', { mode: 'boolean' }).notNull().default(false),
  groundingStatus: text('grounding_status').notNull(),
  latencyBucket: text('latency_bucket').notNull(),
  promptVersion: text('prompt_version').notNull(),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (table) => ({ expiresIndex: index('idx_ai_generation_diagnostics_expires').on(table.expiresAt) }));

/**
 * Redacted routing evidence for a completed upstream generation.  This table
 * intentionally contains no viewer, prompt, context, media, token, or secret
 * values; it only preserves the fields needed to audit the zero-cost policy.
 */
export const aiGenerationRoutingAudit = sqliteTable('ai_generation_routing_audit', {
  generationId: text('generation_id').primaryKey(),
  modelClass: text('model_class').notNull(),
  actualModel: text('actual_model').notNull(),
  actualProvider: text('actual_provider').notNull(),
  byok: integer('byok', { mode: 'boolean' }).notNull().default(false),
  attempt: integer('attempt').notNull().default(1),
  fallback: integer('fallback', { mode: 'boolean' }).notNull().default(false),
  reportedCost: integer('reported_cost').notNull().default(0),
  costVerification: text('cost_verification').notNull().default('ZERO'),
  modality: text('modality').notNull(),
  createdAt: timestamp('created_at').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (table) => ({ expiresIndex: index('idx_ai_generation_routing_audit_expires').on(table.expiresAt) }));

export const likes = sqliteTable('likes', {
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({ primary: uniqueIndex('likes_post_user_unique').on(table.postId, table.userId), userIndex: index('likes_user_idx').on(table.userId, table.createdAt) }));

export const bookmarks = sqliteTable('bookmarks', {
  postId: text('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({ primary: uniqueIndex('bookmarks_post_user_unique').on(table.postId, table.userId), userIndex: index('bookmarks_user_idx').on(table.userId, table.createdAt) }));

export const friendships = sqliteTable('friendships', {
  requesterId: text('requester_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  addresseeId: text('addressee_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('accepted'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({ primary: uniqueIndex('friendships_pair_unique').on(table.requesterId, table.addresseeId), statusIndex: index('friendships_status_idx').on(table.status, table.requesterId, table.addresseeId) }));

export const blocks = sqliteTable('blocks', {
  blockerId: text('blocker_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  blockedId: text('blocked_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({ primary: uniqueIndex('blocks_pair_unique').on(table.blockerId, table.blockedId), blockedIndex: index('blocks_blocked_idx').on(table.blockedId, table.blockerId) }));

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').references(() => profiles.id),
  type: text('type').notNull(),
  payloadJson: text('payload_json'),
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({ userIndex: index('notifications_user_idx').on(table.userId, table.createdAt) }));

export const postReports = sqliteTable('post_reports', {
  id: text('id').primaryKey(),
  postId: text('post_id').notNull(),
  reporterId: text('reporter_id').notNull(),
  reasonCode: text('reason_code').notNull(),
  details: text('details'),
  status: text('status').notNull().default('open'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({ postIndex: index('post_reports_post_idx').on(table.postId, table.createdAt), reporterUnique: uniqueIndex('post_reports_reporter_unique').on(table.postId, table.reporterId) }));

export const moderationAudit = sqliteTable('moderation_audit', {
  id: text('id').primaryKey(),
  postId: text('post_id').notNull(),
  authorId: text('author_id').notNull(),
  adminId: text('admin_id').notNull(),
  action: text('action').notNull(),
  reasonCode: text('reason_code'),
  status: text('status').notNull(),
  notificationStatus: text('notification_status').notNull().default('not_applicable'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({ postIndex: index('moderation_audit_post_idx').on(table.postId, table.createdAt), adminIndex: index('moderation_audit_admin_idx').on(table.adminId, table.createdAt) }));

export const moderationSnapshots = sqliteTable('moderation_snapshots', {
  actionId: text('action_id').primaryKey().references(() => moderationAudit.id),
  postId: text('post_id').notNull(),
  authorId: text('author_id').notNull(),
  snapshotJson: text('snapshot_json').notNull(),
  capturedAt: timestamp('captured_at').notNull(),
  restoredAt: timestamp('restored_at'),
}, (table) => ({ postIndex: index('moderation_snapshots_post_idx').on(table.postId, table.capturedAt) }));

export const moderationAppeals = sqliteTable('moderation_appeals', {
  id: text('id').primaryKey(),
  postId: text('post_id').notNull(),
  userId: text('user_id').notNull(),
  message: text('message').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').notNull(),
  reviewedAt: timestamp('reviewed_at'),
  reviewedBy: text('reviewed_by'),
}, (table) => ({ postIndex: index('moderation_appeals_post_idx').on(table.postId, table.createdAt), userIndex: index('moderation_appeals_user_idx').on(table.userId, table.createdAt) }));

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
}, (table) => ({ endpointUnique: uniqueIndex('push_endpoint_unique').on(table.endpoint), userIndex: index('push_user_idx').on(table.userId) }));

export const rumSamples = sqliteTable('rum_samples', {
  id: text('id').primaryKey(),
  route: text('route').notNull(),
  lcp: integer('lcp'),
  inp: integer('inp'),
  cls: integer('cls'),
  ttfb: integer('ttfb'),
  jsBytes: integer('js_bytes'),
  imageBytes: integer('image_bytes'),
  createdAt: timestamp('created_at').notNull(),
}, (table) => ({ routeIndex: index('rum_route_idx').on(table.route, table.createdAt) }));

export const migrationState = sqliteTable('migration_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});
