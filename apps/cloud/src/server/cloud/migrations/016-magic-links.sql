ALTER TABLE cloud_ai_key_checks RENAME TO cloud_credential_key_checks;
CREATE SEQUENCE cloud_authentication_generation;
ALTER TABLE cloud_users ADD COLUMN authentication_epoch bigint NOT NULL DEFAULT nextval('cloud_authentication_generation');
ALTER TABLE cloud_memberships ADD COLUMN authentication_epoch bigint NOT NULL DEFAULT nextval('cloud_authentication_generation');
CREATE FUNCTION cloud_touch_user_authentication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email OR NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.disabled IS DISTINCT FROM OLD.disabled THEN
    NEW.authentication_epoch = nextval('cloud_authentication_generation');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_user_authentication_change BEFORE UPDATE ON cloud_users FOR EACH ROW EXECUTE FUNCTION cloud_touch_user_authentication();
CREATE FUNCTION cloud_touch_membership_authentication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.active IS DISTINCT FROM OLD.active OR NEW.revision IS DISTINCT FROM OLD.revision THEN
    NEW.authentication_epoch = nextval('cloud_authentication_generation');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_membership_authentication_change BEFORE UPDATE ON cloud_memberships FOR EACH ROW EXECUTE FUNCTION cloud_touch_membership_authentication();
ALTER TABLE cloud_sessions ADD COLUMN authentication_epoch bigint;
ALTER TABLE cloud_sessions ADD COLUMN membership_epoch bigint;
ALTER TABLE cloud_sessions ADD COLUMN authentication_method text NOT NULL DEFAULT 'password' CHECK (authentication_method IN ('password','magic_link'));
ALTER TABLE cloud_sessions ALTER COLUMN authentication_method DROP DEFAULT;
UPDATE cloud_sessions s SET authentication_epoch=u.authentication_epoch,membership_epoch=m.authentication_epoch FROM cloud_users u,cloud_memberships m WHERE u.id=s.user_id AND m.user_id=s.user_id AND m.organization_id=s.organization_id;
ALTER TABLE cloud_sessions ALTER COLUMN authentication_epoch SET NOT NULL;
ALTER TABLE cloud_sessions ALTER COLUMN membership_epoch SET NOT NULL;
CREATE INDEX cloud_sessions_user ON cloud_sessions (user_id,created_at DESC,token_hash);
CREATE INDEX cloud_sessions_idle ON cloud_sessions(touched_at);
ALTER TABLE cloud_oauth_grants ADD COLUMN authentication_epoch bigint;
ALTER TABLE cloud_oauth_grants ADD COLUMN membership_epoch bigint;
UPDATE cloud_oauth_grants g SET authentication_epoch=u.authentication_epoch,membership_epoch=m.authentication_epoch FROM cloud_users u,cloud_memberships m WHERE u.id=g.user_id AND m.user_id=g.user_id AND m.organization_id=g.organization_id;
ALTER TABLE cloud_oauth_grants ALTER COLUMN authentication_epoch SET NOT NULL;
ALTER TABLE cloud_oauth_grants ALTER COLUMN membership_epoch SET NOT NULL;
CREATE TABLE cloud_email_settings (
  organization_id uuid PRIMARY KEY REFERENCES cloud_organizations(id),
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  security text NOT NULL CHECK (security IN ('tls','starttls')),
  tls_name text,
  username text,
  secret bytea,
  from_address text NOT NULL,
  enabled boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  signin_epoch bigint NOT NULL DEFAULT nextval('cloud_authentication_generation'),
  CHECK ((username IS NULL)=(secret IS NULL))
);
CREATE FUNCTION cloud_touch_email_signin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    NEW.signin_epoch = nextval('cloud_authentication_generation');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_email_signin_change BEFORE UPDATE ON cloud_email_settings FOR EACH ROW EXECUTE FUNCTION cloud_touch_email_signin();
CREATE TABLE cloud_magic_links (
  id uuid PRIMARY KEY,
  organization_id uuid,
  user_id uuid,
  token_hash text NOT NULL UNIQUE,
  generation bigint NOT NULL DEFAULT nextval('cloud_authentication_generation'),
  authorization_id uuid,
  requested_organization_id uuid,
  payload bytea,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
  consumed_at timestamptz,
  delivery_state text NOT NULL DEFAULT 'queued' CHECK (delivery_state IN ('queued','sending','sent','failed','discarded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  delivery_lease uuid,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IN ('authentication','connection','timeout','recipient','failed')),
  delivery_settings_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE,
  CHECK ((organization_id IS NULL)=(user_id IS NULL)),
  CHECK ((delivery_state='sending')=(delivery_lease IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (delivery_state NOT IN ('queued','sending') OR payload IS NOT NULL)
);
CREATE INDEX cloud_magic_links_delivery ON cloud_magic_links (available_at,created_at) WHERE delivery_state IN ('queued','sending');
CREATE INDEX cloud_magic_links_user ON cloud_magic_links (organization_id,user_id,created_at);
CREATE INDEX cloud_magic_links_expiry ON cloud_magic_links(expires_at);
CREATE TABLE cloud_magic_confirmations (
  id uuid PRIMARY KEY,
  link_id uuid NOT NULL REFERENCES cloud_magic_links(id) ON DELETE CASCADE,
  nonce_hash text NOT NULL,
  receipt bytea,
  session_hash text,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((receipt IS NULL)=(session_hash IS NULL)),
  CHECK ((receipt IS NULL)=(consumed_at IS NULL))
);
CREATE INDEX cloud_magic_confirmations_link ON cloud_magic_confirmations(link_id,created_at);
CREATE INDEX cloud_magic_confirmations_expiry ON cloud_magic_confirmations(expires_at);
CREATE INDEX cloud_magic_confirmations_nonce ON cloud_magic_confirmations(nonce_hash);
