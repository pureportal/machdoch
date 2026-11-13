CREATE TABLE cloud_team_resources (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL REFERENCES cloud_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_team_resources_team ON cloud_team_resources(organization_id,team_id,created_at);
