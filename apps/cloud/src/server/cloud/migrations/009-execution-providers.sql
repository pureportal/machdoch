ALTER TABLE cloud_execution_profiles ADD COLUMN provider_id uuid GENERATED ALWAYS AS ((definition->>'providerId')::uuid) STORED NOT NULL;
ALTER TABLE cloud_execution_profiles ADD CONSTRAINT cloud_execution_provider FOREIGN KEY (organization_id,provider_id) REFERENCES cloud_ai_providers(organization_id,id);
CREATE INDEX cloud_execution_profiles_provider ON cloud_execution_profiles(organization_id,provider_id);
ALTER TABLE cloud_runs ADD COLUMN stop_message text;
ALTER TABLE cloud_runs ADD CONSTRAINT cloud_run_stop_message CHECK ((stop_reason IS NULL)=(stop_message IS NULL));
