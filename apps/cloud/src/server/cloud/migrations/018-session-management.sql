ALTER TABLE cloud_sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE cloud_sessions ADD COLUMN browser text CHECK (length(browser)<=40);
ALTER TABLE cloud_sessions ADD COLUMN platform text CHECK (length(platform)<=40);
ALTER TABLE cloud_sessions ADD COLUMN address text CHECK (length(address)<=64);
CREATE INDEX cloud_sessions_account ON cloud_sessions(organization_id,user_id,created_at DESC);
CREATE FUNCTION cloud_session_active(session cloud_sessions) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT session.expires_at>clock_timestamp() AND session.touched_at>clock_timestamp()-interval '30 minutes'
    AND EXISTS(SELECT 1 FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id
      WHERE u.id=session.user_id AND m.organization_id=session.organization_id AND NOT u.disabled AND m.active
      AND session.authentication_epoch=u.authentication_epoch AND session.membership_epoch=m.authentication_epoch)
    AND cloud_login_authority_valid(session.organization_id,session.authentication_method,session.policy_epoch,session.provider_id,session.provider_epoch);
$$;
