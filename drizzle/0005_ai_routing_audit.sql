CREATE TABLE IF NOT EXISTS ai_generation_routing_audit (
  generation_id text PRIMARY KEY NOT NULL,
  model_class text NOT NULL,
  actual_model text NOT NULL CHECK (length(actual_model) BETWEEN 1 AND 256),
  actual_provider text NOT NULL CHECK (length(actual_provider) BETWEEN 1 AND 256),
  byok integer NOT NULL DEFAULT 0 CHECK (byok = 0),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt = 1),
  fallback integer NOT NULL DEFAULT 0 CHECK (fallback IN (0,1)),
  reported_cost integer NOT NULL DEFAULT 0 CHECK (reported_cost = 0),
  cost_verification text NOT NULL DEFAULT 'ZERO' CHECK (cost_verification = 'ZERO'),
  modality text NOT NULL CHECK (modality IN ('text','vision')),
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_generation_routing_audit_expires ON ai_generation_routing_audit(expires_at);
