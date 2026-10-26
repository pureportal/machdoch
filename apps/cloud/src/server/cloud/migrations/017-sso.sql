ALTER TABLE cloud_users ALTER COLUMN password_hash DROP NOT NULL;
CREATE TABLE cloud_sso_providers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  configuration jsonb NOT NULL,
  secret bytea NOT NULL,
  enabled boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  verified_revision integer,
  authentication_epoch bigint NOT NULL DEFAULT nextval('cloud_authentication_generation'),
  UNIQUE (organization_id,id)
);
CREATE UNIQUE INDEX cloud_sso_provider_identity ON cloud_sso_providers(organization_id,(configuration->'metadata'->>'issuer'),(configuration->>'clientId'));
CREATE TABLE cloud_sso_mappings (
  organization_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL,
  PRIMARY KEY (organization_id,provider_id,subject),
  UNIQUE (organization_id,provider_id,user_id),
  FOREIGN KEY (organization_id,provider_id) REFERENCES cloud_sso_providers(organization_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE TABLE cloud_signin_policies (
  organization_id uuid PRIMARY KEY REFERENCES cloud_organizations(id),
  required_sso boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  authentication_epoch bigint NOT NULL DEFAULT nextval('cloud_authentication_generation')
);
ALTER TABLE cloud_sessions DROP CONSTRAINT cloud_sessions_authentication_method_check;
ALTER TABLE cloud_sessions ADD CONSTRAINT cloud_sessions_authentication_method_check CHECK (authentication_method IN ('password','magic_link','oidc'));
ALTER TABLE cloud_sessions ADD COLUMN policy_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE cloud_sessions ADD COLUMN provider_id uuid REFERENCES cloud_sso_providers(id);
ALTER TABLE cloud_sessions ADD COLUMN provider_epoch bigint;
ALTER TABLE cloud_sessions ADD CONSTRAINT cloud_sessions_provider_check CHECK ((authentication_method='oidc')=(provider_id IS NOT NULL AND provider_epoch IS NOT NULL));
ALTER TABLE cloud_oauth_grants ADD COLUMN authentication_method text NOT NULL DEFAULT 'password' CHECK (authentication_method IN ('password','magic_link','oidc'));
ALTER TABLE cloud_oauth_grants ADD COLUMN policy_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE cloud_oauth_grants ADD COLUMN provider_id uuid REFERENCES cloud_sso_providers(id);
ALTER TABLE cloud_oauth_grants ADD COLUMN provider_epoch bigint;
CREATE FUNCTION cloud_login_authority_valid(org uuid, method text, policy bigint, provider uuid, generation bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT authentication_epoch=policy AND (NOT required_sso OR method='oidc') FROM cloud_signin_policies WHERE organization_id=org),policy=0)
    AND CASE WHEN method='oidc' THEN EXISTS(SELECT 1 FROM cloud_sso_providers WHERE organization_id=org AND id=provider AND enabled AND authentication_epoch=generation)
    ELSE provider IS NULL AND generation IS NULL END;
$$;
CREATE FUNCTION cloud_email_signin_valid(org uuid, generation bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM cloud_signin_policies WHERE organization_id=org AND (required_sso OR authentication_epoch>generation));
$$;
CREATE TABLE cloud_sso_flows (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  provider_revision integer NOT NULL,
  policy_epoch bigint NOT NULL,
  generation bigint NOT NULL DEFAULT nextval('cloud_authentication_generation'),
  state_hash text NOT NULL UNIQUE,
  browser_hash text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('login','link')),
  user_id uuid,
  bound_session_hash text,
  authorization_id uuid,
  proof bytea,
  claims jsonb,
  resolved_user_id uuid,
  resolved_membership_epoch bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exchanging','verified','completed','failed')),
  exchange_id uuid,
  exchange_expires_at timestamptz,
  receipt bytea,
  session_hash text,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,provider_id) REFERENCES cloud_sso_providers(organization_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id),
  CHECK ((mode='link')=(user_id IS NOT NULL AND bound_session_hash IS NOT NULL)),
  CHECK ((receipt IS NULL)=(session_hash IS NULL))
);
CREATE INDEX cloud_sso_flows_expiry ON cloud_sso_flows(expires_at);
CREATE INDEX cloud_sso_flows_browser ON cloud_sso_flows(browser_hash);
CREATE TABLE cloud_operator_audit (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  action text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
