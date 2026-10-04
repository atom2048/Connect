CREATE TABLE IF NOT EXISTS ai_predeploy_progress (
  resource_key text PRIMARY KEY NOT NULL,
  phase text NOT NULL CHECK (phase IN ('METADATA_VALID','SMOKE_VALID')),
  progress_json text NOT NULL,
  verified_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_predeploy_progress_expiry ON ai_predeploy_progress(expires_at);
