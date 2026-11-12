CREATE TABLE cloud_sidebar_preferences (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  preferences jsonb NOT NULL CHECK (jsonb_typeof(preferences) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);
