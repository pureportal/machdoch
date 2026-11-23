CREATE TABLE cloud_loops (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  automation_id uuid,
  schedule_id uuid,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  placement text NOT NULL DEFAULT 'automatic' CHECK (placement IN ('automatic','sandbox','client','runner_pool')),
  target_id text CHECK (length(target_id) BETWEEN 1 AND 200),
  harness text NOT NULL DEFAULT 'machdoch' CHECK (harness IN ('machdoch','codex','claude','copilot')),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 120),
  run_budget_cents integer CHECK (run_budget_cents > 0),
  month_budget_cents integer CHECK (month_budget_cents > 0),
  max_duration_minutes integer NOT NULL DEFAULT 60 CHECK (max_duration_minutes BETWEEN 1 AND 1440),
  overlap text NOT NULL DEFAULT 'allow' CHECK (overlap IN ('allow','skip','queue','cancel_previous')),
  missed text NOT NULL DEFAULT 'latest' CHECK (missed IN ('skip','latest')),
  approval_required boolean NOT NULL DEFAULT false,
  pause_after_failures integer CHECK (pause_after_failures BETWEEN 1 AND 100),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  killed_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,automation_id),
  UNIQUE (organization_id,schedule_id),
  CHECK (num_nonnulls(automation_id,schedule_id) = 1),
  CHECK ((placement = 'automatic') = (target_id IS NULL)),
  FOREIGN KEY (organization_id,automation_id) REFERENCES cloud_automations(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,schedule_id) REFERENCES cloud_schedules(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_loop_revisions (
  organization_id uuid NOT NULL,
  loop_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,loop_id,revision),
  FOREIGN KEY (organization_id,loop_id) REFERENCES cloud_loops(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_loop_capabilities (
  organization_id uuid NOT NULL,
  loop_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN ('repository','shell','browser','desktop','local_files','gpu')),
  PRIMARY KEY (organization_id,loop_id,capability),
  FOREIGN KEY (organization_id,loop_id) REFERENCES cloud_loops(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_loop_memory (
  organization_id uuid NOT NULL,
  loop_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  value text NOT NULL CHECK (length(value) <= 4000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,loop_id,key),
  FOREIGN KEY (organization_id,loop_id) REFERENCES cloud_loops(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_documents (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_document_sections (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  heading text NOT NULL CHECK (length(heading) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 50000),
  automation_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,document_id,position),
  FOREIGN KEY (organization_id,document_id) REFERENCES cloud_documents(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_loop_context_sources (
  organization_id uuid NOT NULL,
  loop_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  kind text NOT NULL CHECK (kind IN ('saved_view','filter','team_projects','document','repository','trigger_payload','previous_runs')),
  saved_view_id uuid,
  filter jsonb,
  team_id uuid,
  document_id uuid,
  repository_id uuid,
  run_count integer CHECK (run_count BETWEEN 1 AND 20),
  PRIMARY KEY (organization_id,loop_id,position),
  FOREIGN KEY (organization_id,loop_id) REFERENCES cloud_loops(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,saved_view_id) REFERENCES cloud_saved_views(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,document_id) REFERENCES cloud_documents(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,repository_id) REFERENCES cloud_git_repositories(organization_id,id) ON DELETE CASCADE,
  CHECK ((kind = 'saved_view') = (saved_view_id IS NOT NULL)),
  CHECK ((kind = 'filter') = (filter IS NOT NULL)),
  CHECK ((kind = 'team_projects') = (team_id IS NOT NULL)),
  CHECK ((kind = 'document') = (document_id IS NOT NULL)),
  CHECK ((kind = 'repository') = (repository_id IS NOT NULL)),
  CHECK ((kind = 'previous_runs') = (run_count IS NOT NULL))
);

CREATE TABLE cloud_loop_sources (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  source text NOT NULL CHECK (source IN ('webhook','email','github','gitlab','sentry','grafana','teams','slack')),
  enabled boolean NOT NULL DEFAULT false,
  secret_hash text UNIQUE,
  rotated_at timestamptz,
  PRIMARY KEY (organization_id,source)
);

CREATE TABLE cloud_loop_trusted_sources (
  organization_id uuid NOT NULL,
  loop_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('webhook','email','github','gitlab','sentry','grafana','teams','slack')),
  PRIMARY KEY (organization_id,loop_id,source),
  FOREIGN KEY (organization_id,loop_id) REFERENCES cloud_loops(organization_id,id) ON DELETE CASCADE
);

CREATE TABLE cloud_loop_source_rejections (
  organization_id uuid NOT NULL REFERENCES cloud_organizations(id),
  id uuid NOT NULL,
  source text NOT NULL,
  loop_id uuid,
  reason text NOT NULL CHECK (reason IN ('source_disabled','invalid_secret','untrusted','loops_disabled','killed')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id)
);
CREATE INDEX cloud_loop_source_rejections_recent ON cloud_loop_source_rejections(organization_id,received_at DESC);

CREATE TABLE cloud_loop_settings (
  organization_id uuid PRIMARY KEY REFERENCES cloud_organizations(id),
  enabled boolean NOT NULL DEFAULT true,
  code_access text NOT NULL DEFAULT 'all' CHECK (code_access IN ('all','selected')),
  default_placement text NOT NULL DEFAULT 'automatic' CHECK (default_placement IN ('automatic','sandbox','client','runner_pool')),
  default_target_id text CHECK (length(default_target_id) BETWEEN 1 AND 200),
  run_budget_cap_cents integer CHECK (run_budget_cap_cents > 0),
  month_budget_cap_cents integer CHECK (month_budget_cap_cents > 0),
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 3650),
  cents_per_thousand_tokens numeric(10,4) NOT NULL DEFAULT 1 CHECK (cents_per_thousand_tokens >= 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((default_placement = 'automatic') = (default_target_id IS NULL))
);

CREATE TABLE cloud_loop_code_repositories (
  organization_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  PRIMARY KEY (organization_id,repository_id),
  FOREIGN KEY (organization_id,repository_id) REFERENCES cloud_git_repositories(organization_id,id) ON DELETE CASCADE
);

ALTER TABLE cloud_automation_runs ADD COLUMN loop_revision integer;
ALTER TABLE cloud_automation_runs ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE cloud_automation_runs ADD COLUMN resolved_context jsonb;
ALTER TABLE cloud_automation_runs ADD COLUMN tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0);
ALTER TABLE cloud_automation_runs ADD COLUMN reserved_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0);
ALTER TABLE cloud_automation_runs ADD COLUMN cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0);
ALTER TABLE cloud_automation_runs ADD COLUMN dry_run boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_automation_runs ADD COLUMN replay_of uuid;
ALTER TABLE cloud_automation_runs ADD COLUMN origin_run_id uuid;
ALTER TABLE cloud_automation_runs ADD COLUMN parent_run_id uuid;
ALTER TABLE cloud_automation_runs ADD COLUMN deadline_at timestamptz;
ALTER TABLE cloud_automation_runs ADD COLUMN approved_by uuid;
ALTER TABLE cloud_automation_runs ADD FOREIGN KEY (organization_id,replay_of) REFERENCES cloud_automation_runs(organization_id,id) ON DELETE SET NULL (replay_of);
ALTER TABLE cloud_automation_runs ADD FOREIGN KEY (organization_id,origin_run_id) REFERENCES cloud_automation_runs(organization_id,id) ON DELETE SET NULL (origin_run_id);
ALTER TABLE cloud_automation_runs ADD FOREIGN KEY (organization_id,parent_run_id) REFERENCES cloud_automation_runs(organization_id,id) ON DELETE CASCADE;
CREATE INDEX cloud_automation_runs_parent ON cloud_automation_runs(organization_id,parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX cloud_automation_runs_recent ON cloud_automation_runs(organization_id,automation_id,created_at DESC);

ALTER TABLE cloud_automation_events ADD COLUMN origin_run_id uuid;
ALTER TABLE cloud_automation_events ADD COLUMN source text;

ALTER TABLE cloud_schedule_occurrences ADD COLUMN loop_revision integer;

ALTER TABLE cloud_notifications ADD COLUMN automation_run_id uuid;
ALTER TABLE cloud_notifications ADD FOREIGN KEY (organization_id,automation_run_id) REFERENCES cloud_automation_runs(organization_id,id) ON DELETE CASCADE;
ALTER TABLE cloud_notifications DROP CONSTRAINT cloud_notifications_check;
ALTER TABLE cloud_notifications ADD CHECK (num_nonnulls(issue_id,run_id,automation_run_id) > 0);
ALTER TABLE cloud_notifications DROP CONSTRAINT cloud_notifications_kind_check;
ALTER TABLE cloud_notifications ADD CONSTRAINT cloud_notifications_kind_check CHECK (kind IN ('assigned','commented','mentioned','task_finished','status_changed','pull_request','loop_input','loop_approval','loop_message'));

CREATE FUNCTION cloud_loop_snapshot(org uuid, loop uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'description', l.description,
    'executor', jsonb_build_object('placement', l.placement, 'targetId', l.target_id, 'harness', l.harness, 'model', l.model,
      'capabilities', COALESCE((SELECT jsonb_agg(c.capability ORDER BY c.capability) FROM cloud_loop_capabilities c WHERE c.organization_id = l.organization_id AND c.loop_id = l.id), '[]'::jsonb)),
    'guardrails', jsonb_build_object('runBudgetCents', l.run_budget_cents, 'monthBudgetCents', l.month_budget_cents, 'maxDurationMinutes', l.max_duration_minutes,
      'overlap', l.overlap, 'missed', l.missed, 'approvalRequired', l.approval_required, 'pauseAfterFailures', l.pause_after_failures),
    'contextSources', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', s.kind, 'savedViewId', s.saved_view_id, 'filter', s.filter, 'teamId', s.team_id,
      'documentId', s.document_id, 'repositoryId', s.repository_id, 'runCount', s.run_count)) ORDER BY s.position)
      FROM cloud_loop_context_sources s WHERE s.organization_id = l.organization_id AND s.loop_id = l.id), '[]'::jsonb),
    'trustedSources', COALESCE((SELECT jsonb_agg(t.source ORDER BY t.source) FROM cloud_loop_trusted_sources t WHERE t.organization_id = l.organization_id AND t.loop_id = l.id), '[]'::jsonb),
    'automation', (SELECT jsonb_build_object('name', a.name, 'trigger', a.trigger, 'conditions', a.conditions, 'actions', a.actions, 'dailyLimit', a.daily_limit, 'enabled', a.enabled)
      FROM cloud_automations a WHERE a.organization_id = l.organization_id AND a.id = l.automation_id),
    'schedule', (SELECT jsonb_build_object('name', s.name, 'action', s.action, 'recurrence', s.recurrence, 'missed', s.missed, 'enabled', s.enabled, 'archived', s.archived, 'revision', s.revision)
      FROM cloud_schedules s WHERE s.organization_id = l.organization_id AND s.id = l.schedule_id))
  FROM cloud_loops l WHERE l.organization_id = org AND l.id = loop
