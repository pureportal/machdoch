CREATE TABLE cloud_release_pipelines (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  repository_id uuid,
  type text NOT NULL CHECK (type IN ('continuous','scheduled')),
  source text NOT NULL CHECK (source IN ('deployment','workflow_run','tag','webhook')),
  webhook_hash text UNIQUE CHECK (length(webhook_hash) = 64),
  archived boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id,id),
  CHECK ((source = 'webhook') = (webhook_hash IS NOT NULL)),
  FOREIGN KEY (organization_id,repository_id) REFERENCES cloud_git_repositories(organization_id,id) ON DELETE SET NULL (repository_id),
  FOREIGN KEY (organization_id,created_by) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE INDEX cloud_release_pipelines_repository ON cloud_release_pipelines(organization_id,repository_id) WHERE NOT archived;

CREATE TABLE cloud_release_pipeline_teams (
  organization_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  team_id uuid NOT NULL,
  PRIMARY KEY (organization_id,pipeline_id,team_id),
  FOREIGN KEY (organization_id,pipeline_id) REFERENCES cloud_release_pipelines(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_release_pipeline_teams_team ON cloud_release_pipeline_teams(organization_id,team_id);

CREATE TABLE cloud_release_pipeline_paths (
  organization_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  pattern text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 300),
  PRIMARY KEY (organization_id,pipeline_id,pattern),
  FOREIGN KEY (organization_id,pipeline_id) REFERENCES cloud_release_pipelines(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_release_pipeline_environments (
  organization_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (organization_id,pipeline_id,name),
  UNIQUE (organization_id,pipeline_id,position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (organization_id,pipeline_id) REFERENCES cloud_release_pipelines(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_pipeline_releases (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  environment text NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  from_sha text CHECK (from_sha ~ '^[0-9a-f]{40}$'),
  to_sha text CHECK (to_sha ~ '^[0-9a-f]{40}$'),
  evidence_url text CHECK (length(evidence_url) <= 500),
  deployed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,pipeline_id,environment,external_id),
  FOREIGN KEY (organization_id,pipeline_id,environment) REFERENCES cloud_release_pipeline_environments(organization_id,pipeline_id,name) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX cloud_pipeline_releases_latest ON cloud_pipeline_releases(organization_id,pipeline_id,environment,deployed_at DESC);

CREATE TABLE cloud_pipeline_release_issues (
  organization_id uuid NOT NULL,
  release_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('automatic','manual')),
  excluded boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id,release_id,issue_id),
  FOREIGN KEY (organization_id,release_id) REFERENCES cloud_pipeline_releases(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_pipeline_release_issues_issue ON cloud_pipeline_release_issues(organization_id,issue_id) WHERE NOT excluded;

CREATE TABLE cloud_pipeline_release_pull_requests (
  organization_id uuid NOT NULL,
  release_id uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  PRIMARY KEY (organization_id,release_id,pull_request_id),
  FOREIGN KEY (organization_id,release_id) REFERENCES cloud_pipeline_releases(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,pull_request_id) REFERENCES cloud_git_pull_requests(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_pipeline_release_pull_requests_pull ON cloud_pipeline_release_pull_requests(organization_id,pull_request_id);

ALTER TABLE cloud_teams ADD COLUMN complete_issues_on_release boolean NOT NULL DEFAULT false;
