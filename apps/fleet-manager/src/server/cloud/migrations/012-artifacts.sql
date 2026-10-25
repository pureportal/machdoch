CREATE TABLE cloud_run_artifacts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch>0),
  kind text NOT NULL CHECK (kind IN ('candidate','diff','verification','log')),
  name text NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 0 AND 67108864),
  received_bytes integer NOT NULL DEFAULT 0 CHECK (received_bytes>=0 AND received_bytes<=byte_length),
  sha256 text NOT NULL,
  input_digest text NOT NULL,
  candidate_commit text,
  metadata_digest text NOT NULL,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready','abandoned')),
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,run_id,attempt_id) REFERENCES cloud_run_attempts(organization_id,run_id,id),
  CHECK (state<>'ready' OR received_bytes=byte_length),
  CHECK ((kind='verification' AND state='ready')=(evidence IS NOT NULL))
);
CREATE UNIQUE INDEX cloud_candidate_artifact ON cloud_run_artifacts(organization_id,attempt_id,candidate_commit) WHERE kind='candidate' AND state<>'abandoned';
CREATE INDEX cloud_artifacts_run ON cloud_run_artifacts(organization_id,run_id,state);
CREATE TABLE cloud_artifact_chunks (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  offset_bytes integer NOT NULL CHECK (offset_bytes>=0 AND offset_bytes % 32768=0),
  sha256 text NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 32768),
  PRIMARY KEY (organization_id,artifact_id,offset_bytes),
  FOREIGN KEY (organization_id,artifact_id) REFERENCES cloud_run_artifacts(organization_id,id)
);