$$;

CREATE FUNCTION cloud_loop_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cloud_loop_revisions(organization_id,loop_id,revision,snapshot)
  VALUES (NEW.organization_id, NEW.id, NEW.revision, cloud_loop_snapshot(NEW.organization_id, NEW.id))
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_loops_revision_created AFTER INSERT ON cloud_loops FOR EACH ROW EXECUTE FUNCTION cloud_loop_record_revision();
CREATE TRIGGER cloud_loops_revision_changed AFTER UPDATE ON cloud_loops FOR EACH ROW WHEN (OLD.revision <> NEW.revision) EXECUTE FUNCTION cloud_loop_record_revision();

CREATE FUNCTION cloud_loop_bump_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_loops_config_changed BEFORE UPDATE OF description,placement,target_id,harness,model,run_budget_cents,month_budget_cents,max_duration_minutes,overlap,missed,approval_required,pause_after_failures
  ON cloud_loops FOR EACH ROW
  WHEN ((OLD.description,OLD.placement,OLD.target_id,OLD.harness,OLD.model,OLD.run_budget_cents,OLD.month_budget_cents,OLD.max_duration_minutes,OLD.overlap,OLD.missed,OLD.approval_required,OLD.pause_after_failures)
    IS DISTINCT FROM (NEW.description,NEW.placement,NEW.target_id,NEW.harness,NEW.model,NEW.run_budget_cents,NEW.month_budget_cents,NEW.max_duration_minutes,NEW.overlap,NEW.missed,NEW.approval_required,NEW.pause_after_failures))
  EXECUTE FUNCTION cloud_loop_bump_revision();

