CREATE TABLE cloud_git_settings (
  organization_id uuid PRIMARY KEY REFERENCES cloud_organizations(id) ON DELETE CASCADE,
  review_guides boolean NOT NULL,
  merge_issues boolean NOT NULL,
  commit_links boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);

ALTER TABLE cloud_git_repositories ADD COLUMN team_id uuid;
ALTER TABLE cloud_git_repositories ADD FOREIGN KEY (organization_id, team_id)
  REFERENCES cloud_teams(organization_id, id) ON DELETE SET NULL (team_id);

CREATE INDEX cloud_git_deliveries_connection ON cloud_git_deliveries(organization_id, connection_id, received_at);

ALTER TABLE cloud_git_pull_request_issues ADD COLUMN recorded boolean NOT NULL DEFAULT false;

CREATE TABLE cloud_git_commit_issues (
  organization_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  sha text NOT NULL CHECK (sha ~ '^[0-9a-f]{40}$'),
  issue_id uuid NOT NULL,
  closes boolean NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  message text NOT NULL CHECK (char_length(message) <= 2000),
  author text NOT NULL CHECK (char_length(author) <= 100),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, repository_id, sha, issue_id),
  FOREIGN KEY (organization_id, repository_id) REFERENCES cloud_git_repositories(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_issues(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX cloud_git_commit_issues_issue ON cloud_git_commit_issues(organization_id, issue_id);

CREATE TABLE cloud_git_issue_suggestions (
  organization_id uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  team_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, pull_request_id),
  FOREIGN KEY (organization_id, pull_request_id) REFERENCES cloud_git_pull_requests(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id) ON DELETE CASCADE
);
