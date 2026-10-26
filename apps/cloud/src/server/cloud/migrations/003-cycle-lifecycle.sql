ALTER TABLE cloud_cycles ADD COLUMN status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','closed'));
ALTER TABLE cloud_cycles ADD COLUMN started_at timestamptz;
ALTER TABLE cloud_cycles ADD COLUMN closed_at timestamptz;
ALTER TABLE cloud_cycles ADD COLUMN closing_snapshot jsonb;
ALTER TABLE cloud_cycles ADD COLUMN carried_issue_ids jsonb NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX cloud_cycles_active_team ON cloud_cycles(organization_id,team_id) WHERE status='active';
CREATE TABLE cloud_cycle_commitments (
  organization_id uuid NOT NULL,
  cycle_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (organization_id,cycle_id,issue_id),
  FOREIGN KEY (organization_id,cycle_id) REFERENCES cloud_cycles(organization_id,id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id)
);
ALTER TABLE cloud_poker_rounds ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
