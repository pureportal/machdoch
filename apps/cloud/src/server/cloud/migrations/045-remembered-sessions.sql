ALTER TABLE cloud_sessions ADD COLUMN remember_hash text UNIQUE;
ALTER TABLE cloud_sessions ADD COLUMN remember_previous_hash text UNIQUE;
ALTER TABLE cloud_sessions ADD COLUMN remember_rotated_at timestamptz;
ALTER TABLE cloud_sessions ADD COLUMN remembered_until timestamptz;
ALTER TABLE cloud_sessions ADD CONSTRAINT cloud_sessions_remembered CHECK (
  (remember_hash IS NULL)=(remembered_until IS NULL)
  AND (remember_hash IS NULL OR second_factor_at IS NOT NULL)
  AND (remember_previous_hash IS NULL OR remember_rotated_at IS NOT NULL)
);
CREATE INDEX cloud_sessions_remembered ON cloud_sessions(remembered_until) WHERE remembered_until IS NOT NULL;
CREATE FUNCTION cloud_session_authorized(session cloud_sessions) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM cloud_users u JOIN cloud_memberships m ON m.user_id=u.id
      WHERE u.id=session.user_id AND m.organization_id=session.organization_id AND NOT u.disabled AND m.active
      AND session.authentication_epoch=u.authentication_epoch AND session.membership_epoch=m.authentication_epoch)
    AND cloud_login_authority_valid(session.organization_id,session.authentication_method,session.policy_epoch,session.provider_id,session.provider_epoch);
$$;
CREATE OR REPLACE FUNCTION cloud_session_valid(session cloud_sessions) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT session.expires_at>clock_timestamp() AND session.touched_at>clock_timestamp()-interval '30 minutes'
    AND cloud_session_authorized(session);
$$;
CREATE FUNCTION cloud_session_restorable(session cloud_sessions) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT session.remembered_until IS NOT NULL AND session.remembered_until>clock_timestamp()
    AND session.second_factor_at IS NOT NULL AND cloud_session_authorized(session);
$$;
