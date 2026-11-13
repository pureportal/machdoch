ALTER TABLE cloud_github_repositories DROP CONSTRAINT cloud_github_repositories_organization_id_fkey;
ALTER TABLE cloud_github_automations DROP CONSTRAINT cloud_github_automations_organization_id_fkey;
ALTER TABLE cloud_github_deliveries DROP CONSTRAINT cloud_github_deliveries_organization_id_fkey;

ALTER TABLE cloud_github_connections RENAME TO cloud_git_connections;
ALTER TABLE cloud_git_connections ADD COLUMN provider text NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'gitlab'));
ALTER TABLE cloud_git_connections ALTER COLUMN provider DROP DEFAULT;
ALTER TABLE cloud_git_connections DROP CONSTRAINT cloud_github_connections_pkey;
ALTER TABLE cloud_git_connections ADD PRIMARY KEY (organization_id, provider);

ALTER TABLE cloud_github_repositories RENAME TO cloud_git_repositories;
ALTER TABLE cloud_git_repositories ADD COLUMN provider text NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'gitlab'));
ALTER TABLE cloud_git_repositories ALTER COLUMN provider DROP DEFAULT;
ALTER TABLE cloud_git_repositories RENAME COLUMN github_id TO external_id;
ALTER TABLE cloud_git_repositories DROP CONSTRAINT cloud_github_repositories_organization_id_github_id_key;
ALTER TABLE cloud_git_repositories ADD UNIQUE (organization_id, provider, external_id);
ALTER TABLE cloud_git_repositories DROP CONSTRAINT cloud_github_repositories_full_name_check;
ALTER TABLE cloud_git_repositories ADD CHECK (length(full_name) BETWEEN 3 AND 255);
ALTER TABLE cloud_git_repositories ADD COLUMN web_url text CHECK (length(web_url) <= 500);
ALTER TABLE cloud_git_repositories ADD COLUMN hook_version integer NOT NULL DEFAULT 1 CHECK (hook_version > 0);
ALTER TABLE cloud_git_repositories ADD FOREIGN KEY (organization_id, provider) REFERENCES cloud_git_connections(organization_id, provider) ON DELETE CASCADE;
UPDATE cloud_git_repositories SET web_url = 'https://github.com/' || full_name
WHERE organization_id IN (SELECT organization_id FROM cloud_git_connections WHERE api_url = 'https://api.github.com');

ALTER TABLE cloud_github_pull_requests RENAME TO cloud_git_pull_requests;
ALTER INDEX cloud_github_pull_requests_stale RENAME TO cloud_git_pull_requests_stale;
CREATE INDEX cloud_git_pull_requests_branches ON cloud_git_pull_requests(organization_id, repository_id, head_ref);

ALTER TABLE cloud_github_pull_request_issues RENAME TO cloud_git_pull_request_issues;
ALTER INDEX cloud_github_pull_request_issues_issue RENAME TO cloud_git_pull_request_issues_issue;

ALTER TABLE cloud_github_automations RENAME TO cloud_git_status_rules;
ALTER TABLE cloud_git_status_rules ADD FOREIGN KEY (organization_id) REFERENCES cloud_organizations(id);

ALTER TABLE cloud_github_deliveries RENAME TO cloud_git_deliveries;
ALTER TABLE cloud_git_deliveries ADD COLUMN provider text NOT NULL DEFAULT 'github' CHECK (provider IN ('github', 'gitlab'));
ALTER TABLE cloud_git_deliveries ALTER COLUMN provider DROP DEFAULT;
ALTER TABLE cloud_git_deliveries DROP CONSTRAINT cloud_github_deliveries_pkey;
ALTER TABLE cloud_git_deliveries ADD PRIMARY KEY (provider, delivery_id);
ALTER TABLE cloud_git_deliveries ADD FOREIGN KEY (organization_id, provider) REFERENCES cloud_git_connections(organization_id, provider) ON DELETE CASCADE;
ALTER INDEX cloud_github_deliveries_received RENAME TO cloud_git_deliveries_received;

CREATE TABLE cloud_git_accounts (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab')),
  api_url text NOT NULL CHECK (length(api_url) <= 300),
  secret bytea NOT NULL,
  token_prefix text NOT NULL CHECK (length(token_prefix) <= 32),
  login text NOT NULL CHECK (length(login) BETWEEN 1 AND 100),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  last_error text CHECK (length(last_error) <= 500),
  PRIMARY KEY (organization_id, user_id, provider),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cloud_git_accounts_login ON cloud_git_accounts(organization_id, provider, api_url, lower(login));

ALTER TABLE cloud_automation_events ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE cloud_automation_events ALTER COLUMN issue_id DROP NOT NULL;
CREATE INDEX cloud_automations_organization_trigger ON cloud_automations(organization_id, trigger_kind) WHERE enabled;

ALTER TABLE cloud_git_connections ADD COLUMN oauth_client_id text CHECK (length(oauth_client_id) BETWEEN 1 AND 200);
ALTER TABLE cloud_git_connections ADD COLUMN oauth_secret bytea;
ALTER TABLE cloud_git_connections ADD CHECK ((oauth_client_id IS NULL) = (oauth_secret IS NULL));

ALTER TABLE cloud_git_accounts ADD COLUMN refresh_secret bytea;
ALTER TABLE cloud_git_accounts ADD COLUMN expires_at timestamptz;

CREATE TABLE cloud_git_oauth_states (
  state_hash text PRIMARY KEY CHECK (length(state_hash) = 64),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('github', 'gitlab')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, provider) REFERENCES cloud_git_connections(organization_id, provider) ON DELETE CASCADE
);
CREATE INDEX cloud_git_oauth_states_created ON cloud_git_oauth_states(created_at);
