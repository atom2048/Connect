export interface Env {
  ASSETS?: Fetcher;
  DB?: D1Database;
  MEDIA?: R2Bucket;
  IMAGES?: ImagesBinding;
  AI_COORDINATOR?: DurableObjectNamespace;
  AI_CONTROL_PLANE?: DurableObjectNamespace;
  AI_INTERACTION_LIMITER?: RateLimit;
  PUSH_QUEUE?: Queue<PushJob>;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  FIREBASE_PROJECT_ID?: string;
  MIGRATION_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /**
   * Bound only as a Cloudflare Worker Secret.  Runtime callers still check for
   * an empty value so a misconfigured Worker fails closed with a safe code.
   */
  OPENROUTER_API_KEY: string;
  CONNECT_ALLOWED_ORIGINS?: string;
  AI_UI_ENABLED?: string;
  AI_GENERATION_ENABLED?: string;
  AI_TEXT_READY?: string;
  AI_VISION_READY?: string;
  AI_ADMIN_ONLY?: string;
  AI_ADMIN_USER_IDS?: string;
  AI_ENVIRONMENT?: 'production' | 'staging' | 'admin';
  AI_CONSENT_FINGERPRINT_SECRET?: string;
  AI_COORDINATOR_KEY_SECRET?: string;
  AI_FEEDBACK_SIGNING_SECRET?: string;
  AI_ROLLOUT_HASH_SECRET?: string;
  AI_ROLLOUT_PERCENT?: string;
  LOG_PSEUDONYM_MASTER_SECRET?: string;
  AI_ALERT_WEBHOOK_URL?: string;
  AI_ALERT_SIGNING_SECRET?: string;
}

export interface PushJob {
  kind: 'notification';
  notificationId: string;
  userId: string;
}

export type Viewer = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  /** Set only from a verified Firebase custom claim. BetterAuth sessions are never admins by default. */
  role?: 'admin' | 'user';
};

export type ProfileRow = {
  id: string;
  display_name: string;
  username: string;
  email?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  cover_url?: string | null;
  avatar_color?: string | null;
  counts_json?: string | null;
  created_at: number;
  updated_at: number;
};

export type PostRow = {
  id: string;
  author_id: string;
  body: string;
  visibility: string;
  media_json?: string | null;
  hashtags_json?: string | null;
  mentions_json?: string | null;
  quoted_post_id?: string | null;
  poll_json?: string | null;
  counts_json?: string | null;
  created_at: number;
  updated_at: number;
  deleted_at?: number | null;
  delete_reason?: string | null;
  deleted_by?: string | null;
  /** `null` is the explicit result of a missing profile LEFT JOIN. */
  author_profile_id?: string | null;
  author_name?: string | null;
  author_username?: string | null;
  author_avatar_url?: string | null;
  author_avatar_color?: string | null;
  liked?: number;
  bookmarked?: number;
  likes_count?: number;
  comments_count?: number;
};
