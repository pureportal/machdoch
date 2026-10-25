CREATE TABLE cloud_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  password_hash text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cloud_organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE cloud_memberships (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  user_id uuid NOT NULL REFERENCES cloud_users(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE cloud_sessions (
  token_hash text PRIMARY KEY,
  csrf_hash text NOT NULL,
  user_id uuid NOT NULL REFERENCES cloud_users(id),
  organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  touched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX cloud_sessions_expiry ON cloud_sessions(expires_at);

CREATE TABLE cloud_login_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE cloud_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES cloud_users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE cloud_teams (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  name text NOT NULL,
  key text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  visibility text NOT NULL CHECK (visibility IN ('organization', 'private')),
  estimate_scale jsonb NOT NULL CHECK (jsonb_typeof(estimate_scale) = 'array'),
  scale_revision integer NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1,
  next_issue_number integer NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, key)
);

CREATE TABLE cloud_team_memberships (
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (organization_id, team_id, user_id),
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_projects (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, team_id, id),
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id)
);

CREATE TABLE cloud_cycles (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL CHECK (ends_on > starts_on),
  timezone text NOT NULL,
  capacity double precision CHECK (capacity >= 0),
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, team_id, id),
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id)
);
CREATE INDEX cloud_cycles_team_dates ON cloud_cycles(organization_id, team_id, starts_on, ends_on);

CREATE TABLE cloud_issues (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  identifier text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text NOT NULL,
  acceptance_criteria text NOT NULL,
  state text NOT NULL CHECK (state IN ('backlog', 'ready', 'active', 'blocked', 'review', 'complete', 'canceled')),
  priority text NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'normal', 'low')),
  project_id uuid,
  cycle_id uuid,
  assignee_id uuid,
  estimate text,
  estimate_points double precision CHECK (estimate_points >= 0),
  estimate_scale_revision integer,
  due_on date,
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, identifier),
  FOREIGN KEY (organization_id, team_id) REFERENCES cloud_teams(organization_id, id),
  FOREIGN KEY (organization_id, team_id, project_id) REFERENCES cloud_projects(organization_id, team_id, id),
  FOREIGN KEY (organization_id, team_id, cycle_id) REFERENCES cloud_cycles(organization_id, team_id, id),
  FOREIGN KEY (organization_id, assignee_id) REFERENCES cloud_memberships(organization_id, user_id)
);
CREATE INDEX cloud_issues_team ON cloud_issues(organization_id, team_id, archived, updated_at DESC, id);

CREATE TABLE cloud_issue_history (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_id uuid NOT NULL REFERENCES cloud_users(id),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, issue_id, revision),
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_issues(organization_id, id)
);

CREATE TABLE cloud_poker_rounds (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  issue_id uuid NOT NULL,
  facilitator_id uuid NOT NULL,
  issue_revision integer NOT NULL,
  scale jsonb NOT NULL,
  scale_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'voting' CHECK (status IN ('voting', 'revealed', 'decided', 'closed')),
  generation integer NOT NULL DEFAULT 1,
  revision integer NOT NULL DEFAULT 1,
  decision text,
  rationale text,
  PRIMARY KEY (organization_id, id),
  FOREIGN KEY (organization_id, issue_id) REFERENCES cloud_issues(organization_id, id),
  FOREIGN KEY (organization_id, facilitator_id) REFERENCES cloud_memberships(organization_id, user_id)
);
CREATE UNIQUE INDEX cloud_poker_active_issue ON cloud_poker_rounds(organization_id, issue_id) WHERE status IN ('voting', 'revealed');

CREATE TABLE cloud_poker_votes (
  organization_id uuid NOT NULL,
  round_id uuid NOT NULL,
  generation integer NOT NULL,
  user_id uuid NOT NULL,
  card text NOT NULL,
  PRIMARY KEY (organization_id, round_id, generation, user_id),
  FOREIGN KEY (organization_id, round_id) REFERENCES cloud_poker_rounds(organization_id, id),
  FOREIGN KEY (organization_id, user_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_command_receipts (
  organization_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  command_id uuid NOT NULL,
  digest text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (organization_id, actor_id, command_id),
  FOREIGN KEY (organization_id, actor_id) REFERENCES cloud_memberships(organization_id, user_id) ON DELETE CASCADE
);

CREATE TABLE cloud_outbox (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  actor_id uuid NOT NULL REFERENCES cloud_users(id),
  kind text NOT NULL,
  subject_id uuid NOT NULL,
  revision integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
