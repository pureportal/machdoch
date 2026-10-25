CREATE TABLE cloud_ai_key_checks (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  payload bytea NOT NULL
);
CREATE TABLE cloud_ai_providers (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','google','langdock')),
  region text CHECK (region IN ('eu','us')),
  models jsonb NOT NULL CHECK (jsonb_typeof(models)='array'),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 64 AND 65536),
  daily_token_budget integer NOT NULL CHECK (daily_token_budget BETWEEN 1000 AND 100000000),
  max_concurrent_requests integer NOT NULL CHECK (max_concurrent_requests BETWEEN 1 AND 32),
  secret bytea NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,name),
  CHECK ((provider='langdock')=(region IS NOT NULL))
);
