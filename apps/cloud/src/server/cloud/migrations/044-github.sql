CREATE TABLE cloud_github_connections (
  organization_id uuid PRIMARY KEY REFERENCES cloud_organizations(id),
  api_url text NOT NULL CHECK (length(api_url) <= 300),
  secret bytea NOT NULL,
  token_prefix text NOT NULL CHECK (length(token_prefix) <= 32),
  account text NOT NULL CHECK (length(account) BETWEEN 1 AND 100),
  webhook_id uuid NOT NULL UNIQUE,
  webhook_secret bytea NOT NULL,
  actor_id uuid NOT NULL REFERENCES cloud_users(id),
  automate boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  synced_at timestamptz,
  sync_requested_at timestamptz,
  last_error text CHECK (length(last_error) <= 500)
);

CREATE TABLE cloud_github_repositories (
  organization_id uuid NOT NULL REFERENCES cloud_github_connections(organization_id) ON DELETE CASCADE,
  id uuid NOT NULL,
  github_id bigint NOT NULL,
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 3 AND 201),
  default_branch text NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
  private boolean NOT NULL,
  hook_id bigint,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, github_id)
);

CREATE TABLE cloud_github_pull_requests (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  repository_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  title text NOT NULL CHECK (length(title) <= 1000),
  url text NOT NULL CHECK (length(url) <= 500),
  state text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  draft boolean NOT NULL,
  author text CHECK (length(author) <= 100),
  head_ref text NOT NULL CHECK (length(head_ref) BETWEEN 1 AND 255),
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  base_ref text NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  mergeable_state text CHECK (length(mergeable_state) <= 40),
  additions integer NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions integer NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  changed_files integer NOT NULL DEFAULT 0 CHECK (changed_files >= 0),
  checks text CHECK (checks IN ('success', 'failure', 'pending', 'none')),
  review text CHECK (review IN ('approved', 'changes_requested', 'none')),
  stage text NOT NULL CHECK (stage IN ('attention', 'ready', 'review', 'draft', 'merged', 'closed')),
  merged_at timestamptz,
  updated_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signals_synced_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, repository_id, number),
  FOREIGN KEY (organization_id, repository_id) REFERENCES cloud_github_repositories(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX cloud_github_pull_requests_stale ON cloud_github_pull_requests(signals_synced_at NULLS FIRST) WHERE state = 'open';

CREATE TABLE cloud_github_pull_request_issues (
  organization_id uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  closes boolean NOT NULL,
  PRIMARY KEY (organization_id, pull_request_id, issue_id),
  FOREIGN KEY (organization_id, pull_request_id) REFERENCES cloud_github_pull_requests(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_issues(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX cloud_github_pull_request_issues_issue ON cloud_github_pull_request_issues(organization_id, issue_id);

CREATE TABLE cloud_github_automations (
  organization_id uuid NOT NULL REFERENCES cloud_github_connections(organization_id) ON DELETE CASCADE,
  team_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('draft', 'open', 'approved', 'merged')),
  status_id uuid,
  PRIMARY KEY (organization_id, team_id, event),
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, team_id, status_id) REFERENCES cloud_workflow_statuses(organization_id, team_id, id) ON DELETE CASCADE
);

CREATE TABLE cloud_github_deliveries (
  delivery_id text PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 100),
  organization_id uuid NOT NULL REFERENCES cloud_github_connections(organization_id) ON DELETE CASCADE,
  event text NOT NULL CHECK (length(event) <= 60),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX cloud_github_deliveries_received ON cloud_github_deliveries(received_at);
