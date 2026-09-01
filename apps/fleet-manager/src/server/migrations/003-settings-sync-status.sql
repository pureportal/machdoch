ALTER TABLE settings_assignments
  ADD COLUMN last_sync_revision INTEGER;

ALTER TABLE settings_assignments
  ADD COLUMN last_sync_attempt_at INTEGER;

ALTER TABLE settings_assignments
  ADD COLUMN last_sync_error TEXT;

UPDATE settings_assignments
SET last_sync_revision = last_applied_revision,
    last_sync_attempt_at = last_applied_at;
