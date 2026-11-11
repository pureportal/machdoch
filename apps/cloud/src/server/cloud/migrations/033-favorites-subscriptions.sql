CREATE TABLE cloud_favorites (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('issue','project','cycle')),
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id,kind,entity_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_favorites_owner ON cloud_favorites(organization_id,user_id,created_at);
CREATE TABLE cloud_issue_subscriptions (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  user_id uuid NOT NULL,
  subscribed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,issue_id,user_id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
ALTER TABLE cloud_notifications DROP CONSTRAINT cloud_notifications_kind_check;
ALTER TABLE cloud_notifications ADD CONSTRAINT cloud_notifications_kind_check CHECK (kind IN ('assigned','commented','mentioned','task_finished','status_changed'));
