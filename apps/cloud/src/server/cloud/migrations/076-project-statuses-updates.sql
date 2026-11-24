CREATE TABLE cloud_project_statuses (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  category text NOT NULL CHECK (category IN ('backlog','planned','active','paused','completed','canceled')),
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, id, category)
);
CREATE UNIQUE INDEX cloud_project_statuses_name ON cloud_project_statuses(organization_id, lower(name));

CREATE FUNCTION cloud_seed_project_statuses(organization uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO cloud_project_statuses (organization_id, id, name, category, position) VALUES
    (organization, gen_random_uuid(), 'Backlog', 'backlog', 0),
    (organization, gen_random_uuid(), 'Planned', 'planned', 1),
    (organization, gen_random_uuid(), 'In progress', 'active', 2),
    (organization, gen_random_uuid(), 'Paused', 'paused', 3),
    (organization, gen_random_uuid(), 'Completed', 'completed', 4),
    (organization, gen_random_uuid(), 'Canceled', 'canceled', 5);
$$;
CREATE FUNCTION cloud_seed_organization_project_statuses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cloud_seed_project_statuses(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_organization_project_statuses AFTER INSERT ON cloud_organizations
  FOR EACH ROW EXECUTE FUNCTION cloud_seed_organization_project_statuses();

SELECT cloud_seed_project_statuses(id) FROM cloud_organizations;

ALTER TABLE cloud_projects ADD COLUMN status_id uuid;
UPDATE cloud_projects p SET status_id=s.id FROM cloud_project_statuses s
  WHERE s.organization_id=p.organization_id AND s.category=p.status;
ALTER TABLE cloud_projects ALTER COLUMN status_id SET NOT NULL;
ALTER TABLE cloud_projects ADD FOREIGN KEY (organization_id, status_id, status)
  REFERENCES cloud_project_statuses(organization_id, id, category) ON UPDATE CASCADE;
ALTER TABLE cloud_projects ADD COLUMN update_cadence text NOT NULL DEFAULT 'none'
  CHECK (update_cadence IN ('none','weekly','biweekly','monthly'));
ALTER TABLE cloud_projects ADD COLUMN update_cadence_since timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE cloud_projects ADD COLUMN update_reminded_at timestamptz;

ALTER TABLE cloud_project_updates ADD COLUMN draft boolean NOT NULL DEFAULT false;
CREATE INDEX cloud_project_updates_drafts ON cloud_project_updates(organization_id, project_id) WHERE draft;

ALTER TABLE cloud_notifications ADD COLUMN project_id uuid;
ALTER TABLE cloud_notifications ADD FOREIGN KEY (organization_id, project_id) REFERENCES cloud_projects(organization_id, id) ON DELETE CASCADE;
ALTER TABLE cloud_notifications DROP CONSTRAINT cloud_notifications_check;
ALTER TABLE cloud_notifications ADD CHECK (num_nonnulls(issue_id,run_id,automation_run_id,project_id) > 0);
ALTER TABLE cloud_notifications DROP CONSTRAINT cloud_notifications_kind_check;
ALTER TABLE cloud_notifications ADD CONSTRAINT cloud_notifications_kind_check CHECK (kind IN ('assigned','commented','mentioned','task_finished','status_changed','pull_request','loop_input','loop_approval','loop_message','sla_breached','project_update_due','project_update_drafted'));
