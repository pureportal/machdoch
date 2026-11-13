import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { CloudActor, CloudIssue } from "../../../lib/cloud-contract";
import type { AutomationOutcome } from "../../../lib/cloud-automation-contract";
import {
  issueChangeEvents,
  type AutomationEvent,
} from "../../../lib/automation-triggers";
import type { CloudSql } from "../database";

export const maximumAutomationDepth = 3;

export const automationScope = new AsyncLocalStorage<{
  automationId: string;
  depth: number;
}>();

async function subscribedKinds(
  sql: CloudSql,
  organizationId: string,
  teamId: string,
): Promise<Set<string>> {
  return new Set(
    (
      await sql.query<{ trigger_kind: string }>(
        "SELECT DISTINCT trigger_kind FROM cloud_automations WHERE organization_id=$1 AND team_id=$2 AND enabled",
        [organizationId, teamId],
      )
    ).rows.map((row) => row.trigger_kind),
  );
}

export async function queueAutomationEvents(
  sql: CloudSql,
  input: {
    organizationId: string;
    teamId: string;
    issueId: string;
    actorId: string | null;
    events: AutomationEvent[];
  },
  kinds?: Set<string>,
): Promise<void> {
  if (!input.events.length) return;
  const subscribed =
    kinds ?? (await subscribedKinds(sql, input.organizationId, input.teamId));
  const scope = automationScope.getStore();
  for (const event of input.events) {
    if (!subscribed.has(event.kind)) continue;
    await sql.query(
      "INSERT INTO cloud_automation_events (organization_id,id,team_id,issue_id,actor_id,event,depth,origin_automation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        input.organizationId,
        randomUUID(),
        input.teamId,
        input.issueId,
        input.actorId,
        JSON.stringify(event),
        scope?.depth ?? 0,
        scope?.automationId ?? null,
      ],
    );
  }
}

export async function queueIssueChangeEvents(
  sql: CloudSql,
  actor: CloudActor,
  issue: CloudIssue,
): Promise<void> {
  const kinds = await subscribedKinds(sql, actor.organizationId, issue.teamId);
  if (!kinds.size) return;
  const previous =
    issue.revision > 1
      ? ((
          await sql.query<{ snapshot: CloudIssue }>(
            "SELECT snapshot FROM cloud_issue_history WHERE organization_id=$1 AND issue_id=$2 AND revision<$3 ORDER BY revision DESC LIMIT 1",
            [actor.organizationId, issue.id, issue.revision],
          )
        ).rows[0]?.snapshot ?? null)
      : null;
  if (issue.revision > 1 && !previous) return;
  await queueAutomationEvents(
    sql,
    {
      organizationId: actor.organizationId,
      teamId: issue.teamId,
      issueId: issue.id,
      actorId: actor.userId,
      events: issueChangeEvents(previous, issue),
    },
    kinds,
  );
}

export async function queueFinishedEvent(
  sql: CloudSql,
  run: {
    organizationId: string;
    id: string;
    automationId: string;
    issueId: string | null;
    actorId: string | null;
    depth: number;
  },
  outcome: AutomationOutcome,
  error: string | null,
): Promise<void> {
  if (run.depth + 1 >= maximumAutomationDepth) return;
  const automation = (
    await sql.query<{ team_id: string; name: string }>(
      `SELECT a.team_id,a.name FROM cloud_automations a WHERE a.organization_id=$1 AND a.id=$2
      AND EXISTS (SELECT 1 FROM cloud_automations l WHERE l.organization_id=a.organization_id AND l.team_id=a.team_id
        AND l.enabled AND l.trigger_kind='automation_finished' AND l.id<>a.id)`,
      [run.organizationId, run.automationId],
    )
  ).rows[0];
  if (!automation) return;
  const event: AutomationEvent = {
    kind: "automation_finished",
    automationId: run.automationId,
    automationName: automation.name,
    runId: run.id,
    outcome,
    error,
  };
  await sql.query(
    "INSERT INTO cloud_automation_events (organization_id,id,team_id,issue_id,actor_id,event,depth,origin_automation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      run.organizationId,
      randomUUID(),
      automation.team_id,
      run.issueId,
      run.actorId,
      JSON.stringify(event),
      run.depth + 1,
      run.automationId,
    ],
  );
}
