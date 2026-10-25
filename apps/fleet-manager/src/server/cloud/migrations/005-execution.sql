CREATE TABLE cloud_execution_profiles (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  team_id uuid NOT NULL,
  name text NOT NULL,
  definition jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,team_id,project_id) REFERENCES cloud_projects(organization_id,team_id,id),
  UNIQUE (organization_id,project_id,name)
);
CREATE TABLE cloud_execution_workers (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_revision integer NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,profile_id) REFERENCES cloud_execution_profiles(organization_id,id),
  UNIQUE (organization_id,profile_id,name)
);
CREATE TABLE cloud_runs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  project_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  issue_id uuid,
  actor_id uuid NOT NULL,
  title text NOT NULL,
  manifest jsonb NOT NULL,
  input_digest text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','preparing','running','waiting','validating','publishing','cancel_requested','reconciling','succeeded','failed','canceled','timed_out')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  epoch integer NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  attempt_id uuid,
  stop_reason text CHECK (stop_reason IN ('canceled','timed_out','failed')),
  summary text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,team_id,project_id) REFERENCES cloud_projects(organization_id,team_id,id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id),
  FOREIGN KEY (organization_id,profile_id) REFERENCES cloud_execution_profiles(organization_id,id),
  FOREIGN KEY (organization_id,actor_id) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE UNIQUE INDEX cloud_runs_issue_reservation ON cloud_runs(organization_id,issue_id) WHERE issue_id IS NOT NULL AND state NOT IN ('succeeded','failed','canceled','timed_out');
CREATE INDEX cloud_runs_dispatch ON cloud_runs(organization_id,profile_id,created_at,id) WHERE state='queued';
CREATE INDEX cloud_runs_deadline ON cloud_runs(organization_id,deadline_at) WHERE state NOT IN ('succeeded','failed','canceled','timed_out');
CREATE TABLE cloud_run_attempts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch > 0),
  state text NOT NULL CHECK (state IN ('preparing','running','stopping','suspect','stopped')),
  lease_expires_at timestamptz NOT NULL,
  finish_digest text,
  environment_id uuid,
  accept_digest text,
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,run_id,epoch),
  UNIQUE (organization_id,worker_id,claim_id),
  UNIQUE (organization_id,worker_id,environment_id),
  UNIQUE (organization_id,run_id,id),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id),
  FOREIGN KEY (organization_id,worker_id) REFERENCES cloud_execution_workers(organization_id,id)
);
CREATE UNIQUE INDEX cloud_run_attempts_worker_slot ON cloud_run_attempts(organization_id,worker_id) WHERE state<>'stopped';
ALTER TABLE cloud_runs ADD CONSTRAINT cloud_runs_current_attempt FOREIGN KEY (organization_id,id,attempt_id) REFERENCES cloud_run_attempts(organization_id,run_id,id);
CREATE TABLE cloud_run_events (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,run_id,revision),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id)
);
CREATE TABLE cloud_run_effects (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  epoch integer NOT NULL,
  resource text NOT NULL,
  request_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','unknown','succeeded','failed')),
  receipt jsonb,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,run_id,attempt_id) REFERENCES cloud_run_attempts(organization_id,run_id,id)
);
CREATE UNIQUE INDEX cloud_run_effects_resource ON cloud_run_effects(organization_id,resource) WHERE state IN ('pending','unknown');
