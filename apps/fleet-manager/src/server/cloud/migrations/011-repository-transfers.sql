CREATE TABLE cloud_repository_transfers (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch>0),
  state text NOT NULL CHECK (state IN ('pending','complete','failed')),
  charged_bytes integer NOT NULL CHECK (charged_bytes>=0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,run_id,attempt_id) REFERENCES cloud_run_attempts(organization_id,run_id,id)
);
CREATE INDEX cloud_repository_transfer_run ON cloud_repository_transfers(organization_id,run_id);
