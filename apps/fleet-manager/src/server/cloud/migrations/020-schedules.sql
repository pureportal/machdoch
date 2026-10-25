ALTER TABLE cloud_teams ADD COLUMN access_epoch bigint NOT NULL DEFAULT nextval('cloud_authentication_generation');
CREATE FUNCTION cloud_touch_team_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    NEW.access_epoch = nextval('cloud_authentication_generation');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cloud_team_access_change BEFORE UPDATE ON cloud_teams FOR EACH ROW EXECUTE FUNCTION cloud_touch_team_access();
CREATE FUNCTION cloud_touch_team_membership_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE cloud_teams SET access_epoch=nextval('cloud_authentication_generation') WHERE organization_id=COALESCE(NEW.organization_id,OLD.organization_id) AND id=COALESCE(NEW.team_id,OLD.team_id);
  RETURN NULL;
END;
$$;
CREATE TRIGGER cloud_team_membership_access_change AFTER INSERT OR DELETE ON cloud_team_memberships FOR EACH ROW EXECUTE FUNCTION cloud_touch_team_membership_access();
CREATE TABLE cloud_schedule_worker (
  id integer PRIMARY KEY CHECK (id=1),
  touched_at timestamptz NOT NULL
);
CREATE TABLE cloud_issue_schedules (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  owner_epoch bigint NOT NULL,
  user_epoch bigint NOT NULL,
  team_epoch bigint NOT NULL,
  name text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  enabled boolean NOT NULL DEFAULT false,
  issue jsonb NOT NULL,
  recurrence jsonb NOT NULL,
  definition_key text NOT NULL CHECK (length(definition_key)=64),
  missed text NOT NULL CHECK (missed IN ('skip','latest','bounded-all')),
  catch_up_limit integer NOT NULL CHECK (catch_up_limit BETWEEN 1 AND 20),
  lookback_hours integer NOT NULL CHECK (lookback_hours BETWEEN 1 AND 168),
  next_at bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id),
  FOREIGN KEY (organization_id,owner_id) REFERENCES cloud_memberships(organization_id,user_id),
  CHECK (NOT enabled OR next_at IS NOT NULL)
);
CREATE INDEX cloud_issue_schedules_due ON cloud_issue_schedules(next_at,id) WHERE enabled;
CREATE TABLE cloud_schedule_revisions (
  organization_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  revision integer NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL REFERENCES cloud_users(id),
  snapshot jsonb NOT NULL,
  PRIMARY KEY (schedule_id,revision),
  FOREIGN KEY (organization_id,schedule_id) REFERENCES cloud_issue_schedules(organization_id,id)
);
CREATE TABLE cloud_schedule_occurrences (
  organization_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  revision integer NOT NULL,
  nominal_at bigint NOT NULL,
  accounted_through bigint NOT NULL CHECK (accounted_through >= nominal_at),
  outcome text NOT NULL CHECK (outcome IN ('created','skipped')),
  issue_id uuid,
  PRIMARY KEY (schedule_id,revision,nominal_at),
  FOREIGN KEY (schedule_id,revision) REFERENCES cloud_schedule_revisions(schedule_id,revision),
  FOREIGN KEY (organization_id,schedule_id) REFERENCES cloud_issue_schedules(organization_id,id),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id),
  CHECK ((outcome='created') = (issue_id IS NOT NULL))
);
