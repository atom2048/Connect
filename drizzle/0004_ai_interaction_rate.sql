CREATE TABLE IF NOT EXISTS ai_interaction_rate_limits (
  rate_key text PRIMARY KEY NOT NULL,
  window_start integer NOT NULL,
  request_count integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_interaction_rate_limits_expiry ON ai_interaction_rate_limits(expires_at);
