ALTER TABLE posts ADD COLUMN delete_reason text;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN deleted_by text;
--> statement-breakpoint
CREATE TABLE post_reports (
  id text PRIMARY KEY NOT NULL,
  post_id text NOT NULL,
  reporter_id text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('spam', 'harassment', 'illegal', 'other')),
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX post_reports_reporter_unique ON post_reports(post_id, reporter_id);
--> statement-breakpoint
CREATE INDEX post_reports_post_idx ON post_reports(post_id, created_at);
--> statement-breakpoint
CREATE TABLE moderation_audit (
  id text PRIMARY KEY NOT NULL,
  post_id text NOT NULL,
  author_id text NOT NULL,
  admin_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('delete', 'restore')),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN ('spam', 'harassment', 'illegal', 'other')),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  notification_status text NOT NULL DEFAULT 'not_applicable' CHECK (notification_status IN ('not_applicable', 'pending', 'sent', 'failed')),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX moderation_audit_post_idx ON moderation_audit(post_id, created_at);
--> statement-breakpoint
CREATE INDEX moderation_audit_admin_idx ON moderation_audit(admin_id, created_at);
--> statement-breakpoint
CREATE TABLE moderation_snapshots (
  action_id text PRIMARY KEY NOT NULL REFERENCES moderation_audit(id),
  post_id text NOT NULL,
  author_id text NOT NULL,
  snapshot_json text NOT NULL,
  captured_at integer NOT NULL,
  restored_at integer
);
--> statement-breakpoint
CREATE INDEX moderation_snapshots_post_idx ON moderation_snapshots(post_id, captured_at);
--> statement-breakpoint
CREATE UNIQUE INDEX moderation_snapshots_active_post_unique ON moderation_snapshots(post_id) WHERE restored_at IS NULL;
--> statement-breakpoint
CREATE TABLE moderation_appeals (
  id text PRIMARY KEY NOT NULL,
  post_id text NOT NULL,
  user_id text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'rejected')),
  created_at integer NOT NULL,
  reviewed_at integer,
  reviewed_by text
);
--> statement-breakpoint
CREATE INDEX moderation_appeals_post_idx ON moderation_appeals(post_id, created_at);
--> statement-breakpoint
CREATE INDEX moderation_appeals_user_idx ON moderation_appeals(user_id, created_at);
