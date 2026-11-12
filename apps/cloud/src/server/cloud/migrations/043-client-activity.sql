ALTER TABLE cloud_ai_activity ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE cloud_ai_activity ADD COLUMN instance_id text CHECK (length(instance_id) <= 128);
ALTER TABLE cloud_ai_activity ADD COLUMN instance_name text CHECK (length(instance_name) <= 120);
ALTER TABLE cloud_ai_activity ADD CONSTRAINT cloud_ai_activity_source CHECK (actor_id IS NOT NULL OR (instance_id IS NOT NULL AND instance_name IS NOT NULL));
ALTER TABLE cloud_ai_activity DROP CONSTRAINT cloud_ai_activity_kind_check;
ALTER TABLE cloud_ai_activity ADD CONSTRAINT cloud_ai_activity_kind_check CHECK (kind IN ('agent','model','task','step','client'));
ALTER TABLE cloud_ai_activity DROP CONSTRAINT cloud_ai_activity_status_check;
ALTER TABLE cloud_ai_activity ADD CONSTRAINT cloud_ai_activity_status_check CHECK (status IN ('info','started','succeeded','failed','canceled','warning'));
CREATE INDEX cloud_ai_activity_instance ON cloud_ai_activity(organization_id,instance_id,sequence) WHERE instance_id IS NOT NULL;

CREATE TABLE cloud_client_observations (
  instance_id text PRIMARY KEY CHECK (length(instance_id) <= 128),
  online boolean NOT NULL,
  state jsonb CHECK (state IS NULL OR jsonb_typeof(state)='object'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
