ALTER TABLE cloud_ai_providers ADD COLUMN inference_revision integer NOT NULL DEFAULT 1 CHECK (inference_revision>0);
CREATE TABLE cloud_chats (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,user_id) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE INDEX cloud_chats_owner ON cloud_chats(organization_id,user_id,updated_at DESC,id);
CREATE TABLE cloud_chat_turns (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  chat_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  model text NOT NULL,
  sequence integer NOT NULL CHECK (sequence>0),
  prompt text NOT NULL,
  answer text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('queued','running','cancel_requested','complete','failed','canceled','unknown')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  error_code text,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,chat_id,sequence),
  FOREIGN KEY (organization_id,chat_id) REFERENCES cloud_chats(organization_id,id),
  FOREIGN KEY (organization_id,provider_id) REFERENCES cloud_ai_providers(organization_id,id)
);
CREATE UNIQUE INDEX cloud_chat_one_active_turn ON cloud_chat_turns(organization_id,chat_id) WHERE state IN ('queued','running','cancel_requested');
CREATE TABLE cloud_inference_calls (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  turn_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  provider_revision integer NOT NULL,
  model text NOT NULL,
  user_prompt text NOT NULL,
  system_prompt text NOT NULL,
  reserved_tokens integer NOT NULL CHECK (reserved_tokens>0),
  actual_tokens integer CHECK (actual_tokens>=0),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens>0),
  budget_day date NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','cancel_requested','complete','failed','canceled','unknown')),
  execution_id uuid,
  request_started_at timestamptz,
  lease_until timestamptz,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,turn_id,id),
  CHECK (state NOT IN ('running','cancel_requested') OR (execution_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (request_started_at IS NULL OR execution_id IS NOT NULL),
  FOREIGN KEY (organization_id,turn_id) REFERENCES cloud_chat_turns(organization_id,id),
  FOREIGN KEY (organization_id,actor_id) REFERENCES cloud_memberships(organization_id,user_id),
  FOREIGN KEY (organization_id,provider_id) REFERENCES cloud_ai_providers(organization_id,id)
);
ALTER TABLE cloud_chat_turns ADD CONSTRAINT cloud_chat_current_request FOREIGN KEY (organization_id,id,request_id) REFERENCES cloud_inference_calls(organization_id,turn_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX cloud_inference_budget ON cloud_inference_calls(organization_id,provider_id,budget_day);
CREATE INDEX cloud_inference_pending ON cloud_inference_calls(state,deadline_at,created_at) WHERE state IN ('queued','running','cancel_requested');
CREATE UNIQUE INDEX cloud_inference_one_active_attempt ON cloud_inference_calls(organization_id,turn_id) WHERE state IN ('queued','running','cancel_requested');
