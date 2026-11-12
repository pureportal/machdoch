CREATE TABLE cloud_attachments (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  issue_id uuid,
  chat_id uuid,
  turn_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK (length(mime) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('image','video','document','file')),
  byte_length integer NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  width integer,
  height integer,
  source text NOT NULL CHECK (source IN ('upload','agent','client')),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  CHECK (issue_id IS NULL OR chat_id IS NULL),
  CHECK (turn_id IS NULL OR chat_id IS NOT NULL),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,chat_id) REFERENCES cloud_chats(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,turn_id) REFERENCES cloud_chat_turns(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,created_by) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE INDEX cloud_attachments_issue ON cloud_attachments(organization_id,issue_id,created_at) WHERE issue_id IS NOT NULL;
CREATE INDEX cloud_attachments_chat ON cloud_attachments(organization_id,chat_id,created_at) WHERE chat_id IS NOT NULL;
CREATE INDEX cloud_attachments_pending ON cloud_attachments(created_at) WHERE issue_id IS NULL AND chat_id IS NULL;

CREATE TABLE cloud_attachment_chunks (
  organization_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  offset_bytes integer NOT NULL CHECK (offset_bytes >= 0),
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 262144),
  PRIMARY KEY (organization_id,attachment_id,offset_bytes),
  FOREIGN KEY (organization_id,attachment_id) REFERENCES cloud_attachments(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_attachment_upload_links (
  token_hash text PRIMARY KEY,
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  created_by uuid NOT NULL,
  uploads integer NOT NULL DEFAULT 0 CHECK (uploads >= 0),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,created_by) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE INDEX cloud_attachment_upload_links_expiry ON cloud_attachment_upload_links(expires_at);
