CREATE TABLE cloud_issue_relations (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('parent','blocks','related')),
  source_id uuid NOT NULL,
  target_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES cloud_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at timestamptz,
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,source_id) REFERENCES cloud_issues(organization_id,id),
  FOREIGN KEY (organization_id,target_id) REFERENCES cloud_issues(organization_id,id),
  CHECK (source_id <> target_id),
  CHECK (kind <> 'related' OR source_id < target_id)
);
CREATE UNIQUE INDEX cloud_issue_relations_edge ON cloud_issue_relations (organization_id,kind,source_id,target_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX cloud_issue_relations_parent ON cloud_issue_relations (organization_id,target_id) WHERE kind='parent' AND removed_at IS NULL;
CREATE INDEX cloud_issue_relations_source ON cloud_issue_relations (source_id,organization_id) INCLUDE (kind,target_id) WHERE removed_at IS NULL;
CREATE INDEX cloud_issue_relations_target ON cloud_issue_relations (target_id,organization_id) WHERE removed_at IS NULL;
ALTER TABLE cloud_runs ADD COLUMN planning_digest text;
CREATE TABLE cloud_issue_relation_versions (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  version uuid NOT NULL,
  PRIMARY KEY (organization_id,issue_id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id)
);
UPDATE cloud_runs SET planning_digest=encode(sha256(convert_to('[null,[]]','UTF8')),'hex') WHERE issue_id IS NOT NULL;
ALTER TABLE cloud_runs ADD CONSTRAINT cloud_runs_planning_digest CHECK ((issue_id IS NULL AND planning_digest IS NULL) OR (issue_id IS NOT NULL AND planning_digest IS NOT NULL AND planning_digest ~ '^[a-f0-9]{64}$'));
