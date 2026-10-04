CREATE TABLE post_ai_consents (
  post_id text PRIMARY KEY NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  accepted_policy_version text,
  consent_version integer NOT NULL DEFAULT 1,
  text_analysis text NOT NULL DEFAULT 'DISABLED' CHECK (text_analysis IN ('DISABLED','AUTHORIZED_CONTEXT')),
  media_analysis text NOT NULL DEFAULT 'DISABLED' CHECK (media_analysis IN ('DISABLED','AUTHORIZED_CONTEXT')),
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX post_ai_consents_author_idx ON post_ai_consents(author_id);
