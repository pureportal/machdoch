CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS owner_sessions (
  session_id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  username TEXT NOT NULL,
  client_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS owner_sessions_expiry
  ON owner_sessions (absolute_expires_at, idle_expires_at);

CREATE TABLE IF NOT EXISTS enrollment_grants (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS enrollment_grants_available
  ON enrollment_grants (used_at, expires_at);

CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  product_version TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  enrolled_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT,
  outcome TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS audit_log_time ON audit_log (occurred_at);

CREATE TABLE IF NOT EXISTS settings_profiles (
  profile_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings_profile_versions (
  profile_id TEXT NOT NULL REFERENCES settings_profiles(profile_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  document_json TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, revision)
) STRICT;

CREATE INDEX IF NOT EXISTS settings_profile_versions_time
  ON settings_profile_versions (profile_id, revision DESC);

CREATE TABLE IF NOT EXISTS settings_secrets (
  profile_id TEXT NOT NULL REFERENCES settings_profiles(profile_id) ON DELETE CASCADE,
  secret_id TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  last_four TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, secret_id)
) STRICT;

CREATE TABLE IF NOT EXISTS settings_assignments (
  instance_id TEXT PRIMARY KEY REFERENCES instances(instance_id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES settings_profiles(profile_id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL,
  last_fetched_revision INTEGER,
  last_fetched_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS settings_assignments_profile
  ON settings_assignments (profile_id);
