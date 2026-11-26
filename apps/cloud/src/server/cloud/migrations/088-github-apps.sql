ALTER TABLE cloud_git_connections ADD COLUMN app_id bigint;
ALTER TABLE cloud_git_connections ADD COLUMN app_slug text CHECK (length(app_slug) BETWEEN 1 AND 100);
ALTER TABLE cloud_git_connections ADD COLUMN app_installation_id bigint;
ALTER TABLE cloud_git_connections ADD COLUMN app_key bytea;
ALTER TABLE cloud_git_connections ADD COLUMN token_refresh_at timestamptz;
ALTER TABLE cloud_git_connections ADD CONSTRAINT cloud_git_connections_app CHECK (
  (app_id IS NULL) = (app_slug IS NULL)
  AND (app_id IS NULL) = (app_installation_id IS NULL)
  AND (app_id IS NULL) = (app_key IS NULL)
  AND (app_id IS NULL) = (token_refresh_at IS NULL)
  AND (app_id IS NULL OR provider = 'github')
);
CREATE INDEX cloud_git_connections_app_tokens ON cloud_git_connections(token_refresh_at) WHERE app_id IS NOT NULL;

CREATE TABLE cloud_git_app_setups (
  state_hash text PRIMARY KEY CHECK (length(state_hash) = 64),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  api_url text NOT NULL CHECK (length(api_url) <= 300),
  owner text CHECK (length(owner) BETWEEN 1 AND 39),
  webhook_id uuid NOT NULL,
  app_id bigint,
  app_slug text CHECK (length(app_slug) BETWEEN 1 AND 100),
  client_id text CHECK (length(client_id) BETWEEN 1 AND 200),
  client_secret bytea,
  webhook_secret bytea,
  app_key bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (app_id IS NULL) = (app_slug IS NULL)
    AND (app_id IS NULL) = (client_id IS NULL)
    AND (app_id IS NULL) = (client_secret IS NULL)
    AND (app_id IS NULL) = (webhook_secret IS NULL)
    AND (app_id IS NULL) = (app_key IS NULL)
  ),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_git_app_setups_created ON cloud_git_app_setups(created_at);

ALTER TABLE cloud_run_deliveries ADD COLUMN merge_requested_by uuid;

UPDATE cloud_automations SET actions = (
  SELECT jsonb_agg(action - 'identity' ORDER BY position)
  FROM jsonb_array_elements(actions) WITH ORDINALITY AS entry(action, position)
) WHERE jsonb_path_exists(actions, '$[*].identity');
