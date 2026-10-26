ALTER TABLE cloud_installation ADD COLUMN remote_config jsonb NOT NULL DEFAULT '{}';

CREATE TABLE cloud_imports (
  source_id text PRIMARY KEY,
  source_digest text NOT NULL,
  source_path text NOT NULL,
  config_path text NOT NULL,
  cleanup_files jsonb NOT NULL,
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  user_id uuid NOT NULL REFERENCES cloud_users(id),
  row_counts jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  cleaned_at timestamptz
);
