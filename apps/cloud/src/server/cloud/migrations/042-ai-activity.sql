CREATE TABLE cloud_ai_activity (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('agent','model','task','step')),
  status text NOT NULL CHECK (status IN ('info','started','succeeded','failed','canceled')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
  actor_id uuid NOT NULL,
  run_id uuid,
  chat_id uuid,
  model text CHECK (length(model) <= 160),
  provider text CHECK (length(provider) <= 40),
  tokens integer CHECK (tokens >= 0),
  duration_ms integer CHECK (duration_ms >= 0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  exported_at timestamptz,
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,sequence),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id),
  FOREIGN KEY (organization_id,chat_id) REFERENCES cloud_chats(organization_id,id)
);
CREATE INDEX cloud_ai_activity_run ON cloud_ai_activity(organization_id,run_id,sequence) WHERE run_id IS NOT NULL;
CREATE INDEX cloud_ai_activity_export ON cloud_ai_activity(organization_id,sequence) WHERE exported_at IS NULL;
CREATE INDEX cloud_ai_activity_retention ON cloud_ai_activity(occurred_at);

CREATE TABLE cloud_mimorii_connections (
  organization_id uuid PRIMARY KEY REFERENCES cloud_organizations(id),
  url text NOT NULL CHECK (length(url) <= 300),
  secret bytea NOT NULL,
  token_prefix text NOT NULL CHECK (length(token_prefix) <= 32),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  connected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  delivered_entries bigint NOT NULL DEFAULT 0 CHECK (delivered_entries >= 0),
  rejected_entries bigint NOT NULL DEFAULT 0 CHECK (rejected_entries >= 0),
  last_error text CHECK (length(last_error) <= 500),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  retry_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
