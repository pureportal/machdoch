ALTER TABLE cloud_runs ADD COLUMN base_commit text CHECK (base_commit ~ '^[0-9a-f]{40}$');
ALTER TABLE cloud_inference_calls ADD COLUMN purpose text NOT NULL DEFAULT 'task' CHECK (purpose IN ('task','review'));
ALTER TABLE cloud_inference_calls ADD COLUMN review_diff text CHECK (length(review_diff) <= 8388608);

CREATE TABLE cloud_run_reviews (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  request_id uuid NOT NULL,
  round integer NOT NULL CHECK (round BETWEEN 1 AND 3),
  candidate_commit text NOT NULL CHECK (candidate_commit ~ '^[0-9a-f]{40}$'),
  decision text NOT NULL CHECK (decision IN ('approve','request_changes')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  findings jsonb NOT NULL,
  gates jsonb NOT NULL,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 300),
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,attempt_id,round),
  UNIQUE (organization_id,request_id),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_run_reviews_run ON cloud_run_reviews(organization_id,run_id,created_at);

CREATE TABLE cloud_run_deliveries (
  organization_id uuid NOT NULL,
  run_id uuid NOT NULL,
  issue_id uuid,
  repository text NOT NULL CHECK (length(repository) <= 500),
  kind text NOT NULL DEFAULT 'change' CHECK (kind IN ('change','check')),
  state text NOT NULL CHECK (state IN ('publishing','reported','open','merging','merged','needs_person','closed','failed')),
  branch text NOT NULL CHECK (length(branch) BETWEEN 1 AND 255),
  base_branch text NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  pull_request_id uuid,
  pull_request_number integer,
  pull_request_url text CHECK (length(pull_request_url) <= 1000),
  auto_merge boolean NOT NULL,
  reason text CHECK (length(reason) <= 2000),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  merged_at timestamptz,
  PRIMARY KEY (organization_id,run_id),
  FOREIGN KEY (organization_id,run_id) REFERENCES cloud_runs(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_run_deliveries_pending ON cloud_run_deliveries(next_attempt_at) WHERE state IN ('publishing','open','merging');
CREATE INDEX cloud_run_deliveries_issue ON cloud_run_deliveries(organization_id,issue_id);
