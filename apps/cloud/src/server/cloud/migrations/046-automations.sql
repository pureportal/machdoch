CREATE TABLE cloud_automations (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  trigger_kind text NOT NULL,
  trigger jsonb NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL,
  daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 1000),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  webhook_hash text UNIQUE,
  next_run_at timestamptz,
  error text CHECK (length(error) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,owner_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_automations_trigger ON cloud_automations(organization_id,team_id,trigger_kind) WHERE enabled;
CREATE INDEX cloud_automations_due ON cloud_automations(next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

CREATE TABLE cloud_automation_events (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  team_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  actor_id uuid,
  event jsonb NOT NULL,
  depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  origin_automation_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_automation_events_pending ON cloud_automation_events(sequence);

CREATE TABLE cloud_automation_runs (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  automation_id uuid NOT NULL,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) <= 200),
  trigger text NOT NULL CHECK (length(trigger) <= 40),
  state text NOT NULL CHECK (state IN ('queued','running','waiting','succeeded','failed','skipped')),
  issue_id uuid,
  actor_id uuid,
  depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  chat_id uuid,
  turn_id uuid,
  agent_actor_id uuid,
  error text CHECK (length(error) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,automation_id,dedupe_key),
  FOREIGN KEY (organization_id,automation_id) REFERENCES cloud_automations(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE SET NULL (issue_id),
  FOREIGN KEY (organization_id,chat_id) REFERENCES cloud_chats(organization_id,id) ON DELETE SET NULL (chat_id)
);
CREATE INDEX cloud_automation_runs_active ON cloud_automation_runs(updated_at) WHERE state IN ('queued','running','waiting');
CREATE INDEX cloud_automation_runs_history ON cloud_automation_runs(organization_id,automation_id,created_at DESC,id);
CREATE INDEX cloud_automation_runs_issue ON cloud_automation_runs(organization_id,issue_id,created_at DESC) WHERE issue_id IS NOT NULL;

ALTER TABLE cloud_chats ADD COLUMN automation_id uuid;
ALTER TABLE cloud_chats ADD FOREIGN KEY (organization_id,automation_id) REFERENCES cloud_automations(organization_id,id) ON DELETE SET NULL (automation_id);
