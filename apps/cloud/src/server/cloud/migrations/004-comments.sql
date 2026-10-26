CREATE TABLE cloud_comments (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  issue_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES cloud_users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id)
);
CREATE INDEX cloud_comments_issue ON cloud_comments(organization_id,issue_id,created_at,id);
CREATE TABLE cloud_comment_history (
  organization_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES cloud_users(id),
  body text NOT NULL,
  deleted boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,comment_id,revision),
  FOREIGN KEY (organization_id,comment_id) REFERENCES cloud_comments(organization_id,id)
);
