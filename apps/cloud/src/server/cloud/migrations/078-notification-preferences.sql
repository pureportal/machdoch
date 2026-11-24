ALTER TABLE cloud_notifications ADD COLUMN inbox boolean NOT NULL DEFAULT true;
DROP INDEX cloud_notifications_inbox;
CREATE INDEX cloud_notifications_inbox ON cloud_notifications(organization_id,user_id,created_at DESC,id) WHERE dismissed_at IS NULL AND inbox;
DROP INDEX cloud_notifications_unread;
CREATE INDEX cloud_notifications_unread ON cloud_notifications(organization_id,user_id) WHERE read_at IS NULL AND dismissed_at IS NULL AND inbox;

CREATE TABLE cloud_notification_preferences (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('assigned','commented','mentioned','task_finished','status_changed','pull_request','loop_input','loop_approval','loop_message','sla_breached','project_update_due','project_update_drafted')),
  channel text NOT NULL CHECK (channel IN ('in_app','email','chat','mobile')),
  enabled boolean NOT NULL,
  PRIMARY KEY (organization_id,user_id,kind,channel),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_notification_schedules (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  snoozed_until timestamptz,
  quiet_start smallint CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end smallint CHECK (quiet_end BETWEEN 0 AND 1439),
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 64),
  PRIMARY KEY (organization_id,user_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE,
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
  CHECK (quiet_start IS NULL OR quiet_start <> quiet_end)
);

CREATE TABLE cloud_notification_chat_targets (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  url bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_push_subscriptions (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  endpoint text NOT NULL CHECK (endpoint LIKE 'https://%' AND length(endpoint) <= 2000),
  p256dh text NOT NULL CHECK (length(p256dh) = 87),
  auth text NOT NULL CHECK (length(auth) = 22),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,endpoint),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_push_subscriptions_user ON cloud_push_subscriptions(organization_id,user_id);

CREATE TABLE cloud_push_keys (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  public_key text NOT NULL,
  private_key bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE cloud_notification_deliveries (
  organization_id uuid NOT NULL,
  notification_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','chat','mobile')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','skipped','failed')),
  reason text CHECK (reason IS NULL OR length(reason) <= 40),
  deliver_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,notification_id,channel),
  FOREIGN KEY (organization_id,notification_id) REFERENCES cloud_notifications(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_notification_deliveries_due ON cloud_notification_deliveries(deliver_after) WHERE state = 'queued';
CREATE INDEX cloud_notification_deliveries_leased ON cloud_notification_deliveries(lease_expires_at) WHERE state = 'sending';
