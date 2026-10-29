CREATE SCHEMA IF NOT EXISTS remote;
CREATE TABLE IF NOT EXISTS remote.metadata (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS remote.enrollment_grants (
  id text PRIMARY KEY, key_hash text NOT NULL UNIQUE, created_at double precision NOT NULL,
  expires_at double precision NOT NULL, used_at double precision
);
CREATE INDEX IF NOT EXISTS enrollment_grants_available ON remote.enrollment_grants (used_at,expires_at);
CREATE TABLE IF NOT EXISTS remote.instances (
  instance_id text PRIMARY KEY, display_name text NOT NULL, secret_hash text NOT NULL,
  product_version text NOT NULL, protocol_version integer NOT NULL,
  enrolled_at double precision NOT NULL, last_seen_at double precision, revoked_at double precision
);
CREATE TABLE IF NOT EXISTS remote.audit_log (
  id serial PRIMARY KEY, occurred_at double precision NOT NULL, action text NOT NULL,
  subject_id text, outcome text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_time ON remote.audit_log (occurred_at);
CREATE TABLE IF NOT EXISTS remote.settings_profiles (
  profile_id text PRIMARY KEY, name text NOT NULL, description text NOT NULL,
  revision integer NOT NULL, document_json text NOT NULL,
  created_at double precision NOT NULL, updated_at double precision NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS settings_profile_name ON remote.settings_profiles (lower(name));
CREATE TABLE IF NOT EXISTS remote.settings_profile_versions (
  profile_id text NOT NULL REFERENCES remote.settings_profiles(profile_id) ON DELETE CASCADE,
  revision integer NOT NULL, name text NOT NULL, description text NOT NULL,
  document_json text NOT NULL, change_summary text NOT NULL, created_at double precision NOT NULL,
  PRIMARY KEY (profile_id,revision)
);
CREATE INDEX IF NOT EXISTS settings_profile_versions_time ON remote.settings_profile_versions (profile_id,revision DESC);
CREATE TABLE IF NOT EXISTS remote.settings_secrets (
  profile_id text NOT NULL REFERENCES remote.settings_profiles(profile_id) ON DELETE CASCADE,
  secret_id text NOT NULL, ciphertext bytea NOT NULL, last_four text NOT NULL,
  updated_at double precision NOT NULL, PRIMARY KEY (profile_id,secret_id)
);
CREATE TABLE IF NOT EXISTS remote.settings_assignments (
  instance_id text PRIMARY KEY REFERENCES remote.instances(instance_id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES remote.settings_profiles(profile_id) ON DELETE CASCADE,
  assigned_at double precision NOT NULL, last_applied_revision integer,
  last_applied_at double precision, last_sync_revision integer,
  last_sync_attempt_at double precision, last_sync_error text
);
CREATE INDEX IF NOT EXISTS settings_assignments_profile ON remote.settings_assignments (profile_id);
CREATE TABLE IF NOT EXISTS remote.enrollment_settings (
  instance_id text PRIMARY KEY REFERENCES remote.instances(instance_id),
  document_ciphertext bytea NOT NULL, captured_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS remote.fleet_session_routes (
  command_id text PRIMARY KEY, request_digest text NOT NULL,
  instance_id text NOT NULL REFERENCES remote.instances(instance_id),
  workspace text NOT NULL, session_id text, created_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS remote.settings_profile_assignments (
  instance_id text NOT NULL REFERENCES remote.instances(instance_id) ON DELETE CASCADE,
  profile_id text NOT NULL REFERENCES remote.settings_profiles(profile_id) ON DELETE CASCADE,
  position integer NOT NULL, assigned_at double precision NOT NULL,
  last_applied_revision integer, last_applied_at double precision,
  last_sync_revision integer, last_sync_attempt_at double precision, last_sync_error text,
  PRIMARY KEY (instance_id, profile_id)
);
CREATE INDEX IF NOT EXISTS settings_profile_assignments_profile ON remote.settings_profile_assignments (profile_id);
DELETE FROM remote.settings_profile_assignments
  WHERE instance_id IN (SELECT instance_id FROM remote.settings_assignments);
INSERT INTO remote.settings_profile_assignments
  (instance_id, profile_id, position, assigned_at, last_applied_revision, last_applied_at,
   last_sync_revision, last_sync_attempt_at, last_sync_error)
  SELECT instance_id, profile_id, 0, assigned_at, last_applied_revision, last_applied_at,
         last_sync_revision, last_sync_attempt_at, last_sync_error
  FROM remote.settings_assignments
  ON CONFLICT DO NOTHING;
DELETE FROM remote.settings_assignments;
CREATE TABLE IF NOT EXISTS remote.settings_sync_warnings (
  instance_id text PRIMARY KEY REFERENCES remote.instances(instance_id) ON DELETE CASCADE,
  warnings_json text NOT NULL, reported_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS remote.settings_snapshot_requests (
  instance_id text PRIMARY KEY REFERENCES remote.instances(instance_id) ON DELETE CASCADE,
  requested_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS remote.settings_proposals (
  proposal_id text PRIMARY KEY,
  instance_id text NOT NULL REFERENCES remote.instances(instance_id) ON DELETE CASCADE,
  kind text NOT NULL, payload_ciphertext bytea NOT NULL, created_at double precision NOT NULL,
  status text NOT NULL, resolved_at double precision, resolved_profile_id text
);
CREATE INDEX IF NOT EXISTS settings_proposals_pending ON remote.settings_proposals (status, created_at)
