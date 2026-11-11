ALTER TABLE cloud_issues DROP CONSTRAINT cloud_issues_state_check;
ALTER TABLE cloud_issues ADD CONSTRAINT cloud_issues_state_check CHECK (state IN ('triage','backlog','ready','active','blocked','review','complete','canceled'));
ALTER TABLE cloud_workflow_statuses DROP CONSTRAINT cloud_workflow_statuses_category_check;
ALTER TABLE cloud_workflow_statuses ADD CONSTRAINT cloud_workflow_statuses_category_check CHECK (category IN ('triage','backlog','ready','active','blocked','review','complete','canceled'));
ALTER TABLE cloud_issue_relations DROP CONSTRAINT cloud_issue_relations_kind_check;
ALTER TABLE cloud_issue_relations ADD CONSTRAINT cloud_issue_relations_kind_check CHECK (kind IN ('parent','blocks','related','duplicate'));
CREATE INDEX cloud_issues_triage ON cloud_issues(organization_id,team_id,created_at DESC) WHERE state='triage' AND NOT archived;
