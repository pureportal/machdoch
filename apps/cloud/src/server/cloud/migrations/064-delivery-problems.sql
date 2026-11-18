ALTER TABLE cloud_run_deliveries ADD COLUMN problems integer CHECK (problems >= 0);
ALTER TABLE cloud_execution_profiles DROP COLUMN check_actor_id;
UPDATE cloud_execution_profiles SET definition=definition-'checkPullRequests';
