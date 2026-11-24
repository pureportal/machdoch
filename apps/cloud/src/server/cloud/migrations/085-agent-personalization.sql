CREATE TABLE cloud_agent_mcp_connectors (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  url text NOT NULL CHECK (length(url) BETWEEN 9 AND 500),
  token bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, user_id, name),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_agent_allowed_repositories (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  PRIMARY KEY (organization_id, user_id, repository_id),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, repository_id) REFERENCES cloud_git_repositories(organization_id, id) ON DELETE CASCADE
);
