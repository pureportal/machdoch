ALTER TABLE cloud_inference_calls ALTER COLUMN turn_id DROP NOT NULL;
ALTER TABLE cloud_inference_calls ADD COLUMN run_id uuid;
ALTER TABLE cloud_inference_calls ADD COLUMN attempt_id uuid;
ALTER TABLE cloud_inference_calls ADD COLUMN run_epoch integer;
ALTER TABLE cloud_inference_calls ADD COLUMN request_digest text;
ALTER TABLE cloud_inference_calls ADD COLUMN tools jsonb NOT NULL DEFAULT '[]';
ALTER TABLE cloud_inference_calls ADD COLUMN response jsonb;
ALTER TABLE cloud_inference_calls ADD COLUMN error_code text;
ALTER TABLE cloud_inference_calls ADD CONSTRAINT cloud_inference_subject CHECK (
  (turn_id IS NOT NULL AND run_id IS NULL AND attempt_id IS NULL AND run_epoch IS NULL AND request_digest IS NULL)
  OR (turn_id IS NULL AND run_id IS NOT NULL AND attempt_id IS NOT NULL AND run_epoch IS NOT NULL AND run_epoch>0 AND request_digest IS NOT NULL)
);
ALTER TABLE cloud_inference_calls ADD CONSTRAINT cloud_inference_attempt FOREIGN KEY (organization_id,run_id,attempt_id) REFERENCES cloud_run_attempts(organization_id,run_id,id);
CREATE UNIQUE INDEX cloud_inference_task_slot ON cloud_inference_calls(organization_id,run_id) WHERE run_id IS NOT NULL AND state IN ('queued','running','cancel_requested');
CREATE INDEX cloud_inference_task_budget ON cloud_inference_calls(organization_id,run_id);