CREATE FUNCTION cloud_loop_trigger_sources(trigger jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE trigger->>'kind'
    WHEN 'webhook' THEN ARRAY['webhook']
    WHEN 'git_event' THEN ARRAY['github','gitlab']
    WHEN 'source_event' THEN ARRAY[trigger->>'source']
    ELSE ARRAY[]::text[] END
$$;

CREATE FUNCTION cloud_loop_from_automation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO cloud_loops(organization_id,id,automation_id) VALUES (NEW.organization_id, NEW.id, NEW.id);
  END IF;
  INSERT INTO cloud_loop_trusted_sources(organization_id,loop_id,source)
    SELECT NEW.organization_id, NEW.id, s FROM unnest(cloud_loop_trigger_sources(NEW.trigger)) AS s
    ON CONFLICT DO NOTHING;
  IF TG_OP = 'UPDATE' THEN
    UPDATE cloud_loops SET revision = revision + 1, updated_at = clock_timestamp() WHERE organization_id = NEW.organization_id AND automation_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_automations_loop_created AFTER INSERT ON cloud_automations FOR EACH ROW EXECUTE FUNCTION cloud_loop_from_automation();
CREATE TRIGGER cloud_automations_loop_changed AFTER UPDATE ON cloud_automations FOR EACH ROW WHEN (OLD.revision <> NEW.revision) EXECUTE FUNCTION cloud_loop_from_automation();

CREATE FUNCTION cloud_loop_from_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO cloud_loops(organization_id,id,schedule_id,missed) VALUES (NEW.organization_id, NEW.id, NEW.id, CASE WHEN NEW.missed = 'skip' THEN 'skip' ELSE 'latest' END);
  ELSE
    UPDATE cloud_loops SET revision = revision + 1, updated_at = clock_timestamp() WHERE organization_id = NEW.organization_id AND schedule_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_schedules_loop_created AFTER INSERT ON cloud_schedules FOR EACH ROW EXECUTE FUNCTION cloud_loop_from_schedule();
CREATE TRIGGER cloud_schedules_loop_changed AFTER UPDATE ON cloud_schedules FOR EACH ROW
  WHEN (OLD.revision <> NEW.revision OR OLD.enabled <> NEW.enabled OR OLD.archived <> NEW.archived) EXECUTE FUNCTION cloud_loop_from_schedule();

CREATE FUNCTION cloud_loop_run_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.loop_revision IS NULL THEN
    SELECT revision INTO NEW.loop_revision FROM cloud_loops WHERE organization_id = NEW.organization_id AND automation_id = NEW.automation_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_automation_runs_loop_revision BEFORE INSERT ON cloud_automation_runs FOR EACH ROW EXECUTE FUNCTION cloud_loop_run_revision();

CREATE FUNCTION cloud_loop_occurrence_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT revision INTO NEW.loop_revision FROM cloud_loops WHERE organization_id = NEW.organization_id AND schedule_id = NEW.schedule_id;
  RETURN NEW;
END $$;
CREATE TRIGGER cloud_schedule_occurrences_loop_revision BEFORE INSERT ON cloud_schedule_occurrences FOR EACH ROW EXECUTE FUNCTION cloud_loop_occurrence_revision();

INSERT INTO cloud_loops(organization_id,id,automation_id) SELECT organization_id, id, id FROM cloud_automations;
INSERT INTO cloud_loops(organization_id,id,schedule_id,missed)
  SELECT organization_id, id, id, CASE WHEN missed = 'skip' THEN 'skip' ELSE 'latest' END FROM cloud_schedules;
INSERT INTO cloud_loop_trusted_sources(organization_id,loop_id,source)
  SELECT a.organization_id, a.id, s FROM cloud_automations a CROSS JOIN unnest(cloud_loop_trigger_sources(a.trigger)) AS s;
UPDATE cloud_automation_runs r SET loop_revision = 1 FROM cloud_loops l WHERE l.organization_id = r.organization_id AND l.automation_id = r.automation_id;
UPDATE cloud_schedule_occurrences SET loop_revision = 1;
CREATE FUNCTION cloud_loop_default_sources() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cloud_loop_sources(organization_id,source,enabled)
    SELECT NEW.id, s.source, s.source IN ('webhook','github','gitlab')
    FROM unnest(ARRAY['webhook','email','github','gitlab','sentry','grafana','teams','slack']) AS s(source);
  RETURN NULL;
END $$;
CREATE TRIGGER cloud_organizations_loop_sources AFTER INSERT ON cloud_organizations FOR EACH ROW EXECUTE FUNCTION cloud_loop_default_sources();

INSERT INTO cloud_loop_sources(organization_id,source,enabled)
  SELECT o.id, s.source, s.source IN ('webhook','github','gitlab')
  FROM cloud_organizations o CROSS JOIN unnest(ARRAY['webhook','email','github','gitlab','sentry','grafana','teams','slack']) AS s(source);
