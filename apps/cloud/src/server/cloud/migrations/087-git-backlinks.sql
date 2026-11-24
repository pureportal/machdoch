ALTER TABLE cloud_git_settings ADD COLUMN backlinks_private boolean NOT NULL DEFAULT true;
ALTER TABLE cloud_git_settings ADD COLUMN backlinks_public boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_git_settings ADD COLUMN backlink_descriptions boolean NOT NULL DEFAULT false;

CREATE TABLE cloud_git_backlinks (
  organization_id uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  external_id text CHECK (length(external_id) BETWEEN 1 AND 40),
  digest text CHECK (digest ~ '^[0-9a-f]{32}$'),
  attempted_at timestamptz,
  last_error text CHECK (length(last_error) <= 500),
  PRIMARY KEY (organization_id, pull_request_id),
  CHECK ((external_id IS NULL) = (digest IS NULL)),
  FOREIGN KEY (organization_id, pull_request_id) REFERENCES cloud_git_pull_requests(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX cloud_run_deliveries_pull_request ON cloud_run_deliveries(organization_id, pull_request_id) WHERE pull_request_id IS NOT NULL;
