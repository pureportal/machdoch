ALTER TABLE cloud_git_repositories ADD COLUMN issue_sync boolean NOT NULL DEFAULT false;

CREATE TABLE cloud_git_synced_issues (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  url text NOT NULL CHECK (length(url) <= 500),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  body text NOT NULL CHECK (length(body) <= 30000),
  state text NOT NULL CHECK (state IN ('open', 'completed', 'not_planned')),
  assignee text CHECK (length(assignee) BETWEEN 1 AND 100),
  assignee_id uuid REFERENCES cloud_users(id),
  issue_revision integer NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempted_at timestamptz,
  last_error text CHECK (length(last_error) <= 500),
  PRIMARY KEY (organization_id, issue_id),
  UNIQUE (organization_id, repository_id, number),
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_issues(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, repository_id) REFERENCES cloud_git_repositories(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE cloud_git_synced_issue_labels (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = lower(name)),
  PRIMARY KEY (organization_id, issue_id, name),
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_git_synced_issues(organization_id, issue_id) ON DELETE CASCADE
);

CREATE TABLE cloud_git_synced_comments (
  organization_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 40),
  PRIMARY KEY (organization_id, comment_id),
  UNIQUE (organization_id, issue_id, external_id),
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_git_synced_issues(organization_id, issue_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, comment_id) REFERENCES cloud_comments(organization_id, id) ON DELETE CASCADE
);
