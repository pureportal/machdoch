CREATE TABLE cloud_workflow_statuses (
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  name_key text GENERATED ALWAYS AS (lower(name)) STORED,
  category text NOT NULL CHECK (category IN ('backlog','ready','active','blocked','review','complete','canceled')),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,team_id,id),
  UNIQUE (organization_id,team_id,id,category),
  UNIQUE (organization_id,team_id,name_key) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (organization_id,team_id,position) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id)
);
CREATE TABLE cloud_team_workflows (
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  default_status_id uuid NOT NULL,
  PRIMARY KEY (organization_id,team_id),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id),
  FOREIGN KEY (organization_id,team_id,default_status_id) REFERENCES cloud_workflow_statuses(organization_id,team_id,id)
);
CREATE TABLE cloud_workflow_revisions (
  organization_id uuid NOT NULL,
  team_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_id uuid REFERENCES cloud_users(id),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,team_id,revision),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id)
);
CREATE FUNCTION cloud_initialize_team_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cloud_workflow_statuses(organization_id,team_id,id,name,category,position)
  SELECT NEW.organization_id,NEW.id,gen_random_uuid(),name,category,position FROM (VALUES
    ('Backlog','backlog',0),('Ready','ready',1),('In progress','active',2),('Blocked','blocked',3),
    ('In review','review',4),('Done','complete',5),('Canceled','canceled',6)
  ) defaults(name,category,position);
  INSERT INTO cloud_team_workflows(organization_id,team_id,default_status_id)
  SELECT NEW.organization_id,NEW.id,id FROM cloud_workflow_statuses WHERE organization_id=NEW.organization_id AND team_id=NEW.id AND category='backlog';
  INSERT INTO cloud_workflow_revisions(organization_id,team_id,revision,snapshot)
  SELECT w.organization_id,w.team_id,1,jsonb_build_object('teamId',w.team_id,'revision',1,'defaultStatusId',w.default_status_id,
    'statuses',(SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'category',s.category,'archived',s.archived,'revision',s.revision) ORDER BY s.position) FROM cloud_workflow_statuses s WHERE s.organization_id=w.organization_id AND s.team_id=w.team_id))
  FROM cloud_team_workflows w WHERE w.organization_id=NEW.organization_id AND w.team_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_team_workflow_seed AFTER INSERT ON cloud_teams FOR EACH ROW EXECUTE FUNCTION cloud_initialize_team_workflow();
INSERT INTO cloud_workflow_statuses(organization_id,team_id,id,name,category,position)
SELECT t.organization_id,t.id,gen_random_uuid(),d.name,d.category,d.position FROM cloud_teams t CROSS JOIN (VALUES
  ('Backlog','backlog',0),('Ready','ready',1),('In progress','active',2),('Blocked','blocked',3),
  ('In review','review',4),('Done','complete',5),('Canceled','canceled',6)
) d(name,category,position);
INSERT INTO cloud_team_workflows(organization_id,team_id,default_status_id)
SELECT organization_id,team_id,id FROM cloud_workflow_statuses WHERE category='backlog';
INSERT INTO cloud_workflow_revisions(organization_id,team_id,revision,snapshot)
SELECT w.organization_id,w.team_id,1,jsonb_build_object('teamId',w.team_id,'revision',1,'defaultStatusId',w.default_status_id,
  'statuses',(SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'category',s.category,'archived',s.archived,'revision',s.revision) ORDER BY s.position) FROM cloud_workflow_statuses s WHERE s.organization_id=w.organization_id AND s.team_id=w.team_id))
FROM cloud_team_workflows w;
ALTER TABLE cloud_issues ADD COLUMN status_id uuid;
UPDATE cloud_issues i SET status_id=s.id FROM cloud_workflow_statuses s WHERE s.organization_id=i.organization_id AND s.team_id=i.team_id AND s.category=i.state;
ALTER TABLE cloud_issues ALTER COLUMN status_id SET NOT NULL;
ALTER TABLE cloud_issues ADD CONSTRAINT cloud_issue_workflow_status FOREIGN KEY (organization_id,team_id,status_id,state) REFERENCES cloud_workflow_statuses(organization_id,team_id,id,category) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX cloud_issues_status ON cloud_issues(organization_id,status_id,id);
ALTER TABLE cloud_issue_history ADD COLUMN status_name text;
UPDATE cloud_issue_history SET status_name=snapshot->>'state';
ALTER TABLE cloud_issue_history ALTER COLUMN status_name SET NOT NULL;
ALTER TABLE cloud_cycles ADD COLUMN closing_status_names jsonb;
UPDATE cloud_cycles SET closing_status_names=(SELECT COALESCE(jsonb_object_agg(item->>'id',item->>'state'),'{}'::jsonb) FROM jsonb_array_elements(closing_snapshot) item) WHERE status='closed';
ALTER TABLE cloud_cycles ADD CONSTRAINT cloud_cycles_status_names CHECK (status<>'closed' OR closing_status_names IS NOT NULL);
UPDATE cloud_schedules s SET action=jsonb_set(action,'{issue}',((action->'issue') - 'state') || jsonb_build_object('status',jsonb_build_object('id',w.id,'revision',w.revision)))
FROM cloud_workflow_statuses w WHERE s.action->>'kind'='create-issue' AND w.organization_id=s.organization_id AND w.team_id=s.team_id AND w.category=COALESCE(s.action->'issue'->>'state','backlog');
