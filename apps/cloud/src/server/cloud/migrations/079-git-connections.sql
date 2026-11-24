ALTER TABLE cloud_git_connections ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE cloud_git_connections ALTER COLUMN id DROP DEFAULT;
ALTER TABLE cloud_git_connections ADD COLUMN code_access boolean NOT NULL DEFAULT true;

ALTER TABLE cloud_git_repositories ADD COLUMN connection_id uuid;
UPDATE cloud_git_repositories r SET connection_id = c.id
FROM cloud_git_connections c WHERE c.organization_id = r.organization_id AND c.provider = r.provider;
ALTER TABLE cloud_git_repositories ALTER COLUMN connection_id SET NOT NULL;

ALTER TABLE cloud_git_deliveries ADD COLUMN connection_id uuid;
UPDATE cloud_git_deliveries d SET connection_id = c.id
FROM cloud_git_connections c WHERE c.organization_id = d.organization_id AND c.provider = d.provider;
ALTER TABLE cloud_git_deliveries ALTER COLUMN connection_id SET NOT NULL;

ALTER TABLE cloud_git_oauth_states ADD COLUMN connection_id uuid;
UPDATE cloud_git_oauth_states s SET connection_id = c.id
FROM cloud_git_connections c WHERE c.organization_id = s.organization_id AND c.provider = s.provider;
ALTER TABLE cloud_git_oauth_states ALTER COLUMN connection_id SET NOT NULL;

ALTER TABLE cloud_git_accounts ADD COLUMN oauth_connection_id uuid;
UPDATE cloud_git_accounts a SET oauth_connection_id = c.id
FROM cloud_git_connections c
WHERE a.refresh_secret IS NOT NULL AND c.organization_id = a.organization_id
  AND c.provider = a.provider AND c.api_url = a.api_url AND c.oauth_client_id IS NOT NULL;

ALTER TABLE cloud_git_repositories DROP CONSTRAINT cloud_git_repositories_organization_id_provider_fkey;
ALTER TABLE cloud_git_deliveries DROP CONSTRAINT cloud_git_deliveries_organization_id_provider_fkey;
ALTER TABLE cloud_git_oauth_states DROP CONSTRAINT cloud_git_oauth_states_organization_id_provider_fkey;
ALTER TABLE cloud_git_connections DROP CONSTRAINT cloud_git_connections_pkey;
ALTER TABLE cloud_git_connections ADD PRIMARY KEY (organization_id, id);
CREATE UNIQUE INDEX cloud_git_connections_account ON cloud_git_connections(organization_id, provider, api_url, lower(account));

ALTER TABLE cloud_git_repositories ADD FOREIGN KEY (organization_id, connection_id)
  REFERENCES cloud_git_connections(organization_id, id) ON DELETE CASCADE;
CREATE INDEX cloud_git_repositories_connection ON cloud_git_repositories(organization_id, connection_id);
ALTER TABLE cloud_git_deliveries ADD FOREIGN KEY (organization_id, connection_id)
  REFERENCES cloud_git_connections(organization_id, id) ON DELETE CASCADE;
ALTER TABLE cloud_git_oauth_states ADD FOREIGN KEY (organization_id, connection_id)
  REFERENCES cloud_git_connections(organization_id, id) ON DELETE CASCADE;
ALTER TABLE cloud_git_accounts ADD FOREIGN KEY (organization_id, oauth_connection_id)
  REFERENCES cloud_git_connections(organization_id, id) ON DELETE SET NULL (oauth_connection_id);
