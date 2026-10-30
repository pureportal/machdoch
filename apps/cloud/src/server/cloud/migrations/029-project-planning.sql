ALTER TABLE cloud_projects ADD COLUMN status text NOT NULL DEFAULT 'planned' CHECK (status IN ('backlog','planned','active','paused','completed','canceled'));
ALTER TABLE cloud_projects ADD COLUMN lead_id uuid;
ALTER TABLE cloud_projects ADD COLUMN starts_on date;
ALTER TABLE cloud_projects ADD COLUMN target_on date;
ALTER TABLE cloud_projects ADD CONSTRAINT cloud_project_lead FOREIGN KEY (organization_id,lead_id) REFERENCES cloud_memberships(organization_id,user_id);
ALTER TABLE cloud_projects ADD CONSTRAINT cloud_project_dates CHECK (starts_on IS NULL OR target_on IS NULL OR target_on>=starts_on);
