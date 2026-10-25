ALTER TABLE cloud_invitations ADD COLUMN generation bigint NOT NULL DEFAULT nextval('cloud_authentication_generation');
ALTER TABLE cloud_invitations ADD COLUMN authentication text NOT NULL DEFAULT 'password' CHECK (authentication IN ('password','oidc'));
ALTER TABLE cloud_invitations ALTER COLUMN authentication DROP DEFAULT;
ALTER TABLE cloud_invitations ADD COLUMN provider_id uuid;
ALTER TABLE cloud_invitations ADD COLUMN provider_revision integer;
ALTER TABLE cloud_invitations ADD COLUMN subject text;
ALTER TABLE cloud_invitations ADD COLUMN policy_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE cloud_invitations ADD COLUMN target_user_id uuid REFERENCES cloud_users(id);
ALTER TABLE cloud_invitations ADD COLUMN target_membership_epoch bigint;
ALTER TABLE cloud_invitations ADD COLUMN accepted_by uuid REFERENCES cloud_users(id);
ALTER TABLE cloud_invitations ADD CONSTRAINT cloud_invitation_provider FOREIGN KEY (organization_id,provider_id) REFERENCES cloud_sso_providers(organization_id,id);
ALTER TABLE cloud_invitations ADD CONSTRAINT cloud_invitation_provider_binding CHECK ((authentication='oidc')=(provider_id IS NOT NULL AND provider_revision IS NOT NULL AND subject IS NOT NULL));
UPDATE cloud_invitations i SET target_user_id=(SELECT u.id FROM cloud_users u WHERE u.email=i.email),target_membership_epoch=(SELECT m.authentication_epoch FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id WHERE u.email=i.email AND m.organization_id=i.organization_id);
UPDATE cloud_invitations i SET policy_epoch=p.authentication_epoch FROM cloud_signin_policies p WHERE p.organization_id=i.organization_id;
CREATE TABLE cloud_invitation_confirmations (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES cloud_invitations(id) ON DELETE CASCADE,
  browser_hash text NOT NULL,
  oidc_flow_id uuid,
  receipt bytea,
  session_hash text,
  confirmed_session_id uuid,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((receipt IS NULL)=(session_hash IS NULL)),
  CHECK ((receipt IS NULL)=(completed_at IS NULL))
);
CREATE INDEX cloud_invitation_confirmations_browser ON cloud_invitation_confirmations(browser_hash);
CREATE INDEX cloud_invitation_confirmations_invitation ON cloud_invitation_confirmations(invitation_id);
CREATE INDEX cloud_invitation_confirmations_expiry ON cloud_invitation_confirmations(expires_at);
ALTER TABLE cloud_sso_flows DROP CONSTRAINT cloud_sso_flows_mode_check;
ALTER TABLE cloud_sso_flows ADD CONSTRAINT cloud_sso_flows_mode_check CHECK (mode IN ('login','link','invitation'));
ALTER TABLE cloud_sso_flows ADD COLUMN invitation_confirmation_id uuid REFERENCES cloud_invitation_confirmations(id) ON DELETE CASCADE;
ALTER TABLE cloud_sso_flows ADD CONSTRAINT cloud_sso_invitation_binding CHECK ((mode='invitation')=(invitation_confirmation_id IS NOT NULL));
CREATE FUNCTION cloud_invitation_pending(invitation cloud_invitations) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL AND invitation.expires_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id
      WHERE u.id=invitation.invited_by AND m.organization_id=invitation.organization_id AND NOT u.disabled AND m.active AND m.role IN ('admin','owner')
      AND GREATEST(u.authentication_epoch,m.authentication_epoch)<=invitation.generation
      AND (invitation.role<>'admin' OR m.role='owner')
      AND (m.role='owner' OR NOT EXISTS(SELECT 1 FROM cloud_memberships target WHERE target.organization_id=invitation.organization_id AND target.user_id=invitation.target_user_id AND target.role IN ('owner','admin'))))
    AND COALESCE((SELECT p.authentication_epoch=invitation.policy_epoch AND (NOT p.required_sso OR invitation.authentication='oidc') FROM cloud_signin_policies p WHERE p.organization_id=invitation.organization_id),invitation.policy_epoch=0)
    AND CASE WHEN invitation.target_user_id IS NULL THEN NOT EXISTS(SELECT 1 FROM cloud_users WHERE email=invitation.email)
      ELSE EXISTS(SELECT 1 FROM cloud_users u WHERE u.id=invitation.target_user_id AND u.email=invitation.email AND NOT u.disabled AND u.authentication_epoch<=invitation.generation AND (invitation.authentication='oidc' OR u.password_hash IS NOT NULL)) END
    AND CASE WHEN invitation.target_membership_epoch IS NULL THEN NOT EXISTS(SELECT 1 FROM cloud_memberships m WHERE m.organization_id=invitation.organization_id AND m.user_id=invitation.target_user_id)
      ELSE EXISTS(SELECT 1 FROM cloud_memberships m WHERE m.organization_id=invitation.organization_id AND m.user_id=invitation.target_user_id AND NOT m.active AND m.authentication_epoch=invitation.target_membership_epoch) END
    AND CASE WHEN invitation.authentication='password' THEN true ELSE
      EXISTS(SELECT 1 FROM cloud_sso_providers p WHERE p.organization_id=invitation.organization_id AND p.id=invitation.provider_id AND p.enabled AND p.revision=invitation.provider_revision AND p.verified_revision=p.revision)
      AND NOT EXISTS(SELECT 1 FROM cloud_sso_mappings i WHERE i.organization_id=invitation.organization_id AND i.provider_id=invitation.provider_id
        AND (i.subject=invitation.subject OR i.user_id=invitation.target_user_id) AND (i.user_id IS DISTINCT FROM invitation.target_user_id OR i.subject IS DISTINCT FROM invitation.subject)) END;
$$;
