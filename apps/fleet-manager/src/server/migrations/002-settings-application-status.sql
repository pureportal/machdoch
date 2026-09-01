ALTER TABLE settings_assignments
  RENAME COLUMN last_fetched_revision TO last_applied_revision;

ALTER TABLE settings_assignments
  RENAME COLUMN last_fetched_at TO last_applied_at;

UPDATE settings_assignments
SET last_applied_revision = NULL,
    last_applied_at = NULL;
