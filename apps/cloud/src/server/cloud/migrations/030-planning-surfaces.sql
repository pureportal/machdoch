CREATE INDEX cloud_issues_recent ON cloud_issues(organization_id,archived,updated_at DESC,id);
CREATE INDEX cloud_issues_project ON cloud_issues(organization_id,project_id) WHERE project_id IS NOT NULL;
CREATE INDEX cloud_issues_cycle ON cloud_issues(organization_id,cycle_id) WHERE cycle_id IS NOT NULL;
CREATE INDEX cloud_issues_assignee ON cloud_issues(organization_id,assignee_id,updated_at DESC) WHERE assignee_id IS NOT NULL;
CREATE INDEX cloud_runs_issue_recent ON cloud_runs(organization_id,issue_id,created_at DESC) WHERE issue_id IS NOT NULL;
CREATE INDEX cloud_runs_recent ON cloud_runs(organization_id,created_at DESC,id);
CREATE INDEX cloud_issue_history_cycle ON cloud_issue_history(organization_id,(snapshot->>'cycleId')) WHERE snapshot->>'cycleId' IS NOT NULL;

ALTER TABLE cloud_ai_providers DROP CONSTRAINT cloud_ai_providers_provider_check;
ALTER TABLE cloud_ai_providers ADD CONSTRAINT cloud_ai_providers_provider_check CHECK (provider IN ('openai','anthropic','google','langdock','claude-code-cli','codex-cli'));

CREATE TABLE cloud_run_activity (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
  status text NOT NULL CHECK (status IN ('info','started','passed','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id)
);
CREATE INDEX cloud_run_activity_run ON cloud_run_activity(organization_id,run_id,created_at);

CREATE TABLE cloud_notifications (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  team_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assigned','commented','mentioned','task_finished')),
  issue_id uuid,
  run_id uuid,
  actor_id uuid REFERENCES cloud_users(id),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 240),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  dismissed_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id),
  CHECK (issue_id IS NOT NULL OR run_id IS NOT NULL)
);
CREATE INDEX cloud_notifications_inbox ON cloud_notifications(organization_id,user_id,created_at DESC,id) WHERE dismissed_at IS NULL;
CREATE INDEX cloud_notifications_unread ON cloud_notifications(organization_id,user_id) WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE UNIQUE INDEX cloud_notifications_run_once ON cloud_notifications(organization_id,user_id,run_id) WHERE kind='task_finished';

CREATE TABLE cloud_saved_views (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_saved_views_owner ON cloud_saved_views(organization_id,user_id);
CREATE INDEX cloud_saved_views_shared ON cloud_saved_views(organization_id) WHERE shared;

CREATE TABLE cloud_project_milestones (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  target_on date,
  completed_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,project_id) REFERENCES cloud_projects(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_project_milestones_project ON cloud_project_milestones(organization_id,project_id,target_on);
