ALTER TABLE cloud_issues ADD CONSTRAINT cloud_issues_team_identity UNIQUE (organization_id,team_id,id);
CREATE TABLE cloud_labels (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  color text NOT NULL CHECK (color IN ('gray','blue','green','yellow','orange','red','purple','pink')),
  archived boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,team_id,id),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id)
);
CREATE UNIQUE INDEX cloud_labels_name ON cloud_labels (organization_id,team_id,lower(name));
CREATE TABLE cloud_issue_label_sets (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (organization_id,issue_id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE
);
CREATE TABLE cloud_issue_labels (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  team_id uuid NOT NULL,
  label_id uuid NOT NULL,
  PRIMARY KEY (organization_id,issue_id,label_id),
  FOREIGN KEY (organization_id,team_id,issue_id) REFERENCES cloud_issues(organization_id,team_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,team_id,label_id) REFERENCES cloud_labels(organization_id,team_id,id)
);
CREATE INDEX cloud_issue_labels_filter ON cloud_issue_labels (organization_id,label_id,issue_id);
