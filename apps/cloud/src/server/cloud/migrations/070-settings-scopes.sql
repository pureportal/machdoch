CREATE TABLE cloud_user_settings (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9.]{0,99}$'),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id, key),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_organization_settings (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9.]{0,99}$'),
  value jsonb NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, key)
);

CREATE TABLE cloud_team_settings (
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9.]{0,99}$'),
  value jsonb NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, team_id, key),
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id) ON DELETE CASCADE
);

ALTER TABLE cloud_teams ADD COLUMN parent_team_id uuid;
ALTER TABLE cloud_teams ADD CONSTRAINT cloud_teams_parent_fk FOREIGN KEY (organization_id, parent_team_id) REFERENCES cloud_teams(organization_id, id) ON DELETE SET NULL (parent_team_id);
ALTER TABLE cloud_teams ADD CONSTRAINT cloud_teams_parent_not_self CHECK (parent_team_id IS NULL OR parent_team_id <> id);
CREATE INDEX cloud_teams_parent_idx ON cloud_teams (organization_id, parent_team_id) WHERE parent_team_id IS NOT NULL;
