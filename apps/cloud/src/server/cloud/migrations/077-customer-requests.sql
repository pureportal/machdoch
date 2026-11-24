CREATE TABLE cloud_customers (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  domain text CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id)
);
CREATE UNIQUE INDEX cloud_customers_name ON cloud_customers(organization_id, lower(name));
CREATE UNIQUE INDEX cloud_customers_domain ON cloud_customers(organization_id, domain) WHERE domain IS NOT NULL;

CREATE TABLE cloud_request_intake (
  organization_id uuid PRIMARY KEY REFERENCES cloud_organizations(id) ON DELETE CASCADE,
  team_id uuid NOT NULL,
  configured_by uuid NOT NULL REFERENCES cloud_users(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE cloud_request_channels (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email','slack','teams','webhook')),
  enabled boolean NOT NULL DEFAULT false,
  secret_hash text,
  rotated_at timestamptz,
  PRIMARY KEY (organization_id, channel)
);

CREATE TABLE cloud_customer_requests (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  issue_id uuid NOT NULL,
  customer_id uuid,
  channel text NOT NULL CHECK (channel IN ('email','slack','teams','webhook')),
  requester text NOT NULL DEFAULT '' CHECK (char_length(requester) <= 320),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
  fingerprint text NOT NULL,
  mentions integer NOT NULL DEFAULT 1 CHECK (mentions > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_issues(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, customer_id) REFERENCES cloud_customers(organization_id, id) ON DELETE SET NULL (customer_id)
);
CREATE INDEX cloud_customer_requests_issue ON cloud_customer_requests(organization_id, issue_id);
CREATE INDEX cloud_customer_requests_fingerprint ON cloud_customer_requests(organization_id, fingerprint) WHERE fingerprint <> '';
CREATE UNIQUE INDEX cloud_customer_requests_customer ON cloud_customer_requests(organization_id, issue_id, customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE cloud_customer_request_messages (
  organization_id uuid NOT NULL,
  channel text NOT NULL,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 300),
  request_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, channel, external_id),
  FOREIGN KEY (organization_id, request_id) REFERENCES cloud_customer_requests(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX cloud_customer_request_messages_request ON cloud_customer_request_messages(organization_id, request_id);
