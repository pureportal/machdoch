ALTER TABLE cloud_issues ADD COLUMN ai_assigned boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_issues ADD COLUMN ai_assigned_by uuid;
ALTER TABLE cloud_issues ADD CONSTRAINT cloud_issues_single_assignee CHECK (NOT (ai_assigned AND assignee_id IS NOT NULL));
ALTER TABLE cloud_issues ADD CONSTRAINT cloud_issues_ai_assigner CHECK (ai_assigned = (ai_assigned_by IS NOT NULL));
CREATE INDEX cloud_issues_ai_assigned ON cloud_issues(organization_id, updated_at) WHERE ai_assigned AND NOT archived;
