CREATE TABLE ai_generation_diagnostics (
  generation_id text PRIMARY KEY NOT NULL,
  model_class text NOT NULL,
  route text NOT NULL,
  modality text NOT NULL,
  degraded integer NOT NULL DEFAULT 0,
  grounding_status text NOT NULL,
  latency_bucket text NOT NULL,
  prompt_version text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX idx_ai_generation_diagnostics_expires ON ai_generation_diagnostics(expires_at);

CREATE TABLE ai_idempotency (
  viewer_id text NOT NULL,
  idempotency_key text NOT NULL,
  binding_hash text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL,
  PRIMARY KEY(viewer_id,idempotency_key)
);
CREATE INDEX idx_ai_idempotency_expires ON ai_idempotency(expires_at);
