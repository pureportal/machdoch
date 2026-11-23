ALTER TABLE cloud_automation_runs ADD COLUMN trigger_variables jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE cloud_automation_runs SET trigger_variables = variables;
