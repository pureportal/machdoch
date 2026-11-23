CREATE TABLE cloud_sla_policies (
  organization_id uuid NOT NULL,
  id uuid NOT NULL,
  team_id uuid NOT NULL,
  priority text CHECK (priority IN ('urgent','high','normal','low')),
  label_id uuid,
  hours integer NOT NULL CHECK (hours BETWEEN 1 AND 8760),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  CHECK (num_nonnulls(priority,label_id) > 0),
  FOREIGN KEY (organization_id,team_id) REFERENCES cloud_teams(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,team_id,label_id) REFERENCES cloud_labels(organization_id,team_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cloud_sla_policies_scope ON cloud_sla_policies (organization_id,team_id,COALESCE(priority,''),COALESCE(label_id,'00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE cloud_issue_sla_breaches (
  organization_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  breached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,issue_id,due_at),
  FOREIGN KEY (organization_id,issue_id) REFERENCES cloud_issues(organization_id,id) ON DELETE CASCADE
);

CREATE FUNCTION cloud_issue_sla_due(org uuid, issue uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT i.created_at + min(p.hours) * interval '1 hour'
  FROM cloud_issues i
  JOIN cloud_sla_policies p ON p.organization_id=i.organization_id AND p.team_id=i.team_id
    AND (p.priority IS NULL OR p.priority=i.priority)
    AND (p.label_id IS NULL OR EXISTS (SELECT 1 FROM cloud_issue_labels l WHERE l.organization_id=i.organization_id AND l.issue_id=i.id AND l.label_id=p.label_id))
  WHERE i.organization_id=org AND i.id=issue AND NOT i.archived AND i.state NOT IN ('complete','canceled')
  GROUP BY i.created_at
$$;

ALTER TABLE cloud_notifications DROP CONSTRAINT cloud_notifications_kind_check;
ALTER TABLE cloud_notifications ADD CONSTRAINT cloud_notifications_kind_check CHECK (kind IN ('assigned','commented','mentioned','task_finished','status_changed','pull_request','loop_input','loop_approval','loop_message','sla_breached'));
