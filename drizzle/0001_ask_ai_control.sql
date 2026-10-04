ALTER TABLE posts ADD COLUMN reply_to_post_id text;
ALTER TABLE posts ADD COLUMN thread_root_id text;
ALTER TABLE posts ADD COLUMN content_version integer NOT NULL DEFAULT 1;
ALTER TABLE posts ADD COLUMN access_version integer NOT NULL DEFAULT 1;
ALTER TABLE posts ADD COLUMN media_version integer NOT NULL DEFAULT 1;
ALTER TABLE posts ADD COLUMN structure_version integer NOT NULL DEFAULT 1;

ALTER TABLE comments ADD COLUMN parent_comment_id text;
ALTER TABLE comments ADD COLUMN content_version integer NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN access_version integer NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN media_version integer NOT NULL DEFAULT 1;
ALTER TABLE comments ADD COLUMN structure_version integer NOT NULL DEFAULT 1;

CREATE INDEX idx_posts_reply_created ON posts(reply_to_post_id, created_at);
CREATE INDEX idx_posts_thread_created ON posts(thread_root_id, created_at);
CREATE INDEX idx_comments_parent_created ON comments(parent_comment_id, created_at);

CREATE TABLE ai_author_preferences (
  user_id text PRIMARY KEY NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  accepted_policy_version text,
  preference_version integer NOT NULL DEFAULT 1,
  text_analysis text NOT NULL DEFAULT 'DISABLED' CHECK (text_analysis IN ('DISABLED','PUBLIC_ONLY','AUTHORIZED_CONTEXT')),
  media_analysis text NOT NULL DEFAULT 'DISABLED' CHECK (media_analysis IN ('DISABLED','PUBLIC_ONLY','AUTHORIZED_CONTEXT')),
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE ai_cache (
  cache_key text PRIMARY KEY NOT NULL,
  semantic_fingerprint text NOT NULL,
  generation_id text NOT NULL,
  generation_policy_version text NOT NULL,
  response_json text NOT NULL,
  source_versions_json text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX idx_ai_cache_expires ON ai_cache(expires_at);

CREATE TABLE ai_user_daily_quota (
  user_id text NOT NULL,
  bucket_start integer NOT NULL,
  generation_reserved integer NOT NULL DEFAULT 0,
  generation_committed integer NOT NULL DEFAULT 0,
  upstream_dispatched integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL,
  PRIMARY KEY(user_id, bucket_start)
);

CREATE TABLE ai_generation_reservations (
  reservation_id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  bucket_start integer NOT NULL,
  state text NOT NULL CHECK (state IN ('RESERVED','COMMITTED','RELEASED')),
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_ai_generation_reservations_user ON ai_generation_reservations(user_id, bucket_start, state);

CREATE TABLE ai_endpoint_snapshots (
  snapshot_id text PRIMARY KEY NOT NULL,
  model_key text NOT NULL,
  requested_model text NOT NULL,
  canonical_model text NOT NULL,
  provider_model text NOT NULL,
  provider_base_slug text NOT NULL,
  provider_endpoint_slug text NOT NULL,
  policy_state text NOT NULL CHECK (policy_state IN ('VALID','INVALID','UNKNOWN')),
  snapshot_json text NOT NULL,
  generation_policy_version text NOT NULL,
  verified_at integer NOT NULL,
  expires_at integer NOT NULL,
  manually_accepted_at integer
);
CREATE INDEX idx_ai_endpoint_snapshots_lookup ON ai_endpoint_snapshots(model_key, policy_state, expires_at);

CREATE TABLE ai_invalid_generation_policies (
  generation_policy_version text PRIMARY KEY NOT NULL,
  reason text NOT NULL,
  invalidated_at integer NOT NULL
);

CREATE TABLE ai_feedback (
  generation_id text NOT NULL,
  viewer_hash text NOT NULL,
  rating integer NOT NULL CHECK (rating IN (-1,1)),
  diagnostic_json text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL,
  PRIMARY KEY(generation_id, viewer_hash)
);
CREATE INDEX idx_ai_feedback_expires ON ai_feedback(expires_at);
