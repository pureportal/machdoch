ALTER TABLE cloud_organizations
  ADD COLUMN pulse_instructions text CHECK (length(pulse_instructions) BETWEEN 1 AND 20000);
ALTER TABLE cloud_project_updates
  ADD COLUMN summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 300),
  ADD COLUMN generated boolean NOT NULL DEFAULT false;
CREATE TABLE cloud_pulse_jobs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  actor_id uuid NOT NULL,
  project_ids uuid[] NOT NULL CHECK (cardinality(project_ids) BETWEEN 1 AND 8),
  state text NOT NULL CHECK (state IN ('waiting','succeeded','failed')),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
  error text CHECK (length(error) <= 500),
  chat_id uuid,
  turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,actor_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,chat_id) REFERENCES cloud_chats(organization_id,id) ON DELETE SET NULL (chat_id)
);
CREATE INDEX cloud_pulse_jobs_waiting ON cloud_pulse_jobs(created_at,id) WHERE state='waiting';
CREATE INDEX cloud_pulse_jobs_recent ON cloud_pulse_jobs(organization_id,created_at DESC);
ALTER TABLE cloud_chats ADD COLUMN pulse_job_id uuid;
ALTER TABLE cloud_chats ADD FOREIGN KEY (organization_id,pulse_job_id) REFERENCES cloud_pulse_jobs(organization_id,id) ON DELETE SET NULL (pulse_job_id);
