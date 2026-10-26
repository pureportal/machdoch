CREATE TABLE cloud_oauth_requests (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  challenge text NOT NULL,
  state text NOT NULL,
  scopes text[] NOT NULL,
  organization_id uuid,
  user_id uuid,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  decided_at timestamptz,
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_oauth_requests_expiry ON cloud_oauth_requests(expires_at);
CREATE TABLE cloud_oauth_grants (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  revoked_at timestamptz,
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_oauth_grants_owner ON cloud_oauth_grants(organization_id,user_id);
CREATE TABLE cloud_oauth_codes (
  hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES cloud_oauth_grants(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes'),
  consumed_at timestamptz
);
CREATE TABLE cloud_oauth_tokens (
  hash text PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES cloud_oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access','refresh')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX cloud_oauth_tokens_grant ON cloud_oauth_tokens(grant_id);
