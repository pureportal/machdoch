CREATE TABLE fleet_session_routes (
  command_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances(instance_id),
  workspace TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;
