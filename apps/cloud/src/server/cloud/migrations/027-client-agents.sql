ALTER TABLE cloud_execution_profiles ALTER COLUMN provider_id DROP NOT NULL;
UPDATE cloud_execution_workers w SET enabled=false FROM cloud_execution_profiles p
WHERE p.organization_id=w.organization_id AND p.id=w.profile_id AND p.definition->>'target'='client';
UPDATE cloud_execution_profiles SET definition=(definition-'providerId'-'model')||'{"agent":"machdoch"}'::jsonb,enabled=false,revision=revision+1
WHERE definition->>'target'='client';
ALTER TABLE cloud_execution_profiles ADD CONSTRAINT cloud_execution_profile_agent CHECK ((definition->>'target'='client')=(provider_id IS NULL));
