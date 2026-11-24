CREATE TABLE cloud_git_review_guides (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  pull_request_id uuid NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  actor_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting','ready','failed')),
  error text CHECK (char_length(error) <= 500),
  chat_id uuid,
  turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, pull_request_id, head_sha),
  FOREIGN KEY (organization_id, pull_request_id) REFERENCES cloud_git_pull_requests(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, actor_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, chat_id) REFERENCES cloud_chats(organization_id, id) ON DELETE SET NULL (chat_id)
);
CREATE INDEX cloud_git_review_guides_waiting ON cloud_git_review_guides(created_at, id) WHERE state = 'waiting';

CREATE TABLE cloud_git_review_guide_sections (
  organization_id uuid NOT NULL,
  guide_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  purpose text NOT NULL CHECK (char_length(purpose) <= 2000),
  impact text NOT NULL CHECK (char_length(impact) <= 2000),
  PRIMARY KEY (organization_id, guide_id, position),
  FOREIGN KEY (organization_id, guide_id) REFERENCES cloud_git_review_guides(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE cloud_git_review_guide_files (
  organization_id uuid NOT NULL,
  guide_id uuid NOT NULL,
  section_position integer NOT NULL,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1000),
  PRIMARY KEY (organization_id, guide_id, section_position, path),
  FOREIGN KEY (organization_id, guide_id, section_position) REFERENCES cloud_git_review_guide_sections(organization_id, guide_id, position) ON DELETE CASCADE
);

ALTER TABLE cloud_chats ADD COLUMN review_guide_id uuid;
ALTER TABLE cloud_chats ADD FOREIGN KEY (organization_id, review_guide_id) REFERENCES cloud_git_review_guides(organization_id, id) ON DELETE SET NULL (review_guide_id);
