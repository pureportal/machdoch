import type { CloudActor } from "../../../lib/cloud-contract";
import type {
  CloudLoopSummary,
  LoopConfig,
  LoopContextSource,
  LoopGuardrails,
  LoopKind,
  LoopSource,
} from "../../../lib/cloud-loop-contract";
import { CloudError, teamVisibility } from "../access";
import type { CloudSql } from "../database";
import {
  requireDocument,
  requireRepositories,
} from "../automation/automation-validation";
import { savedViewVisible } from "../saved-views";
import { loopContextSources } from "./loop-context";

const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const executorColumn = `jsonb_build_object('placement',l.placement,'targetId',l.target_id,'harness',l.harness,'model',l.model,
  'capabilities',COALESCE((SELECT jsonb_agg(c.capability ORDER BY c.capability) FROM cloud_loop_capabilities c
    WHERE c.organization_id=l.organization_id AND c.loop_id=l.id),'[]'::jsonb)) AS executor`;

const finishedRunStates = "('succeeded','failed','canceled','timed_out')";

const automationLoops = `SELECT l.id,'automation' AS kind,a.name,l.description,a.team_id AS "teamId",a.owner_id AS "ownerId",u.name AS "ownerName",
    a.enabled,l.killed_at IS NOT NULL AS killed,a.trigger->>'kind' AS trigger,${executorColumn},
    st.runs,st.succeeded AS "succeededRuns",st.finished AS "finishedRuns",st.cost AS "costCents",
    (SELECT ${timestamp("max(r.created_at)")} FROM cloud_automation_runs r WHERE r.organization_id=l.organization_id AND r.automation_id=a.id AND NOT r.dry_run) AS "lastRunAt",
    CASE WHEN a.enabled THEN ${timestamp("a.next_run_at")} END AS "nextRunAt",a.created_at
  FROM cloud_loops l JOIN cloud_automations a ON a.organization_id=l.organization_id AND a.id=l.automation_id
  JOIN cloud_users u ON u.id=a.owner_id
  JOIN cloud_teams t ON t.organization_id=a.organization_id AND t.id=a.team_id
  JOIN cloud_memberships m ON m.organization_id=a.organization_id AND m.user_id=$2
  CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE r.state<>'skipped')::integer AS runs,
    count(*) FILTER (WHERE r.state='succeeded')::integer AS succeeded,
    count(*) FILTER (WHERE r.state IN ('succeeded','failed'))::integer AS finished,
    COALESCE(sum(r.cost_cents),0)::integer AS cost
    FROM cloud_automation_runs r WHERE r.organization_id=l.organization_id AND r.automation_id=a.id AND NOT r.dry_run
    AND r.created_at>clock_timestamp()-interval '30 days') st
  WHERE l.organization_id=$1 AND ${teamVisibility}`;

const scheduleLoops = `SELECT l.id,'schedule' AS kind,s.name,l.description,s.team_id AS "teamId",s.owner_id AS "ownerId",u.name AS "ownerName",
    s.enabled,l.killed_at IS NOT NULL AS killed,'schedule' AS trigger,${executorColumn},
    st.runs,st.succeeded AS "succeededRuns",st.finished AS "finishedRuns",0 AS "costCents",
    (SELECT ${timestamp("to_timestamp(max(o.nominal_at)/1000.0)")} FROM cloud_schedule_occurrences o
      WHERE o.organization_id=l.organization_id AND o.schedule_id=s.id AND o.outcome IN ('created','admitted')) AS "lastRunAt",
    CASE WHEN s.enabled AND s.next_at IS NOT NULL THEN ${timestamp("to_timestamp(s.next_at/1000.0)")} END AS "nextRunAt",s.created_at
  FROM cloud_loops l JOIN cloud_schedules s ON s.organization_id=l.organization_id AND s.id=l.schedule_id
  JOIN cloud_users u ON u.id=s.owner_id
  JOIN cloud_teams t ON t.organization_id=s.organization_id AND t.id=s.team_id
  JOIN cloud_memberships m ON m.organization_id=s.organization_id AND m.user_id=$2
  CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE o.outcome IN ('created','admitted'))::integer AS runs,
    count(*) FILTER (WHERE o.outcome='created' OR (o.outcome='admitted' AND cr.state='succeeded'))::integer AS succeeded,
    count(*) FILTER (WHERE o.outcome='created' OR (o.outcome='admitted' AND cr.state IN ${finishedRunStates}))::integer AS finished
    FROM cloud_schedule_occurrences o LEFT JOIN cloud_runs cr ON cr.organization_id=o.organization_id AND cr.id=o.run_id
    WHERE o.organization_id=l.organization_id AND o.schedule_id=s.id
    AND o.nominal_at>(extract(epoch FROM clock_timestamp()-interval '30 days')*1000)) st
  WHERE l.organization_id=$1 AND NOT s.archived AND ${teamVisibility}`;

