CREATE TABLE cloud_roles (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  scope text NOT NULL CHECK (scope IN ('organization', 'assigned')),
  permissions text[] NOT NULL,
  builtin boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, key),
  UNIQUE (organization_id, name)
);

CREATE FUNCTION cloud_seed_roles(organization uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO cloud_roles (organization_id, key, name, scope, permissions, builtin) VALUES
    (organization, 'owner', 'Owner', 'organization', ARRAY['issues.edit','comments.write','planning.edit','members.view','ai.chat','ai.tasks','automations.edit','git.view','git.act','releases.view','releases.edit','apps.connect','teams.view_all','teams.manage','members.manage','roles.manage','settings.manage','ai.manage','git.manage','releases.manage','clients.manage','activity.view_all'], true),
    (organization, 'admin', 'Administrator', 'organization', ARRAY['issues.edit','comments.write','planning.edit','members.view','ai.chat','ai.tasks','automations.edit','git.view','git.act','releases.view','releases.edit','apps.connect','teams.view_all','teams.manage','members.manage','roles.manage','settings.manage','ai.manage','git.manage','releases.manage','clients.manage','activity.view_all'], true),
    (organization, 'member', 'Member', 'organization', ARRAY['issues.edit','comments.write','planning.edit','members.view','ai.chat','ai.tasks','automations.edit','git.view','git.act','releases.view','releases.edit','apps.connect'], true),
    (organization, 'viewer', 'Viewer', 'organization', ARRAY['members.view','git.view','releases.view','apps.connect'], true),
    (organization, 'guest', 'Guest', 'assigned', ARRAY['issues.edit','comments.write'], true)
  ON CONFLICT DO NOTHING;
$$;

CREATE FUNCTION cloud_seed_organization_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cloud_seed_roles(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_organization_roles AFTER INSERT ON cloud_organizations
  FOR EACH ROW EXECUTE FUNCTION cloud_seed_organization_roles();

SELECT cloud_seed_roles(id) FROM cloud_organizations;

ALTER TABLE cloud_memberships DROP CONSTRAINT cloud_memberships_role_check;
ALTER TABLE cloud_memberships ADD FOREIGN KEY (organization_id, role) REFERENCES cloud_roles(organization_id, key);
ALTER TABLE cloud_invitations DROP CONSTRAINT cloud_invitations_role_check;
ALTER TABLE cloud_invitations ADD CHECK (role <> 'owner');
ALTER TABLE cloud_invitations ADD FOREIGN KEY (organization_id, role) REFERENCES cloud_roles(organization_id, key) ON DELETE CASCADE;
ALTER TABLE cloud_invitations ADD COLUMN team_ids uuid[] NOT NULL DEFAULT '{}';

CREATE FUNCTION cloud_member_can(organization uuid, member uuid, permission text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_memberships m JOIN cloud_roles r ON r.organization_id = m.organization_id AND r.key = m.role
    WHERE m.organization_id = organization AND m.user_id = member AND m.active
      AND (r.key = 'owner' OR permission = ANY(r.permissions))
  );
$$;

CREATE FUNCTION cloud_team_visible(organization uuid, team uuid, visibility text, member uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM cloud_team_memberships tm
    WHERE tm.organization_id = organization AND tm.team_id = team AND tm.user_id = member
  ) OR EXISTS (
    SELECT 1 FROM cloud_memberships m JOIN cloud_roles r ON r.organization_id = m.organization_id AND r.key = m.role
    WHERE m.organization_id = organization AND m.user_id = member AND r.scope = 'organization'
      AND (visibility = 'organization' OR r.key = 'owner' OR 'teams.view_all' = ANY(r.permissions))
  );
$$;

CREATE FUNCTION cloud_role_grants(organization uuid, granter text, granted text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT granter = 'owner' OR (
    granted <> 'owner' AND EXISTS (
      SELECT 1 FROM cloud_roles g JOIN cloud_roles t ON t.organization_id = g.organization_id
      WHERE g.organization_id = organization AND g.key = granter AND t.key = granted
        AND 'members.manage' = ANY(g.permissions) AND t.permissions <@ g.permissions
        AND NOT t.permissions && ARRAY['members.manage','roles.manage']
        AND (t.scope = 'assigned' OR g.scope = 'organization')
    )
  );
$$;

CREATE OR REPLACE FUNCTION cloud_invitation_pending(invitation cloud_invitations) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL AND invitation.expires_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id
      WHERE u.id=invitation.invited_by AND m.organization_id=invitation.organization_id AND NOT u.disabled AND m.active
      AND GREATEST(u.authentication_epoch,m.authentication_epoch)<=invitation.generation
      AND cloud_role_grants(invitation.organization_id, m.role, invitation.role)
      AND NOT EXISTS(SELECT 1 FROM cloud_memberships target WHERE target.organization_id=invitation.organization_id AND target.user_id=invitation.target_user_id
        AND NOT cloud_role_grants(invitation.organization_id, m.role, target.role)))
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
