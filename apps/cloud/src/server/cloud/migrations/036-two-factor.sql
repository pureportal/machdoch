CREATE TABLE cloud_authenticators (
  user_id uuid PRIMARY KEY REFERENCES cloud_users(id) ON DELETE CASCADE,
  secret bytea NOT NULL,
  last_step bigint NOT NULL CHECK (last_step >= 0),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cloud_recovery_codes (
  user_id uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);
ALTER TABLE cloud_sessions ADD COLUMN second_factor_at timestamptz;
ALTER TABLE cloud_sessions ADD COLUMN authenticator_setup bytea;
ALTER FUNCTION cloud_session_active(cloud_sessions) RENAME TO cloud_session_valid;
CREATE FUNCTION cloud_session_active(session cloud_sessions) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT session.second_factor_at IS NOT NULL AND cloud_session_valid(session);
$$;
DELETE FROM cloud_sessions;
UPDATE cloud_oauth_grants SET revoked_at=now() WHERE revoked_at IS NULL;
