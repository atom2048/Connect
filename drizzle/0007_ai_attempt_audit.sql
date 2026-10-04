CREATE TABLE IF NOT EXISTS ai_generation_attempt_audit (
  request_id text NOT NULL,
  generation_id text NOT NULL,
  attempt_ordinal integer NOT NULL,
  model_class text NOT NULL,
  provider_endpoint text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCESS','FAILED')),
  reason text,
  status integer,
  fallback_eligible integer NOT NULL DEFAULT 0 CHECK (fallback_eligible IN (0,1)),
  retry_used integer NOT NULL DEFAULT 0 CHECK (retry_used IN (0,1)),
  finish_reason text,
  duration_ms integer NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL,
  PRIMARY KEY(request_id, attempt_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_ai_generation_attempt_audit_expires ON ai_generation_attempt_audit(expires_at);
CREATE INDEX IF NOT EXISTS idx_ai_generation_attempt_audit_generation ON ai_generation_attempt_audit(generation_id, attempt_ordinal);
