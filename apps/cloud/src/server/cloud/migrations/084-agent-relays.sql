CREATE TABLE cloud_agent_relays (
  organization_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('issue_comment','pull_request_comment')),
  author text NOT NULL CHECK (length(author) BETWEEN 1 AND 200),
  comment_id uuid,
  pull_request_id uuid,
  external_url text CHECK (length(external_url) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,turn_id),
  FOREIGN KEY (organization_id,turn_id) REFERENCES cloud_chat_turns(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,comment_id) REFERENCES cloud_comments(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,pull_request_id) REFERENCES cloud_git_pull_requests(organization_id,id) ON DELETE CASCADE,
  CHECK ((source='issue_comment') = (comment_id IS NOT NULL)),
  CHECK ((source='pull_request_comment') = (pull_request_id IS NOT NULL AND external_url IS NOT NULL))
);
CREATE UNIQUE INDEX cloud_agent_relays_comment ON cloud_agent_relays(organization_id,comment_id) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX cloud_agent_relays_external ON cloud_agent_relays(organization_id,external_url) WHERE external_url IS NOT NULL;
