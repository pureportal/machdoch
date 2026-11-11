CREATE TABLE cloud_initiatives (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed')),
  owner_id uuid,
  target_on date,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,owner_id) REFERENCES cloud_memberships(organization_id,user_id)
);
CREATE INDEX cloud_initiatives_name ON cloud_initiatives(organization_id,lower(name));
CREATE TABLE cloud_initiative_projects (
  organization_id uuid NOT NULL,
  initiative_id uuid NOT NULL,
  project_id uuid NOT NULL,
  PRIMARY KEY (organization_id,initiative_id,project_id),
  FOREIGN KEY (organization_id,initiative_id) REFERENCES cloud_initiatives(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,project_id) REFERENCES cloud_projects(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX cloud_initiative_projects_project ON cloud_initiative_projects(organization_id,project_id);
ALTER TABLE cloud_project_milestones ADD CONSTRAINT cloud_project_milestones_project_identity UNIQUE (organization_id,project_id,id);
ALTER TABLE cloud_issues ADD COLUMN milestone_id uuid;
ALTER TABLE cloud_issues ADD CONSTRAINT cloud_issue_milestone FOREIGN KEY (organization_id,project_id,milestone_id) REFERENCES cloud_project_milestones(organization_id,project_id,id) ON DELETE SET NULL (milestone_id);
CREATE INDEX cloud_issues_milestone ON cloud_issues(organization_id,milestone_id) WHERE milestone_id IS NOT NULL;
ALTER TABLE cloud_chats ADD COLUMN archived_at timestamptz;
