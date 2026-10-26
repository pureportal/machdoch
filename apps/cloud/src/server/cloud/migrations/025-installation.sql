ALTER TABLE cloud_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE cloud_users ADD COLUMN login_name text;
ALTER TABLE cloud_users ADD CONSTRAINT cloud_user_login_required CHECK (num_nonnulls(email,login_name)=1);
CREATE UNIQUE INDEX cloud_user_login ON cloud_users (lower(coalesce(login_name,email)));
CREATE TABLE cloud_installation (
  id integer PRIMARY KEY CHECK (id=1),
  organization_id uuid REFERENCES cloud_organizations(id),
  origin text,
  credentials_key text NOT NULL
);
