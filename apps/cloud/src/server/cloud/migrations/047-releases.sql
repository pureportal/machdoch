CREATE TABLE cloud_social_apps (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  network text NOT NULL CHECK (network IN ('linkedin','reddit')),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 200),
  secret bytea NOT NULL,
  organization_pages boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,network)
);

CREATE TABLE cloud_social_oauth_states (
  state_hash text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  user_id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('linkedin','reddit')),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_social_accounts (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  network text NOT NULL CHECK (network IN ('linkedin','reddit')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  secret bytea NOT NULL,
  expires_at timestamptz,
  connected_by uuid NOT NULL,
  error text CHECK (length(error) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,network,external_id),
  FOREIGN KEY (organization_id,connected_by) REFERENCES cloud_memberships(organization_id,user_id)
);

CREATE TABLE cloud_products (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  key text NOT NULL,
  definition jsonb NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,key)
);

CREATE TABLE cloud_product_channels (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('linkedin','reddit','webhook')),
  definition jsonb NOT NULL,
  account_id uuid,
  webhook_secret bytea,
  position integer NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,product_id) REFERENCES cloud_products(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,account_id) REFERENCES cloud_social_accounts(organization_id,id),
  CHECK ((kind='webhook') = (webhook_secret IS NOT NULL)),
  CHECK ((kind='webhook') = (account_id IS NULL))
);

CREATE TABLE cloud_releases (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 120),
  summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 1000),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 40000),
  highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
  since date,
  target_date date,
  archived boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,product_id,version),
  FOREIGN KEY (organization_id,product_id) REFERENCES cloud_products(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,created_by) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE INDEX cloud_releases_recent ON cloud_releases(organization_id,updated_at DESC,id) WHERE NOT archived;

CREATE TABLE cloud_release_items (
  organization_id uuid NOT NULL,
  release_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  included boolean NOT NULL DEFAULT true,
  PRIMARY KEY (organization_id,release_id,issue_id),
  FOREIGN KEY (organization_id,release_id) REFERENCES cloud_releases(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_release_media (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  product_id uuid NOT NULL,
  release_id uuid,
  kind text NOT NULL CHECK (kind IN ('image','video')),
  role text NOT NULL CHECK (role IN ('screenshot','recording','reference','visual','video','logo')),
  source text NOT NULL CHECK (source IN ('upload','template','composition','capture')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime text NOT NULL,
  byte_length integer NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  width integer,
  height integer,
  duration_ms integer,
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 300),
  alt_text text NOT NULL DEFAULT '' CHECK (length(alt_text) <= 1000),
  recipe jsonb,
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready')),
  share_token_hash text UNIQUE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,product_id) REFERENCES cloud_products(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,release_id) REFERENCES cloud_releases(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_release_media_release ON cloud_release_media(organization_id,release_id,created_at) WHERE state='ready';
CREATE INDEX cloud_release_media_abandoned ON cloud_release_media(created_at) WHERE state='uploading';

CREATE TABLE cloud_release_media_chunks (
  organization_id uuid NOT NULL,
  media_id uuid NOT NULL,
  offset_bytes integer NOT NULL CHECK (offset_bytes >= 0),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 262144),
  PRIMARY KEY (organization_id,media_id,offset_bytes),
  FOREIGN KEY (organization_id,media_id) REFERENCES cloud_release_media(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_release_posts (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  release_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','scheduled','publishing','published','failed')),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 300),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 40000),
  media_ids uuid[] NOT NULL DEFAULT '{}',
  link text CHECK (length(link) <= 2000),
  scheduled_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  published_at timestamptz,
  publisher_id uuid,
  error text CHECK (length(error) <= 500),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,release_id,channel_id),
  FOREIGN KEY (organization_id,release_id) REFERENCES cloud_releases(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,channel_id) REFERENCES cloud_product_channels(organization_id,id) ON DELETE CASCADE,
  CHECK ((state='scheduled') <= (scheduled_at IS NOT NULL))
);
CREATE INDEX cloud_release_posts_due ON cloud_release_posts(scheduled_at) WHERE state='scheduled';

CREATE TABLE cloud_release_deliveries (
  organization_id uuid NOT NULL,
  post_id uuid NOT NULL,
  target text NOT NULL CHECK (length(target) BETWEEN 1 AND 100),
  state text NOT NULL CHECK (state IN ('pending','published','failed')),
  external_id text CHECK (length(external_id) <= 300),
  url text CHECK (length(url) <= 2000),
  error text CHECK (length(error) <= 500),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  completed_at timestamptz,
  PRIMARY KEY (organization_id,post_id,target),
  FOREIGN KEY (organization_id,post_id) REFERENCES cloud_release_posts(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_release_jobs (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  release_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('write','video','capture')),
  state text NOT NULL CHECK (state IN ('queued','running','waiting','succeeded','failed')),
  actor_id uuid NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
  error text CHECK (length(error) <= 500),
  chat_id uuid,
  turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,release_id) REFERENCES cloud_releases(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,actor_id) REFERENCES cloud_memberships(organization_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,chat_id) REFERENCES cloud_chats(organization_id,id) ON DELETE SET NULL (chat_id)
);
CREATE INDEX cloud_release_jobs_active ON cloud_release_jobs(updated_at) WHERE state IN ('queued','running','waiting');
CREATE INDEX cloud_release_jobs_release ON cloud_release_jobs(organization_id,release_id,created_at DESC);

CREATE TABLE cloud_release_capture_tokens (
  token_hash text PRIMARY KEY,
  organization_id uuid NOT NULL,
  release_id uuid NOT NULL,
  job_id uuid NOT NULL,
  created_by uuid NOT NULL,
  uploads integer NOT NULL DEFAULT 0 CHECK (uploads >= 0),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id,release_id) REFERENCES cloud_releases(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,job_id) REFERENCES cloud_release_jobs(organization_id,id) ON DELETE CASCADE
);

ALTER TABLE cloud_chats ADD COLUMN release_id uuid;
ALTER TABLE cloud_chats ADD FOREIGN KEY (organization_id,release_id) REFERENCES cloud_releases(organization_id,id) ON DELETE SET NULL (release_id);
