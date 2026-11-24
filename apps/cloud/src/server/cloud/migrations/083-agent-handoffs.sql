ALTER TABLE cloud_runs ADD COLUMN pinned_worker_id uuid;
ALTER TABLE cloud_runs ADD CONSTRAINT cloud_runs_pinned_worker_fkey
  FOREIGN KEY (organization_id,pinned_worker_id) REFERENCES cloud_execution_workers(organization_id,id);
CREATE TABLE cloud_agent_handoffs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  turn_id uuid NOT NULL,
  run_id uuid NOT NULL,
  placement text NOT NULL CHECK (placement IN ('sandbox','runner_pool','client')),
  harness text NOT NULL CHECK (harness IN ('machdoch','codex','claude','copilot')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,run_id),
  FOREIGN KEY (organization_id,turn_id) REFERENCES cloud_chat_turns(organization_id,id),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id)
);
CREATE INDEX cloud_agent_handoffs_turn ON cloud_agent_handoffs(organization_id,turn_id,created_at);
