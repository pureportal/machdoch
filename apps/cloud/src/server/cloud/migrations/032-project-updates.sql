CREATE TABLE cloud_project_updates (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES cloud_users(id),
  health text NOT NULL CHECK (health IN ('on_track','at_risk','off_track')),
  body text NOT NULL CHECK (length(body) <= 20000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,project_id) REFERENCES cloud_projects(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_project_updates_project ON cloud_project_updates(organization_id,project_id,created_at DESC,id);
