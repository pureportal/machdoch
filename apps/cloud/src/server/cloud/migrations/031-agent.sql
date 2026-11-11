CREATE TABLE cloud_chat_context (
  organization_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('issue','project','cycle','team')),
  entity_id uuid NOT NULL,
  turn_sequence integer NOT NULL CHECK (turn_sequence>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,chat_id,kind,entity_id),
  FOREIGN KEY (organization_id,chat_id) REFERENCES cloud_chats(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_chat_context_chat ON cloud_chat_context(organization_id,chat_id,created_at);
INSERT INTO cloud_chat_context(organization_id,chat_id,kind,entity_id,turn_sequence)
SELECT organization_id,id,'issue',issue_id,1 FROM cloud_chats WHERE issue_id IS NOT NULL;
ALTER TABLE cloud_chats DROP CONSTRAINT cloud_chat_issue;
ALTER TABLE cloud_chats DROP COLUMN issue_id;
ALTER TABLE cloud_chat_turns ADD COLUMN steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps)='array');
ALTER TABLE cloud_chat_turns ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions)='array');
ALTER TABLE cloud_chat_turns ADD COLUMN question jsonb CHECK (question IS NULL OR jsonb_typeof(question)='object');
ALTER TABLE cloud_chat_turns ADD COLUMN started_at timestamptz;
ALTER TABLE cloud_chat_turns ADD COLUMN finished_at timestamptz;