const summaryColumns = `id,kind,name,description,"teamId","ownerId","ownerName",enabled,killed,trigger,executor,
  runs,"succeededRuns","finishedRuns","costCents","lastRunAt","nextRunAt"`;

export async function readLoopSummaries(
  sql: CloudSql,
  actor: CloudActor,
  id: string | null,
): Promise<CloudLoopSummary[]> {
  return (
    await sql.query<CloudLoopSummary & Record<string, unknown>>(
      `SELECT ${summaryColumns} FROM (${automationLoops} UNION ALL ${scheduleLoops}) loops
      WHERE $3::uuid IS NULL OR id=$3 ORDER BY created_at DESC,id LIMIT 1000`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows;
}

export interface LoopIdentity {
  id: string;
  kind: LoopKind;
  teamId: string;
  ownerId: string;
  revision: number;
  consecutiveFailures: number;
}

export async function readLoopIdentity(
  sql: CloudSql,
  actor: CloudActor,
  id: string,
  write = false,
): Promise<LoopIdentity> {
  const loop = (
    await sql.query<LoopIdentity & Record<string, unknown>>(
      `SELECT l.id,CASE WHEN l.automation_id IS NULL THEN 'schedule' ELSE 'automation' END AS kind,
        COALESCE(a.team_id,s.team_id) AS "teamId",COALESCE(a.owner_id,s.owner_id) AS "ownerId",l.revision,
        l.consecutive_failures AS "consecutiveFailures"
      FROM cloud_loops l LEFT JOIN cloud_automations a ON a.organization_id=l.organization_id AND a.id=l.automation_id
      LEFT JOIN cloud_schedules s ON s.organization_id=l.organization_id AND s.id=l.schedule_id
      JOIN cloud_teams t ON t.organization_id=l.organization_id AND t.id=COALESCE(a.team_id,s.team_id)
      JOIN cloud_memberships m ON m.organization_id=l.organization_id AND m.user_id=$2
      WHERE l.organization_id=$1 AND l.id=$3 AND ${teamVisibility} AND (s.id IS NULL OR NOT s.archived)
      FOR ${write ? "UPDATE" : "SHARE"} OF l`,
      [actor.organizationId, actor.userId, id],
    )
  ).rows[0];
  if (!loop) throw new CloudError(404, "not_found", "Loop is unavailable.");
  return loop;
}

export function requireLoopOwner(loop: LoopIdentity, actor: CloudActor): void {
  if (loop.ownerId !== actor.userId || actor.delegation)
    throw new CloudError(
      403,
      "loop_owner_required",
      "Only the automation owner can change it in the browser.",
    );
}

export async function readLoopConfig(
  sql: CloudSql,
  organizationId: string,
  id: string,
): Promise<LoopConfig> {
  const row = (
    await sql.query<{
      description: string;
      executor: LoopConfig["executor"];
      guardrails: LoopGuardrails;
      trustedSources: LoopSource[];
    }>(
      `SELECT l.description,${executorColumn},
        jsonb_build_object('runBudgetCents',l.run_budget_cents,'monthBudgetCents',l.month_budget_cents,'maxDurationMinutes',l.max_duration_minutes,
          'overlap',l.overlap,'missed',l.missed,'approvalRequired',l.approval_required,'pauseAfterFailures',l.pause_after_failures) AS guardrails,
        ARRAY(SELECT ts.source FROM cloud_loop_trusted_sources ts WHERE ts.organization_id=l.organization_id AND ts.loop_id=l.id ORDER BY ts.source) AS "trustedSources"
      FROM cloud_loops l WHERE l.organization_id=$1 AND l.id=$2`,
      [organizationId, id],
    )
  ).rows[0]!;
  return {
    ...row,
    contextSources: await loopContextSources(sql, organizationId, id),
  };
}

async function requireContextSource(
  sql: CloudSql,
  actor: CloudActor,
  teamId: string,
  source: LoopContextSource,
): Promise<void> {
  switch (source.kind) {
    case "saved_view": {
      const found = await sql.query(
        `SELECT 1 FROM cloud_saved_views v WHERE v.organization_id=$1 AND v.id=$3 AND ${savedViewVisible("v", "$2")}`,
        [actor.organizationId, actor.userId, source.savedViewId],
      );
      if (!found.rows.length)
        throw new CloudError(
          422,
          "saved_view_unavailable",
          "Choose a saved view you can see.",
        );
      return;
    }
    case "team_projects": {
      const found = await sql.query(
        `SELECT 1 FROM cloud_teams t JOIN cloud_memberships m ON m.organization_id=t.organization_id AND m.user_id=$2
        WHERE t.organization_id=$1 AND t.id=$3 AND ${teamVisibility}`,
        [actor.organizationId, actor.userId, source.teamId],
      );
      if (!found.rows.length)
        throw new CloudError(
          422,
          "team_unavailable",
          "Choose a team you can see.",
        );
      return;
    }
    case "document":
      return requireDocument(sql, actor, teamId, source.documentId);
    case "repository":
      return requireRepositories(sql, actor, [source.repositoryId]);
    case "filter":
    case "trigger_payload":
    case "previous_runs":
      return;
  }
}

function contextSourceRow(source: LoopContextSource) {
  return {
    savedViewId: source.kind === "saved_view" ? source.savedViewId : null,
    filter: source.kind === "filter" ? JSON.stringify(source.conditions) : null,
    teamId: source.kind === "team_projects" ? source.teamId : null,
    documentId: source.kind === "document" ? source.documentId : null,
    repositoryId: source.kind === "repository" ? source.repositoryId : null,
    runCount: source.kind === "previous_runs" ? source.runCount : null,
  };
}

export async function writeLoopConfig(
  sql: CloudSql,
  actor: CloudActor,
  loop: Pick<LoopIdentity, "id" | "teamId">,
  config: LoopConfig,
): Promise<void> {
  for (const source of config.contextSources)
    await requireContextSource(sql, actor, loop.teamId, source);
  const parameters = [actor.organizationId, loop.id];
  await sql.query(
    "DELETE FROM cloud_loop_capabilities WHERE organization_id=$1 AND loop_id=$2",
    parameters,
  );
  await sql.query(
    `INSERT INTO cloud_loop_capabilities (organization_id,loop_id,capability)
    SELECT $1,$2,capability FROM unnest($3::text[]) AS capability`,
    [...parameters, [...new Set(config.executor.capabilities)]],
  );
  await sql.query(
    "DELETE FROM cloud_loop_trusted_sources WHERE organization_id=$1 AND loop_id=$2",
    parameters,
  );
  await sql.query(
    `INSERT INTO cloud_loop_trusted_sources (organization_id,loop_id,source)
    SELECT $1,$2,source FROM unnest($3::text[]) AS source`,
    [...parameters, [...new Set(config.trustedSources)]],
  );
  await sql.query(
    "DELETE FROM cloud_loop_context_sources WHERE organization_id=$1 AND loop_id=$2",
    parameters,
  );
  for (const [index, source] of config.contextSources.entries()) {
    const row = contextSourceRow(source);
    await sql.query(
      `INSERT INTO cloud_loop_context_sources (organization_id,loop_id,position,kind,saved_view_id,filter,team_id,document_id,repository_id,run_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ...parameters,
        index + 1,
        source.kind,
        row.savedViewId,
        row.filter,
        row.teamId,
        row.documentId,
        row.repositoryId,
        row.runCount,
      ],
    );
  }
  const { executor, guardrails } = config;
  await sql.query(
    `UPDATE cloud_loops SET description=$3,placement=$4,target_id=$5,harness=$6,model=$7,run_budget_cents=$8,month_budget_cents=$9,
      max_duration_minutes=$10,overlap=$11,missed=$12,approval_required=$13,pause_after_failures=$14,revision=revision+1,updated_at=clock_timestamp()
    WHERE organization_id=$1 AND id=$2`,
    [
      ...parameters,
      config.description,
      executor.placement,
      executor.targetId,
      executor.harness,
      executor.model,
      guardrails.runBudgetCents,
      guardrails.monthBudgetCents,
      guardrails.maxDurationMinutes,
      guardrails.overlap,
      guardrails.missed,
      guardrails.approvalRequired,
      guardrails.pauseAfterFailures,
    ],
  );
}
