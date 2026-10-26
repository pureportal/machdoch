ALTER TABLE cloud_schedules RENAME COLUMN allocated_tokens TO reserved_tokens;
ALTER TABLE cloud_schedules ADD COLUMN used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens>=0);
ALTER TABLE cloud_schedules ADD COLUMN archived boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_schedules ADD COLUMN waiting_run_id uuid;
ALTER TABLE cloud_schedules ADD COLUMN maintenance_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE cloud_schedules ADD FOREIGN KEY (organization_id,waiting_run_id) REFERENCES cloud_runs(organization_id,id);
ALTER TABLE cloud_schedules DROP CONSTRAINT cloud_issue_schedules_check;
ALTER TABLE cloud_schedules ADD CHECK (NOT enabled OR (NOT archived AND num_nonnulls(next_at,waiting_run_id)=1));
ALTER TABLE cloud_schedule_occurrences ADD COLUMN used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens>=0);
ALTER TABLE cloud_schedule_occurrences ADD COLUMN reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens>=0);
ALTER TABLE cloud_schedule_occurrences ADD COLUMN budget_dirty boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_schedule_occurrences ADD COLUMN completed_at timestamptz;
UPDATE cloud_schedule_occurrences o SET reserved_tokens=(r.manifest->'profile'->>'maxTokens')::bigint,budget_dirty=true FROM cloud_runs r WHERE r.organization_id=o.organization_id AND r.id=o.run_id;
CREATE INDEX cloud_schedule_budget_dirty ON cloud_schedule_occurrences(organization_id,schedule_id) WHERE budget_dirty;
CREATE INDEX cloud_schedule_waiting ON cloud_schedules(maintenance_at,id) WHERE waiting_run_id IS NOT NULL;
CREATE FUNCTION cloud_dirty_schedule_inference_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.actual_tokens IS NOT DISTINCT FROM OLD.actual_tokens AND NEW.request_started_at IS NOT DISTINCT FROM OLD.request_started_at AND NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NULL; END IF;
  IF NEW.run_id IS NOT NULL THEN
    UPDATE cloud_schedule_occurrences SET budget_dirty=true WHERE organization_id=NEW.organization_id AND run_id=NEW.run_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER cloud_schedule_inference_usage AFTER INSERT OR UPDATE OF actual_tokens,request_started_at,state ON cloud_inference_calls FOR EACH ROW EXECUTE FUNCTION cloud_dirty_schedule_inference_usage();
CREATE FUNCTION cloud_dirty_schedule_run_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NULL; END IF;
  UPDATE cloud_schedule_occurrences SET budget_dirty=true WHERE organization_id=NEW.organization_id AND run_id=NEW.id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER cloud_schedule_run_usage AFTER UPDATE OF state ON cloud_runs FOR EACH ROW EXECUTE FUNCTION cloud_dirty_schedule_run_usage();
